'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {indexRepository,resolveTrace,readSource,getPageReaderScript,getPickerScript} = require('../engine/index.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-atlas-engine-'));
  t.after(async () => {const resolved = path.resolve(root); assert.ok(path.basename(resolved).startsWith('trace-atlas-engine-')); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); await fs.rm(resolved,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','Product.tsx'), 'export function Product() {\n  return <span>{price.value}</span>;\n}\n');
  await fs.writeFile(path.join(root,'server.cjs'), 'function handler(req, res) {\n  return readProducts();\n}\n');
  await fs.writeFile(path.join(root,'queries.cjs'), 'function readProducts() {\n  return db.prepare("SELECT price FROM products").all();\n}\n');
  await fs.writeFile(path.join(root,'projection.py'), 'def response(record):\n    return ProductResponse(price=record.price)\n');
  await fs.writeFile(path.join(root,'calculation.py'), 'def response(record):\n    return ProductResponse(total=record.price * record.quantity)\n');
  const index = await indexRepository(root), site = (name,line=2) => ({path:name,line,hash:index.files.find(file=>file.path===name).hash,name:path.basename(name)});
  const url='http://localhost:7410/products';
  const trace={version:1,url,mode:'data',source:{...site('src/Product.tsx'),kind:'text',expression:'price.value'},dependencies:[{field:'products.0.price',request:{id:'request_12345',method:'GET',url:'http://localhost:7410/api/products?token=secret',status:200},backend:{id:'request_12345',route:site('server.cjs'),queries:[{id:'query_12345',sql:"SELECT price FROM products WHERE id = 42 AND category = 'private'",tables:['products'],site:site('queries.cjs'),frames:[site('server.cjs'),site('queries.cjs')]}],fields:{'products.0.price':{table:'products',column:'price',model:null,queries:['query_12345']}}}}]};
  const resolve = (overrides={}) => resolveTrace({index,url,trace,frames:[],target:{selector:'#price',label:'Price',tag:'span'},runtimeAvailable:true,...overrides});
  return {root,index,trace,url,resolve,site};
}

test('complete graph requires explicit direct field lineage and fresh source sites', async t => {
  const {resolve} = await fixture(t), graph=resolve();
  assert.equal(graph.coverage,'complete');
  assert.equal(graph.captured,true);
  assert.deepEqual(graph.summary,{requests:1,queries:1,tables:1});
  assert.equal(graph.nodes.find(node=>node.kind==='database').label,'products.price');
  assert.equal(graph.nodes.find(node=>node.kind==='api').meta.responseField,'products.0.price');
  assert.ok(graph.files.includes('src/Product.tsx'));
  assert.ok(graph.files.includes('server.cjs'));
  assert.ok(graph.files.includes('queries.cjs'));
  const serialized=JSON.stringify(graph);
  assert.ok(!serialized.includes('token=secret'));
  assert.ok(!serialized.includes("'private'"));
  assert.ok(!graph.nodes.find(node=>node.kind==='query').code.includes('42'));
});

test('an explicit frontend dependency limit cannot retain complete coverage',async t=>{
 const {trace,resolve}=await fixture(t);trace.dependencies[0].truncated=true;
 const graph=resolve();assert.equal(graph.coverage,'partial');assert.ok(graph.gaps.some(gap=>gap.includes('more dependencies')));
});

test('observed frontend collection calculations keep SQL context without inventing a count column',async t=>{
 const {trace,resolve}=await fixture(t),dependency=trace.dependencies[0];dependency.collection=true;dependency.operations=['append','map','length'];
 const graph=resolve();assert.equal(graph.coverage,'partial');assert.equal(graph.summary.queries,1);
 const calculation=graph.nodes.find(node=>node.meta?.sourceRole==='frontend-collection');assert.deepEqual(calculation.meta.operations,['append','map','length']);assert.match(calculation.detail,/cardinality is not asserted/);
 assert.equal(graph.nodes.some(node=>node.kind==='database'),false);assert.ok(graph.gaps.some(gap=>gap.includes('Query-to-collection')));
 dependency.operations=['invented_operation'];assert.deepEqual(resolve().nodes.find(node=>node.meta?.sourceRole==='frontend-collection').meta.operations,[]);
});

test('verified response collection membership closes a count path without a database column claim',async t=>{
 const {trace,resolve,site}=await fixture(t),dependency=trace.dependencies[0];dependency.collection=true;dependency.field='products';dependency.operations=['append','map','length'];
 dependency.backend.collections={products:{queries:['query_12345'],count:0,source:site('queries.cjs')}};
 const graph=resolve();assert.equal(graph.coverage,'complete');assert.equal(graph.valueOrigin,'collection');assert.equal(graph.summary.tables,1);assert.equal(graph.nodes.some(node=>node.kind==='database'),false);
 const collection=graph.nodes.find(node=>node.meta?.sourceRole==='response-collection');assert.equal(collection.meta.count,0);assert.equal(collection.file,'queries.cjs');assert.ok(graph.edges.some(edge=>edge.to===collection.id&&edge.label==='produces response collection'));
 assert.equal(graph.nodes.find(node=>node.meta?.sourceRole==='frontend-collection').meta.membershipVerified,true);
 dependency.role='control';const controlled=resolve();assert.equal(controlled.coverage,'complete');assert.equal(controlled.valueOrigin,'collection');assert.ok(controlled.edges.some(edge=>edge.label==='checks collection condition'));assert.equal(controlled.nodes.find(node=>node.meta?.sourceRole==='frontend-collection').meta.dependencyRole,'control');dependency.role='value';
 const original=structuredClone(dependency.backend.collections.products);
 for(const changed of [{queries:['unrelated_query']},{count:-1},{count:1.5},{count:'0'},{source:{...original.source,hash:'0'.repeat(64)}}]){dependency.backend.collections.products={...original,...changed};assert.equal(resolve().coverage,'partial');assert.equal(resolve().valueOrigin,undefined);}
 dependency.backend.collections.products=original;dependency.backend.queries[0].failed=true;assert.equal(resolve().coverage,'partial');
 dependency.backend.queries[0].failed=false;dependency.operations=[];assert.equal(resolve().coverage,'partial');
 dependency.operations=['filter','length'];dependency.collectionUnknown=true;const unknown=resolve();assert.equal(unknown.coverage,'partial');assert.equal(unknown.valueOrigin,undefined);assert.ok(unknown.nodes.some(node=>node.meta?.sourceRole==='response-collection'));assert.equal(unknown.nodes.find(node=>node.meta?.sourceRole==='frontend-collection').meta.unknownControls,true);
});

test('an observed literal fallback stays frontend value evidence while retaining its actual database control context',async t=>{
 const {trace,resolve,root}=await fixture(t);await fs.writeFile(path.join(root,'fallback.jsx'),'export const label = input.label ?? "Local fallback";\n');
 const index=await indexRepository(root),file=index.files.find(file=>file.path==='fallback.jsx');
 trace.localValues=[{source:{path:file.path,line:1,hash:file.hash,kind:'literal-fallback'},role:'value'}];trace.valueOrigin='local';trace.dependencies[0].role='control';
 const graph=resolve({index});assert.equal(graph.coverage,'frontend');assert.equal(graph.valueOrigin,'local');assert.equal(graph.summary.queries,1);assert.equal(graph.contextCoverage,'complete');
 const fallback=graph.nodes.find(node=>node.meta?.localValue);assert.equal(fallback.label,'Local literal fallback');assert.equal(fallback.file,'fallback.jsx');
 const column=graph.nodes.find(node=>node.kind==='database');assert.equal(column.meta.dependencyRole,'control');assert.match(column.detail,/does not claim/);
 const view=require('../renderer/trace-view.js').model(graph,{scope:'field'});assert.ok(view.nodes.some(node=>node.id===fallback.id));
 trace.dependencies[0].role='value';assert.notEqual(resolve({index}).valueOrigin,'local');
 trace.dependencies[0].role='control';trace.localValues[0].source.hash='0'.repeat(64);assert.notEqual(resolve({index}).valueOrigin,'local');
 trace.localValues=[];assert.notEqual(resolve({index}).valueOrigin,'local');
 trace.localValues=[{source:{path:file.path,line:1,hash:file.hash,kind:'literal-fallback'},role:'value'}];trace.mode='local';const invalid=resolve({index});assert.equal(invalid.coverage,'unavailable');assert.equal(invalid.valueOrigin,undefined);assert.equal(invalid.nodes.some(node=>node.meta?.localValue),false);
});

test('observed ISO formatting keeps its real ORM dependency and names the transformation',async t=>{
 const {trace,resolve,site}=await fixture(t),origin=trace.dependencies[0].backend.fields['products.0.price'];
 origin.transformation='isoformat';origin.projection=site('projection.py');
 const graph=resolve();assert.equal(graph.coverage,'complete');
 const formatting=graph.nodes.find(node=>node.meta?.transformation==='isoformat');assert.equal(formatting.label,'Python response formatting');assert.match(formatting.detail,/formatted dependency/);
 assert.ok(graph.edges.some(edge=>edge.label==='formatted from'));assert.ok(graph.nodes.some(node=>node.kind==='database'&&node.label==='products.price'));
 origin.transformation='enum-value';const enumGraph=resolve();assert.equal(enumGraph.coverage,'complete');assert.match(enumGraph.nodes.find(node=>node.meta?.transformation==='enum-value').detail,/converted the loaded ORM Enum/);
 origin.transformation='arbitrary_method';assert.equal(resolve().nodes.some(node=>node.kind==='database'),false);
 origin.transformation='isoformat';delete origin.projection;assert.equal(resolve().nodes.some(node=>node.kind==='database'),false);
 origin.transformation='enum-value';assert.equal(resolve().nodes.some(node=>node.kind==='database'),false);
});

test('repeated SQL executions share a map step without losing execution IDs or field lineage', async t => {
  const {resolve,trace,site}=await fixture(t), dependency=trace.dependencies[0];
  const template=dependency.backend.queries[0];
  const ids=Array.from({length:8},(_,i)=>`query_repeat_${i}`);
  dependency.backend.queries=ids.map(id=>({...structuredClone(template),id,frames:[site('server.cjs'),site('projection.py',1),site('queries.cjs')]}));
  // Both IDs refer to real executions; neither is the representative first ID.
  dependency.backend.fields['products.0.price'].queries=[ids[3],ids[7]];
  const graph=resolve(),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');
  assert.deepEqual(graph.summary,{requests:1,queries:8,tables:1});
  assert.equal(queries.length,1);
  const query=queries[0];
  assert.equal(query.meta.executionCount,8);
  assert.equal(query.meta.queryId,ids[0]);
  assert.deepEqual(query.meta.queryIds,ids);
  assert.equal(query.meta.requestId,dependency.request.id);
  const calls=graph.nodes.filter(node=>node.meta?.sourceRole==='backend-call');
  assert.equal(calls.length,1);
  // A repeated query stack proves participation in eight queries, not eight calls.
  assert.equal(calls[0].meta.queryCount,8);
  assert.equal(calls[0].meta.executionCount,undefined);
  assert.deepEqual(calls[0].meta.queryIds,ids);
  assert.equal(calls[0].meta.requestId,dependency.request.id);
  const database=graph.nodes.find(node=>node.kind==='database');
  assert.equal(graph.edges.filter(edge=>edge.from===query.id&&edge.to===database.id).length,1);
  assert.equal(new Set(graph.edges.map(edge=>JSON.stringify([edge.from,edge.to,edge.label]))).size,graph.edges.length);
});

test('SQL groups preserve different statement, source site, failure and table evidence', async t => {
  const {resolve,trace,site}=await fixture(t), dependency=trace.dependencies[0];
  const template={...dependency.backend.queries[0],frames:[site('server.cjs'),site('projection.py',1)]};
  dependency.backend.queries=[
    {...structuredClone(template),id:'query_group_base'},
    // Literal values are already redacted by validation, so these share a group.
    {...structuredClone(template),id:'query_group_repeat',sql:template.sql.replace('42','99')},
    {...structuredClone(template),id:'query_group_statement',sql:'SELECT id FROM products'},
    {...structuredClone(template),id:'query_group_site',site:site('queries.cjs',1)},
    {...structuredClone(template),id:'query_group_failed',failed:true},
    {...structuredClone(template),id:'query_group_tables',tables:['archived_products']}
  ];
  dependency.backend.fields['products.0.price'].queries=['query_group_repeat'];
  const graph=resolve(),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');
  assert.equal(graph.summary.queries,6);
  assert.equal(queries.length,5);
  const repeated=queries.find(node=>node.meta.queryId==='query_group_base');
  assert.equal(repeated.meta.executionCount,2);
  assert.deepEqual(repeated.meta.queryIds,['query_group_base','query_group_repeat']);
  for(const id of ['query_group_statement','query_group_site','query_group_failed','query_group_tables']){
    const query=queries.find(node=>node.meta.queryId===id);
    assert.ok(query,`${id} must retain its own map step`);
    assert.equal(query.meta.executionCount,1);
    assert.deepEqual(query.meta.queryIds,[id]);
  }
  assert.equal(queries.find(node=>node.meta.queryId==='query_group_failed').meta.failed,true);
  assert.ok(graph.edges.some(edge=>edge.from===repeated.id&&edge.to===graph.nodes.find(node=>node.kind==='database').id));
});

test('shared source and query steps retain their full parent call path and frame name', async t => {
  const {resolve,trace,site}=await fixture(t), dependency=trace.dependencies[0],template=dependency.backend.queries[0];
  const parent=site('projection.py',1),common=site('queries.cjs',1);
  const query=(id,frame)=>({...structuredClone(template),id,frames:[site('server.cjs'),frame,common,site('queries.cjs')]});
  dependency.backend.queries=[
    query('query_path_first',parent),query('query_path_repeat',parent),
    query('query_path_other_line',site('projection.py',2)),
    query('query_path_other_name',{...parent,name:'another_caller'})
  ];
  dependency.backend.fields['products.0.price'].queries=['query_path_repeat'];
  const graph=resolve(),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');
  assert.equal(graph.summary.queries,4);
  assert.equal(queries.length,3);
  const calls=graph.nodes.filter(node=>node.meta?.sourceRole==='backend-call');
  assert.equal(calls.length,6,'the common child frame belongs separately to each parent call path');
  assert.deepEqual(calls.map(node=>node.meta.queryCount).sort(),[1,1,1,1,2,2]);
  assert.deepEqual(queries.find(node=>node.meta.queryId==='query_path_first').meta.queryIds,['query_path_first','query_path_repeat']);
  for(const query of queries){
    const incoming=graph.edges.filter(edge=>edge.to===query.id);
    assert.equal(incoming.length,1);
    assert.ok(calls.some(node=>node.id===incoming[0].from));
  }
});

test('identical executions and call sites from different requests never share map steps', async t => {
  const {resolve,trace,site}=await fixture(t), first=trace.dependencies[0],template=first.backend.queries[0];
  first.backend.queries=['query_request_one','query_request_two'].map(id=>({...structuredClone(template),id,frames:[site('server.cjs'),site('projection.py',1),site('queries.cjs')]}));
  first.backend.fields['products.0.price'].queries=['query_request_two'];
  const second=structuredClone(first);
  second.request.id='request_second';second.backend.id=second.request.id;
  trace.dependencies.push(second);
  const graph=resolve(),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');
  assert.deepEqual(graph.summary,{requests:2,queries:4,tables:1});
  assert.equal(queries.length,2);
  assert.deepEqual(queries.map(node=>node.meta.requestId),[first.request.id,second.request.id]);
  for(const query of queries){
    assert.equal(query.meta.executionCount,2);
    assert.deepEqual(query.meta.queryIds,['query_request_one','query_request_two']);
    const database=graph.edges.filter(edge=>edge.from===query.id).map(edge=>graph.nodes.find(node=>node.id===edge.to)).filter(node=>node.kind==='database');
    assert.equal(database.length,1);
  }
  const calls=graph.nodes.filter(node=>node.meta?.sourceRole==='backend-call');
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(node=>node.meta.requestId),[first.request.id,second.request.id]);
  assert.ok(calls.every(node=>node.meta.queryCount===2));
});

test('unverified SQL sites remain individual executions and cannot gain field lineage by grouping', async t => {
  const {resolve,trace,site}=await fixture(t),dependency=trace.dependencies[0],template=dependency.backend.queries[0];
  dependency.backend.queries=['query_stale_one','query_stale_two'].map(id=>({...structuredClone(template),id,site:{...site('queries.cjs'),hash:'0'.repeat(64)},frames:[site('server.cjs'),site('projection.py',1)]}));
  dependency.backend.fields['products.0.price'].queries=['query_stale_two'];
  const graph=resolve(),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'partial');
  assert.equal(graph.summary.queries,2);
  assert.equal(queries.length,2);
  assert.equal(graph.nodes.some(node=>node.kind==='database'),false);
  for(const query of queries){
    assert.equal(query.meta.executionCount,1);
    assert.deepEqual(query.meta.queryIds,[query.meta.queryId]);
    assert.equal(query.file,undefined);
  }
});

test('executed queries and tables never imply a displayed database column', async t => {
  const {resolve,trace} = await fixture(t);
  delete trace.dependencies[0].backend.fields;
  const graph=resolve();
  assert.equal(graph.coverage,'partial');
  assert.equal(graph.nodes.filter(node=>node.kind==='query').length,1);
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
  assert.equal(graph.summary.tables,0);
  assert.ok(graph.gaps.some(message=>/not proven|not captured/.test(message)));
});

test('Python DTO projection adds its verified source and rejects edits made after the response', async t => {
  const {resolve,trace,site,root}=await fixture(t);
  trace.dependencies[0].backend.fields['products.0.price'].projection=site('projection.py');
  const graph=resolve();
  assert.equal(graph.coverage,'complete');
  const mapping=graph.nodes.find(node=>node.label==='Python response mapping');
  assert.equal(mapping.file,'projection.py');assert.equal(mapping.line,2);
  assert.ok(graph.edges.some(edge=>edge.to===mapping.id));
  const database=graph.nodes.find(node=>node.kind==='database');
  assert.ok(graph.edges.some(edge=>edge.from===mapping.id&&edge.to===database.id));
  await fs.appendFile(path.join(root,'projection.py'),'# Changed DTO mapping after the request\n');
  const stale=resolve();assert.equal(stale.coverage,'partial');
  assert.equal(stale.nodes.some(node=>node.kind==='database'),false);
  assert.ok(stale.nodes.some(node=>node.kind==='backend'));
  assert.ok(stale.gaps.some(message=>/response mapping source changed/.test(message)));
});

async function modelFixture(t){
  const value=await fixture(t);
  await fs.writeFile(path.join(value.root,'models.py'),'class Product(Base):\n    __tablename__ = "products"\n    price = mapped_column("unit_price", Numeric, nullable=False)\n    quantity = mapped_column(Integer)\n');
  await fs.writeFile(path.join(value.root,'base.py'),'class PriceMixin:\n    price = mapped_column("unit_price", Numeric, nullable=False)\n');
  Object.assign(value.index,await indexRepository(value.root));
  const origin=value.trace.dependencies[0].backend.fields['products.0.price'];
  Object.assign(origin,{column:'unit_price',model:'Product',attribute:'price',modelSource:value.site('models.py',1),fieldSource:value.site('models.py',3),type:'Numeric',nullable:false});
  return {...value,origin};
}

test('verified ORM declarations add a model attribute block between mapping and its actual column',async t=>{
  const {origin,resolve,site}=await modelFixture(t);origin.projection=site('projection.py');
  const graph=resolve(),model=graph.nodes.find(node=>node.kind==='model'),mapping=graph.nodes.find(node=>node.meta?.sourceRole==='response-mapping'),database=graph.nodes.find(node=>node.kind==='database');
  assert.equal(graph.coverage,'complete');assert.equal(graph.summary.queries,1);
  assert.equal(model.label,'Product.price');assert.equal(model.file,'models.py');assert.equal(model.line,3);
  assert.equal(model.meta.sourceHash,site('models.py').hash);assert.equal(model.meta.sourceRole,'model-definition');
  assert.equal(model.meta.definitionOnly,true);assert.match(model.detail,/definition, not an executed function/);
  assert.equal(model.meta.attribute,'price');assert.equal(model.meta.column,'unit_price');assert.equal(model.meta.table,'products');
  assert.equal(model.meta.type,'Numeric');assert.equal(model.meta.nullable,false);
  assert.ok(model.code.includes('mapped_column'));assert.ok(graph.files.includes('models.py'));
  assert.equal(database.label,'products.unit_price');assert.equal(database.meta.modelDefinitionStatus,'verified');
  assert.ok(graph.nodes.indexOf(model)<graph.nodes.indexOf(database),'Follow path visits the model before its database column');
  assert.ok(graph.edges.some(edge=>edge.from===mapping.id&&edge.to===model.id&&edge.label==='mapped by'));
  assert.ok(graph.edges.some(edge=>edge.from===model.id&&edge.to===database.id&&edge.label==='maps to column'));
  assert.equal(graph.edges.some(edge=>edge.from===model.id&&edge.label==='executes'),false);
});

test('model declarations without DTO mappings use a load edge and can fall back to the class definition',async t=>{
  const {origin,resolve,site}=await modelFixture(t);
  delete origin.fieldSource;
  const graph=resolve(),model=graph.nodes.find(node=>node.kind==='model'),query=graph.nodes.find(node=>node.kind==='query');
  assert.equal(model.line,1);assert.deepEqual(model.meta.modelSource,site('models.py',1));
  assert.equal(model.meta.fieldSource,undefined);
  assert.ok(graph.edges.some(edge=>edge.from===query.id&&edge.to===model.id&&edge.label==='loads model field'));
  assert.equal(graph.coverage,'complete');
});

test('inherited ORM field source is verified separately and stale field bytes fall back to the current class',async t=>{
  const {origin,resolve,site,root}=await modelFixture(t);
  origin.fieldSource=site('base.py');
  let graph=resolve(),model=graph.nodes.find(node=>node.kind==='model');
  assert.equal(model.file,'base.py');assert.equal(model.line,2);
  assert.ok(graph.files.includes('base.py'));assert.ok(graph.files.includes('models.py'));
  await fs.appendFile(path.join(root,'base.py'),'# Changed inherited declaration\n');
  graph=resolve();model=graph.nodes.find(node=>node.kind==='model');
  assert.equal(model.file,'models.py');assert.equal(model.line,1);assert.equal(model.meta.fieldSource,undefined);
  assert.equal(graph.coverage,'complete');assert.equal(graph.nodes.filter(node=>node.kind==='database').length,1);
});

test('missing, invalid, escaped or stale model source never fabricates declarations or erases proven field lineage',async t=>{
  const {origin,resolve,site,root}=await modelFixture(t);
  const initial=structuredClone(origin);
  for(const source of [undefined,{...site('models.py',1),hash:'0'.repeat(64)},{...site('models.py',1),line:999},{...site('models.py',1),path:'../models.py'}]){
    if(source)origin.modelSource=source;else delete origin.modelSource;
    const graph=resolve();assert.equal(graph.coverage,'complete');assert.equal(graph.nodes.some(node=>node.kind==='model'),false);
    assert.equal(graph.nodes.find(node=>node.kind==='database').label,'products.unit_price');
    assert.equal(graph.nodes.find(node=>node.kind==='database').meta.modelDefinitionStatus,source?'unavailable':'not-captured');
  }
  Object.assign(origin,initial);
  await fs.appendFile(path.join(root,'models.py'),'# Changed declaration after capture\n');
  const stale=resolve();assert.equal(stale.nodes.some(node=>node.kind==='model'),false);assert.equal(stale.coverage,'complete');
  assert.equal(stale.nodes.find(node=>node.kind==='database').meta.modelDefinitionStatus,'unavailable');
  assert.equal(stale.files.includes('models.py'),false);
});

test('computed ORM inputs keep separate model attribute definitions and reject stale declarations from disk',async t=>{
  const {origin,resolve,site,root,trace}=await modelFixture(t),dependency=trace.dependencies[0];
  const price={kind:'column',...origin},quantity={...price,attribute:'quantity',column:'quantity',fieldSource:site('models.py',4),type:'Integer'};
  dependency.backend.fields[dependency.field]={kind:'computed',immutable:true,queries:['query_12345'],projection:site('calculation.py'),operation:{op:'multiply',left:price,right:quantity}};
  let graph=resolve(),mapping=graph.nodes.find(node=>node.meta?.computed),models=graph.nodes.filter(node=>node.kind==='model');
  assert.equal(graph.coverage,'complete');assert.equal(models.length,2);assert.deepEqual(models.map(node=>node.label),['Product.price','Product.quantity']);
  assert.deepEqual(models.map(node=>node.line),[3,4]);
  for(const model of models){
    assert.ok(graph.edges.some(edge=>edge.from===mapping.id&&edge.to===model.id&&edge.label==='calculation input'));
    const targets=graph.edges.filter(edge=>edge.from===model.id).map(edge=>graph.nodes.find(node=>node.id===edge.to));
    assert.equal(targets.length,1);assert.equal(targets[0].meta.column,model.meta.column);
  }
  await fs.appendFile(path.join(root,'models.py'),'# Edited after indexing\n');
  graph=resolve();assert.equal(graph.coverage,'complete');assert.equal(graph.nodes.some(node=>node.kind==='model'),false);
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,2);
  assert.ok(graph.nodes.filter(node=>node.kind==='database').every(node=>node.meta.modelDefinitionStatus==='unavailable'));
});

test('model metadata cannot establish lineage without a successful captured query',async t=>{
  const {trace,resolve}=await modelFixture(t);
  trace.dependencies[0].backend.queries[0].failed=true;
  const graph=resolve();assert.equal(graph.coverage,'partial');assert.equal(graph.nodes.some(node=>['model','database'].includes(node.kind)),false);
});

test('query-loaded ORM classes expose their definition without claiming serializer field lineage',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];
  delete dependency.backend.fields;
  dependency.backend.queries[0].models=[{model:'Product',modelSource:site('models.py',1),table:'products'}];
  const graph=resolve(),model=graph.nodes.find(node=>node.kind==='model'),query=graph.nodes.find(node=>node.kind==='query');
  assert.equal(graph.coverage,'partial');assert.equal(graph.nodes.some(node=>node.kind==='database'),false);
  assert.equal(graph.summary.tables,0);assert.equal(graph.summary.queries,1);
  assert.equal(model.label,'Product');assert.equal(model.file,'models.py');assert.equal(model.line,1);
  assert.equal(model.meta.sourceHash,site('models.py').hash);assert.equal(model.meta.sourceRole,'model-definition');
  assert.equal(model.meta.definitionOnly,true);assert.equal(model.meta.modelEvidence,'query-loaded');
  assert.equal(model.meta.model,'Product');assert.equal(model.meta.table,'products');assert.equal(model.meta.attribute,undefined);
  assert.equal(model.meta.requestId,dependency.request.id);assert.deepEqual(model.meta.queryIds,['query_12345']);
  assert.deepEqual(model.meta.modelSource,site('models.py',1));assert.ok(graph.files.includes('models.py'));
  assert.match(model.code,/class Product\(Base\)/);assert.match(model.detail,/does not establish which response field/);
  assert.ok(graph.edges.some(edge=>edge.from===query.id&&edge.to===model.id&&edge.label==='loads model'));
  assert.equal(graph.edges.some(edge=>edge.from===model.id),false);
  assert.ok(graph.gaps.some(message=>/lineage is not proven/.test(message)));
});

test('loaded class definitions share one request-local card while retaining each actual query ID',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
  const template=dependency.backend.queries[0],model={model:'Product',modelSource:site('models.py',1),table:'products'};
  dependency.backend.queries=['query_models_one','query_models_two'].map(id=>({...structuredClone(template),id,models:[model,model]}));
  const second=structuredClone(dependency);second.request.id='request_models_2';second.backend.id=second.request.id;
  trace.dependencies.push(second);
  const graph=resolve(),models=graph.nodes.filter(node=>node.kind==='model'),queries=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(models.length,2);assert.equal(queries.length,2);assert.equal(graph.summary.queries,4);
  assert.deepEqual(models.map(node=>node.meta.requestId),[dependency.request.id,second.request.id]);
  for(const model of models){
    assert.deepEqual(model.meta.queryIds,['query_models_one','query_models_two']);
    assert.equal(graph.edges.filter(edge=>edge.to===model.id&&edge.label==='loads model').length,1);
  }
  assert.equal(graph.coverage,'partial');assert.equal(graph.nodes.some(node=>node.kind==='database'),false);
});

test('query class metadata does not duplicate an existing proven model attribute for that class and query',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];
  dependency.backend.queries[0].models=[{model:'Product',modelSource:site('models.py',1),table:'products'}];
  let graph=resolve(),models=graph.nodes.filter(node=>node.kind==='model');
  assert.equal(models.length,1);assert.equal(models[0].label,'Product.price');assert.equal(models[0].meta.modelEvidence,undefined);
  assert.equal(graph.coverage,'complete');
  // A different execution still deserves its model evidence even when one
  // selected field happened to prove its origin through the first execution.
  dependency.backend.queries.push({...structuredClone(dependency.backend.queries[0]),id:'query_other_load',sql:'SELECT quantity FROM products'});
  graph=resolve();models=graph.nodes.filter(node=>node.kind==='model');
  assert.equal(models.length,2);assert.deepEqual(models.find(node=>node.meta.modelEvidence==='query-loaded').meta.queryIds,['query_other_load']);
});

test('same-named loaded models keep different class declaration locations',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
  dependency.backend.queries[0].models=[
    {model:'Product',modelSource:site('models.py',1),table:'products'},
    {model:'Product',modelSource:site('base.py',1),table:'legacy_products'}
  ];
  const graph=resolve(),models=graph.nodes.filter(node=>node.kind==='model');
  assert.equal(models.length,2);assert.deepEqual(models.map(node=>node.file),['models.py','base.py']);
  assert.deepEqual(models.map(node=>node.meta.table),['products','legacy_products']);
});

test('optional query model sources reject invalid claims and freshly edited declaration files',async t=>{
  const {trace,resolve,site,root}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
  const valid={model:'Product',modelSource:site('models.py',1),table:'products'};
  for(const model of [
    {model:'Product'},
    {...valid,model:'Product()'},
    {...valid,modelSource:{...valid.modelSource,hash:'0'.repeat(64)}},
    {...valid,modelSource:{...valid.modelSource,line:999}},
    {...valid,modelSource:{...valid.modelSource,path:'../models.py'}}
  ]){
    dependency.backend.queries[0].models=[model];const graph=resolve();
    assert.equal(graph.nodes.some(node=>node.kind==='model'),false);assert.equal(graph.coverage,'partial');
    assert.equal(graph.nodes.filter(node=>node.kind==='query').length,1);
  }
  dependency.backend.queries[0].models=[{...valid,table:'products; DROP TABLE patients'}];
  let graph=resolve();assert.equal(graph.nodes.find(node=>node.kind==='model').meta.table,undefined);
  await fs.appendFile(path.join(root,'models.py'),'# Declared source changed after indexing and the query\n');
  graph=resolve();assert.equal(graph.nodes.some(node=>node.kind==='model'),false);assert.equal(graph.coverage,'partial');
  assert.equal(graph.files.includes('models.py'),false);assert.equal(graph.nodes.filter(node=>node.kind==='query').length,1);
});

test('query model definitions require successful query and current route and query evidence',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
  const query=dependency.backend.queries[0],validSource=site('queries.cjs'),route=site('server.cjs');
  query.models=[{model:'Product',modelSource:site('models.py',1),table:'products'}];
  query.failed=true;assert.equal(resolve().nodes.some(node=>node.kind==='model'),false);
  delete query.failed;query.site={...validSource,hash:'0'.repeat(64)};
  assert.equal(resolve().nodes.some(node=>node.kind==='model'),false);
  query.site=validSource;dependency.backend.route={...route,hash:'0'.repeat(64)};
  assert.equal(resolve().nodes.some(node=>node.kind==='model'),false);
  dependency.backend.route=route;assert.equal(resolve().nodes.filter(node=>node.kind==='model').length,1);
});

test('scalar ORM statements expose verified referenced classes without claiming a load or field origin',async t=>{
 const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
 const query=dependency.backend.queries[0];query.models=[{model:'Product',modelSource:site('models.py',1),table:'products',evidence:'query-reference'}];
 const graph=resolve(),model=graph.nodes.find(node=>node.kind==='model');
 assert.equal(model.meta.modelEvidence,'query-reference');assert.match(model.detail,/statement referenced/);
 assert.ok(graph.edges.some(edge=>edge.to===model.id&&edge.label==='uses model'));assert.equal(graph.nodes.some(node=>node.kind==='database'),false);assert.equal(graph.coverage,'partial');
 query.models[0].evidence='guessed-from-table';assert.equal(resolve().nodes.some(node=>node.kind==='model'),false);
 query.models[0].evidence='query-reference';query.failed=true;assert.equal(resolve().nodes.some(node=>node.kind==='model'),false);
});

test('conflicting loaded model evidence for a shared execution ID is not silently merged',async t=>{
  const {trace,resolve,site}=await modelFixture(t),dependency=trace.dependencies[0];delete dependency.backend.fields;
  dependency.backend.queries[0].models=[{model:'Product',modelSource:site('models.py',1)}];
  const second=structuredClone(dependency);second.field='products.0.quantity';
  second.backend.queries[0].models=[{model:'Product',modelSource:site('base.py',1)}];trace.dependencies.push(second);
  const graph=resolve();assert.equal(graph.coverage,'partial');assert.equal(graph.nodes.some(node=>node.kind==='model'),false);
  assert.equal(graph.nodes.some(node=>node.kind==='query'),false);assert.ok(graph.gaps.some(message=>/sharing this request ID disagree/.test(message)));
});

test('stale frontend bytes invalidate capture even when the saved index hash matches the trace', async t => {
  const {resolve,root} = await fixture(t);
  await fs.appendFile(path.join(root,'src','Product.tsx'),'// changed after indexing\n');
  const graph=resolve();
  assert.equal(graph.coverage,'unavailable');
  assert.equal(graph.captured,false);
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
  assert.ok(graph.gaps.some(message=>/differs/.test(message)));
});

test('stale backend handler removes field origin while keeping honest frontend/request evidence', async t => {
  const {resolve,root} = await fixture(t);
  await fs.appendFile(path.join(root,'server.cjs'),'// changed handler\n');
  const graph=resolve();
  assert.equal(graph.coverage,'partial');
  assert.equal(graph.captured,true);
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
  assert.equal(graph.nodes.filter(node=>node.kind==='backend').length,0);
});

test('stale query site cannot retain a column claim through an unrelated valid stack frame', async t => {
  const {resolve,root} = await fixture(t);
  await fs.appendFile(path.join(root,'queries.cjs'),'// changed query\n');
  const graph=resolve();
  assert.equal(graph.coverage,'partial');
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
});

test('cross-origin and mismatched request correlation cannot create a complete path', async t => {
  const {resolve,trace} = await fixture(t);
  trace.dependencies[0].request.url='https://unreviewed.example/api/products';
  let graph=resolve();
  assert.equal(graph.captured,false);
  assert.equal(graph.coverage,'unavailable');
  trace.dependencies[0].request.url='http://localhost:7410/api/products';
  trace.dependencies[0].backend.id='different_request';
  graph=resolve();
  assert.equal(graph.coverage,'partial');
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
});

test('failed queries and nonexistent query references cannot establish field origin', async t => {
  const {resolve,trace} = await fixture(t);
  trace.dependencies[0].backend.queries[0].failed=true;
  assert.equal(resolve().nodes.filter(node=>node.kind==='database').length,0);
  trace.dependencies[0].backend.queries[0].failed=false;
  trace.dependencies[0].backend.fields['products.0.price'].queries=['query_that_did_not_execute'];
  assert.equal(resolve().nodes.filter(node=>node.kind==='database').length,0);
});

test('source reads reject root escapes, nonindexed paths and changed files', async t => {
  const {index,root} = await fixture(t);
  const window=readSource(index,'src/Product.tsx',2);
  assert.equal(window.line,2);
  assert.equal(window.startLine,1);
  assert.equal(window.language,'tsx');
  assert.ok(window.lines.some(line=>line.number===2&&line.highlight));
  for(const name of ['../outside.tsx','src/../../outside.tsx','C:/Windows/test.js','src\\Product.tsx','missing.js']) assert.throws(()=>readSource(index,name,1),/excluded|outside|changed/);
  await fs.appendFile(path.join(root,'src','Product.tsx'),'// stale\n');
  assert.throws(()=>readSource(index,'src/Product.tsx',2),/changed/);
});

test('index excludes hidden folders, secrets, runtime data, large files and binary data', async t => {
  const {root} = await fixture(t);
  for(const folder of ['.git','.aws','node_modules','data','dist']) {await fs.mkdir(path.join(root,folder));await fs.writeFile(path.join(root,folder,'leak.js'),'const shouldNotBeRead = true;');}
  await fs.writeFile(path.join(root,'.env'),'API_KEY=topsecret');
  await fs.writeFile(path.join(root,'credentials.json'),'{"password":"topsecret"}');
  await fs.writeFile(path.join(root,'private-key.js'),'const value="private"');
  await fs.writeFile(path.join(root,'oversized.js'),'x'.repeat(262145));
  await fs.writeFile(path.join(root,'binary.js'),Buffer.from([1,0,2]));
  await fs.writeFile(path.join(root,'settings.js'),'const password = "super-secret-value";\nconst api_key="sk-test-value-1234567890";\nconst color="blue";\n');
  const index=await indexRepository(root), names=index.files.map(file=>file.path);
  assert.deepEqual(names.sort(),['calculation.py','projection.py','queries.cjs','server.cjs','settings.js','src/Product.tsx']);
  assert.ok(index.skipped.tooLarge>0);
  assert.ok(index.skipped.binary>0);
  const settings=readSource(index,'settings.js',1).code;
  assert.ok(!settings.includes('super-secret-value'));
  assert.ok(!settings.includes('sk-test-value-1234567890'));
  assert.ok(settings.includes('blue'));
});

test('symlinked directories are excluded even when they target another indexed folder', async t => {
  const {root} = await fixture(t);
  try {await fs.symlink(path.join(root,'src'),path.join(root,'linked'),process.platform==='win32'?'junction':'dir');} catch(error) {if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not permit symlink creation.');return;}throw error;}
  const index=await indexRepository(root);
  assert.equal(index.files.filter(file=>file.path.startsWith('linked/')).length,0);
  assert.ok(index.skipped.symlinks>0);
  assert.throws(()=>readSource(index,'linked/Product.tsx',2),/excluded|outside|changed/);
});

test('unsupported bindings and frontend-only modes remain explicit', async t => {
  const {resolve,trace} = await fixture(t);
  let graph=resolve({trace:null});
  assert.equal(graph.coverage,'unavailable');
  assert.ok(graph.nodes.some(node=>node.kind==='gap'));
  graph=resolve({trace:{...trace,mode:'static',dependencies:[]}});
  assert.equal(graph.coverage,'frontend');
  assert.equal(graph.summary.requests,0);
  assert.equal(graph.nodes.filter(node=>node.kind==='database').length,0);
});

test('trace objects with accessors are rejected without invoking getters', async t => {
  const {resolve} = await fixture(t);
  let called=false;
  const trace={};Object.defineProperty(trace,'version',{enumerable:true,get(){called=true;return 1;}});
  const graph=resolve({trace});
  assert.equal(called,false);
  assert.equal(graph.coverage,'unavailable');
});

test('page reader inspects only captured WeakMap metadata; picker scripts compile', async t => {
  const {trace} = await fixture(t);
  const element={},map=new WeakMap([[element,trace]]),context={document:{querySelector:()=>element},__studioElementFlowV1:map};
  const capture=vm.runInNewContext(getPageReaderScript('#price'),context);
  assert.equal(capture.trace.source.expression,'price.value');
  assert.equal(capture.runtimeAvailable,true);
  assert.equal(capture.frames.length,0);
  new vm.Script(getPickerScript());new vm.Script(getPickerScript(false));
});

test('only element inspection waits for relevant pending metadata and rereads settled evidence',async t=>{
 const {trace}=await fixture(t),element={},map=new WeakMap([[element,trace]]),requestId=trace.dependencies[0].request.id;
 const original=trace.dependencies[0].backend;trace.dependencies[0].backend=null;
 let settle;const pending=new Map([[requestId,new Promise(resolve=>{settle=()=>{trace.dependencies[0].backend=original;resolve();};})]]);
 const context={document:{querySelector:()=>element},__studioElementFlowV1:map,__studioElementFlowPendingV1:pending,setTimeout,clearTimeout};
 const result=vm.runInNewContext(getPageReaderScript('#price'),context);assert.equal(typeof result.then,'function');settle();
 const snapshot=await result;assert.equal(snapshot.trace.dependencies[0].backend.id,requestId);
 let called=false;pending.set(requestId,Object.defineProperty({},'then',{get(){called=true;throw Error('Do not invoke page then getters');}}));
 await vm.runInNewContext(getPageReaderScript('#price'),context);assert.equal(called,false);
 pending.clear();pending.set('unrelated_request',new Promise(()=>{}));
 assert.equal(vm.runInNewContext(getPageReaderScript('#price'),context).runtimeAvailable,true);
});

test('pending metadata cannot replace the clicked DOM element or binding with a different selection',async t=>{
 const {trace}=await fixture(t),first={},replacement={},map=new WeakMap([[first,trace],[replacement,structuredClone(trace)]]),id=trace.dependencies[0].request.id;
 let current=first,settle;const pending=new Map([[id,new Promise(resolve=>{settle=resolve;})]]);
 const context={document:{querySelector:()=>current},__studioElementFlowV1:map,__studioElementFlowPendingV1:pending,setTimeout,clearTimeout};
 const result=vm.runInNewContext(getPageReaderScript('#price'),context);current=replacement;settle();const changed=await result;assert.equal(changed.selectionChanged,true);assert.equal(changed.trace,null);
 current=first;pending.set(id,new Promise(resolve=>{settle=resolve;}));const rebound=vm.runInNewContext(getPageReaderScript('#price'),context);map.set(first,structuredClone(trace));settle();assert.equal((await rebound).selectionChanged,true);
});

test('grouped query timings preserve measured executions and flag only potential repeated-read patterns', async t => {
  const {trace,resolve,site}=await fixture(t),dependency=trace.dependencies[0],template=dependency.backend.queries[0];
  dependency.request.durationMs=35;dependency.backend.durationMs=24;
  dependency.backend.queries=[
    {...structuredClone(template),id:'timed_query_one',durationMs:2.5,startOffsetMs:1},
    {...structuredClone(template),id:'timed_query_two',durationMs:1.5,startOffsetMs:8},
    {...structuredClone(template),id:'timed_query_three',startOffsetMs:12}
  ];
  dependency.backend.fields[dependency.field].queries=['timed_query_two'];
  const graph=resolve(),query=graph.nodes.find(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');
  assert.equal(query.meta.executionCount,3);assert.equal(query.meta.measuredCount,2);
  assert.equal(query.meta.totalDurationMs,4);assert.equal(query.meta.durationMs,4);
  assert.equal(query.meta.minDurationMs,1.5);assert.equal(query.meta.maxDurationMs,2.5);
  assert.equal(query.meta.sourceHash,site('queries.cjs').hash);
  assert.deepEqual(query.meta.executions,[{id:'timed_query_one',durationMs:2.5,startOffsetMs:1},{id:'timed_query_two',durationMs:1.5,startOffsetMs:8},{id:'timed_query_three',startOffsetMs:12}]);
  assert.equal(graph.nodes.find(node=>node.kind==='api').meta.durationMs,35);
  assert.equal(graph.nodes.find(node=>node.kind==='backend').meta.durationMs,24);
  assert.deepEqual(graph.summary.timing,{browserRequestCount:1,browserDurationMs:35,backendRequestCount:1,backendDurationMs:24,queryMeasuredCount:2,queryDurationMs:4});
  assert.equal(graph.diagnostics.length,1);assert.equal(graph.diagnostics[0].code,'potential_n_plus_one');
  assert.deepEqual(graph.diagnostics[0].nodeIds,[query.id]);assert.equal(graph.diagnostics[0].count,3);
  assert.match(graph.diagnostics[0].detail,/does not prove/);assert.equal(graph.gaps.length,0);
});

test('missing, nonnumeric and out-of-range clock data never create durations or a synthetic timeline', async t => {
  const {trace,resolve}=await fixture(t),dependency=trace.dependencies[0],query=dependency.backend.queries[0];
  for(const invalid of [undefined,null,'12',-1,NaN,Infinity,86400001]){
    if(invalid===undefined){delete dependency.request.durationMs;delete dependency.backend.durationMs;delete query.durationMs;delete query.startOffsetMs;}
    else {dependency.request.durationMs=invalid;dependency.backend.durationMs=invalid;query.durationMs=invalid;query.startOffsetMs=invalid;}
    const graph=resolve(),meta=graph.nodes.find(node=>node.kind==='query').meta;
    assert.equal(graph.summary.timing,undefined);assert.equal(meta.durationMs,undefined);
    assert.equal(meta.totalDurationMs,undefined);assert.equal(meta.executions[0].durationMs,undefined);
    assert.equal(meta.executions[0].startOffsetMs,undefined);
    assert.equal(graph.nodes.find(node=>node.kind==='api').meta.durationMs,undefined);
    assert.equal(graph.coverage,'complete');
  }
  query.durationMs=0;query.startOffsetMs=0;
  const graph=resolve(),meta=graph.nodes.find(node=>node.kind==='query').meta;
  assert.equal(meta.durationMs,0);assert.equal(meta.measuredCount,1);
  assert.equal(meta.executions[0].startOffsetMs,0);assert.equal(graph.summary.timing.queryDurationMs,0);
});

test('numeric DTO calculations show all explicit ORM input columns and redacted structural operations', async t => {
  const {trace,resolve,site}=await fixture(t),dependency=trace.dependencies[0];
  const leaf=column=>({kind:'column',table:'products',column,model:'Product',queries:['query_12345']});
  dependency.backend.fields[dependency.field]={kind:'computed',immutable:true,queries:['query_12345'],projection:site('calculation.py'),operation:{op:'multiply',left:leaf('price'),right:{op:'add',left:leaf('quantity'),right:{kind:'constant',value:'PRIVATE-LITERAL'}}}};
  const graph=resolve(),mapping=graph.nodes.find(node=>node.meta?.computed);
  assert.equal(graph.coverage,'complete');assert.equal(graph.summary.tables,1);
  assert.equal(mapping.label,'Python calculated response');
  assert.equal(mapping.meta.expression,'(products.price * (products.quantity + constant))');
  assert.deepEqual(mapping.meta.inputColumns,['products.price','products.quantity']);
  const databases=graph.nodes.filter(node=>node.kind==='database');
  assert.deepEqual(databases.map(node=>node.label),['products.price','products.quantity']);
  assert.ok(databases.every(node=>node.meta.computedInput));
  assert.equal(graph.edges.filter(edge=>edge.from===mapping.id&&edge.label==='calculation input').length,2);
  assert.equal(JSON.stringify(graph).includes('PRIVATE-LITERAL'),false);
});

test('unsupported, uncorrelated and stale computed mappings cannot retain a direct origin fallback', async t => {
  const {trace,resolve,site}=await fixture(t),dependency=trace.dependencies[0];
  const leaf={kind:'column',table:'products',column:'price',model:'Product',queries:['query_12345']};
  const origin={kind:'computed',immutable:true,table:'products',column:'price',model:null,queries:['query_12345'],projection:site('calculation.py'),operation:{op:'multiply',left:leaf,right:{kind:'constant'}}};
  const invalids=[
    {...origin,immutable:false},
    {...origin,operation:{...origin.operation,op:'custom_function'}},
    {...origin,projection:{...origin.projection,hash:'0'.repeat(64)}},
    {...origin,projection:null},
    {...origin,operation:{...origin.operation,left:{...leaf,queries:['unknown_query']}}},
    {...origin,operation:{...origin.operation,left:{kind:'equal_value',table:'products',column:'price'}}},
    {...origin,operation:{op:'multiply',left:{kind:'constant'},right:{kind:'constant'}}}
  ];
  for(const invalid of invalids){
    dependency.backend.fields[dependency.field]=invalid;
    const graph=resolve();assert.equal(graph.coverage,'partial');
    assert.equal(graph.nodes.some(node=>node.kind==='database'),false);
    assert.ok(graph.gaps.some(message=>/lineage/.test(message)));
  }
});

test('multiple selected fields from one response share request, calls, SQL executions, timing and findings', async t => {
  const {trace,resolve,site}=await fixture(t),first=trace.dependencies[0],template=first.backend.queries[0];
  first.request.durationMs=30;first.backend.durationMs=20;
  first.backend.queries=[1,2,3].map(number=>({...structuredClone(template),id:'shared_query_'+number,durationMs:number,startOffsetMs:number*2,frames:[site('server.cjs'),site('projection.py',1),site('queries.cjs')]}));
  first.backend.fields[first.field].queries=['shared_query_2'];
  const second=structuredClone(first);second.field='products.0.quantity';
  second.backend.fields[second.field]={table:'products',column:'quantity',model:null,queries:['shared_query_3']};
  trace.dependencies.push(second);
  const graph=resolve(),api=graph.nodes.filter(node=>node.kind==='api'),query=graph.nodes.filter(node=>node.kind==='query');
  assert.equal(graph.coverage,'complete');assert.equal(graph.summary.requests,1);assert.equal(graph.summary.queries,3);
  assert.equal(api.length,1);assert.equal(graph.nodes.filter(node=>node.kind==='backend').length,1);assert.equal(query.length,1);
  assert.deepEqual(api[0].meta.responseFields,['products.0.price','products.0.quantity']);
  assert.equal(api[0].meta.responseField,'products.0.price');assert.equal(query[0].meta.executionCount,3);
  assert.equal(graph.nodes.filter(node=>node.meta?.sourceRole==='backend-call').length,1);
  assert.deepEqual(graph.nodes.filter(node=>node.kind==='database').map(node=>node.label),['products.price','products.quantity']);
  assert.deepEqual(graph.summary.timing,{browserRequestCount:1,browserDurationMs:30,backendRequestCount:1,backendDurationMs:20,queryMeasuredCount:3,queryDurationMs:6});
  assert.equal(graph.diagnostics.length,1);assert.equal(graph.diagnostics[0].count,3);
  assert.equal(graph.edges.filter(edge=>edge.to===api[0].id&&edge.label.startsWith('reads ')).length,2);
});

test('conflicting captures sharing a request or execution ID create an explicit boundary instead of merging claims', async t => {
  const {trace,resolve,site}=await fixture(t),first=trace.dependencies[0];
  for(const mutate of [
    row=>{row.request.status=201;},
    row=>{row.backend.route=site('projection.py');},
    row=>{row.backend.queries[0].sql='SELECT quantity FROM products';},
    row=>{row.backend.fields[row.field].column='quantity';}
  ]){
    const second=structuredClone(first);mutate(second);trace.dependencies=[first,second];
    const graph=resolve();assert.equal(graph.coverage,'partial');assert.equal(graph.summary.requests,1);assert.equal(graph.summary.queries,0);
    assert.equal(graph.nodes.filter(node=>node.kind==='api').length,1);
    assert.equal(graph.nodes.some(node=>['backend','query','database'].includes(node.kind)),false);
    assert.ok(graph.gaps.some(message=>/disagree|conflicting/.test(message)));
    assert.equal(graph.diagnostics.length,0);
  }
});
