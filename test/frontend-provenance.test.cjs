'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm'),fs=require('node:fs'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');

function compiler(){for(const directory of [process.env.ORIVO_FRONTEND_FIXTURE,path.resolve(__dirname,'../../physio-clinic/frontend'),path.resolve(__dirname,'../../../connectodot/frontend')].filter(Boolean))try{return createRequire(path.join(directory,'package.json'))('esbuild');}catch{}return null;}
async function fixture(t,source,raw={first:'Same synthetic value',second:'Same synthetic value'}){
 const esbuild=compiler();if(!esbuild){t.skip('An installed React/Vite fixture with esbuild is required for the compiler acceptance checks.');return null;}
 const keys=['window','location','__studioElementFlowV1','__studioElementFlowPendingV1'],saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const key of keys)delete globalThis[key];
 t.after(()=>{for(const key of keys){delete globalThis[key];const value=saved.get(key);if(value)Object.defineProperty(globalThis,key,value);}});
 globalThis.window={};globalThis.location={href:'http://localhost:7410/',origin:'http://localhost:7410'};
 const flow=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/runtime.mjs')).href+'?lexical='+Date.now()+Math.random()),{transformStudio}=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/vite.mjs')).href);
 const data=await flow.recordResponse(raw,new Response('{}'),'frontend_scope_12345','GET','http://localhost:7410/api/items');
 const output=transformStudio(source,path.resolve('App.tsx'),path.resolve('.'),undefined,{runtimeImport:'flow'});assert.ok(output);
 const code=esbuild.transformSync(output,{loader:'tsx',format:'cjs',jsxFactory:'h',jsxFragment:'Fragment'}).code,module={exports:{}},hosts=new Map(),calls=[];
 const h=(type,props,...children)=>{props={...props};const key=props.key;delete props.key;if(children.length)props.children=children.length===1?children[0]:children;return Object.freeze({type,key,props:Object.freeze(props)});};
 const context={module,exports:module.exports,require:name=>{assert.equal(name,'flow');return flow;},h,Fragment:Symbol.for('fragment'),calls,structuredClone};vm.runInNewContext(code,context);
 function mount(node){if(Array.isArray(node)){for(const child of node)mount(child);return;}if(node==null||typeof node!=='object')return;if(typeof node.type==='function')return mount(node.type(node.props));if(node.type===context.Fragment)return mount(node.props.children);const host={props:node.props};if(node.props.id)hosts.set(node.props.id,host);node.props.ref?.(host);mount(node.props.children);}
 return {data,flow,output,exports:module.exports,calls,hosts,render:()=>mount(module.exports.App({data})),record:id=>globalThis.__studioElementFlowV1.get(hosts.get(id)),fields:id=>globalThis.__studioElementFlowV1.get(hosts.get(id))?.dependencies.map(row=>row.field)};
}

test('primitive props, children and lexical aliases retain exact origins when values are equal',async t=>{
 const f=await fixture(t,`
 export function Child({text,children}:{text:string;children?:string}) {const label=text;return <section><p id="prop">{label}</p><p id="child">{children}</p></section>;}
 export function App({data}) {const label=data.first;const {second: renamed}=data;let nested;{const label=data.second;nested=<p id="shadow">{label}</p>;}return <main><p id="alias">{label}</p><p id="destructure">{renamed}</p>{nested}<Child text={data.first}>{data.second}</Child><p id="literal">Same synthetic value</p></main>;}`);if(!f)return;f.render();
 assert.deepEqual(f.fields('alias'),['first']);assert.deepEqual(f.fields('destructure'),['second']);assert.deepEqual(f.fields('shadow'),['second']);assert.deepEqual(f.fields('prop'),['first']);assert.deepEqual(f.fields('child'),['second']);assert.deepEqual(f.fields('literal'),[]);
});

test('object aliases keep only the selected leaf rather than contaminating it with container dependencies',async t=>{
 const f=await fixture(t,`export function App({data}) {const row=data.items[0];const {title}=row;return <main><p id="leaf">{row.title}</p><p id="copy">{title}</p></main>;}`,{items:[{title:'Synthetic',id:'Same unrelated row'}]});if(!f)return;f.render();assert.deepEqual(f.fields('leaf'),['items.0.title']);assert.deepEqual(f.fields('copy'),['items.0.title']);
});

test('nested custom components preserve composite children arrays, count dependencies and array identity',async t=>{
 const f=await fixture(t,`export function Inner({children}) {calls.push(children);return <span id="badge">{children}</span>;}export function Badge(props) {return <Inner {...props}/>;}export function App({data}) {return <Badge>{data.items.length} project{data.items.length===1?'':'s'}</Badge>;}`,{items:[{title:'Equal'},{title:'Equal'},{title:'Equal'}]});if(!f)return;f.render();assert.deepEqual(f.fields('badge'),['items']);assert.equal(f.hosts.get('badge').props.children,f.calls[0]);assert.deepEqual(Array.from(f.calls[0]),[3,' project','s']);assert.ok(f.record('badge').dependencies.every(row=>row.collection===true));
});

test('async page append and mapped composite badges keep only the actual response collection witness',async t=>{
 const f=await fixture(t,`let projects;async function pages(data,all){const result=await Promise.resolve({items:data.items});all.push(...result.items);return all;}export async function prepare(data,all){const rows=await pages(data,all);projects=rows.map(item=>({title:item.title}));}function Badge({children}){return <span id="page-count">{children}</span>;}export function App(){return <Badge>{projects.length} project{projects.length===1?'':'s'}</Badge>;}`,{items:[{title:'Equal'},{title:'Equal'}]});if(!f)return;
 const id='frontend_scope_12345',witness={queries:['query_items'],count:2,source:{path:'api.py',line:3,hash:'a'.repeat(64),name:'items'}},backend={id,route:{path:'api.py',line:1,hash:'b'.repeat(64),name:'items'},queries:[{id:'query_items',sql:'SELECT title FROM items'}],fields:{},collections:{items:witness}};
 await f.flow.recordResponse(f.data,new Response('{}',{headers:{'Studio-Trace':Buffer.from(JSON.stringify(backend)).toString('base64')}}),id,'GET','http://localhost:7410/api/items');await f.exports.prepare(f.data,f.flow.array([]));f.render();const rows=f.record('page-count').dependencies;assert.deepEqual(rows.map(row=>row.field),['items']);assert.deepEqual(rows[0].operations,['append','map','length']);assert.deepEqual(rows[0].backend.collections,{items:witness});assert.equal(rows[0].backend.queries[0].id,'query_items');assert.equal(f.hosts.get('page-count').props.children[0],2);
});

test('rest props and JSX spreads preserve each field, override order, keys and existing refs',async t=>{
 const f=await fixture(t,`
 const motion={input:'input'};
 export function Field({label,...props}) {return <input {...props} id="field"/>;}
 export function App({data}) {const tracked={value:data.first};return <main><Field label="Name" {...tracked}/><input id="override" {...tracked} {...{value:'Same synthetic value'}}/><input key="stable" id="ref" value={data.second} ref={node=>{if(node)calls.push('ref');}}/></main>;}`);if(!f)return;f.render();
 assert.deepEqual(f.fields('field'),['first']);assert.deepEqual(f.fields('override'),[]);assert.deepEqual(f.fields('ref'),['second']);assert.deepEqual(f.calls,['ref']);
});

test('destructuring and spreads read getters once and preserve short-circuit and method receivers',async t=>{
 const f=await fixture(t,`
 export function App({data}) {const source={get value(){calls.push('getter');return data.first;}};const {value}=source;const receiver={name:'receiver',method(){calls.push(this.name);return value;}};return <main><p id="getter">{value}</p><p id="receiver">{receiver.method()}</p><p id="short">{false&&data.second}</p><input id="spread" {...source}/></main>;}`);if(!f)return;f.render();
 assert.deepEqual(f.calls,['getter','receiver','getter']);assert.deepEqual(f.fields('short'),[]);assert.deepEqual(f.fields('receiver'),['first']);
});

test('reassigned params and mutated properties do not inherit stale equal-value origins',async t=>{
 const f=await fixture(t,`
 export function Reassigned({text}) {text='Same synthetic value';return <p id="param">{text}</p>;}
 export function App({data}) {const changed={value:data.first};changed.value='Same synthetic value';const other={value:data.first};other.value='Different';return <main><Reassigned text={data.first}/><p id="changed">{changed.value}</p><p id="different">{other.value}</p><p id="unrelated">{'Same synthetic value'}</p></main>;}`);if(!f)return;f.render();
 assert.deepEqual(f.fields('param'),[]);assert.deepEqual(f.fields('changed'),[]);assert.deepEqual(f.fields('different'),[]);assert.deepEqual(f.fields('unrelated'),[]);
});

test('hook order and lazy default evaluation stay in the component execution',async t=>{
 const f=await fixture(t,`
 const useValue=()=>{calls.push('hook');return 7;};
 export function Child({text='fallback'}) {const value=useValue();calls.push('render');return <p id="hook">{text}{value}</p>;}
 export function App({data}) {return <Child text={data.first}/>;}`);if(!f)return;f.render();assert.deepEqual(f.calls,['hook','render']);assert.deepEqual(f.fields('hook'),['first']);
});

test('getter results and unsupported parameter defaults cannot reuse an equal but unrelated origin',async t=>{
 const f=await fixture(t,`
 const fallback=()=> 'outer';
 export function Default({text=fallback()}) {function fallback(){return 'inner';}return <p id="default">{text}</p>;}
 export function App({data}) {let local=false;const source={get value(){return local?'Same synthetic value':data.first;}};const {value:first}=source;local=true;const {value:second}=source;return <main><p id="getter-first">{first}</p><p id="getter-next">{second}</p><Default/></main>;}`);if(!f)return;f.render();assert.deepEqual(f.fields('getter-first'),['first']);assert.deepEqual(f.fields('getter-next'),[]);assert.equal(f.hosts.get('default').props.children,'outer');
});

test('native array map/filter/slice keep slot origins and collection counts without scanning equal values',async t=>{
 const f=await fixture(t,`
 export function App({data}) {const mapped=data.numbers.map(value=>value*2),filtered=data.numbers.filter(value=>value>3),sliced=data.numbers.slice(1,3);return <main><p id="mapped-slot">{mapped[1]}</p><p id="filtered-slot">{filtered[0]}</p><p id="sliced-slot">{sliced[0]}</p><p id="count">{mapped.length}</p></main>;}`,{numbers:[3,3,5]});if(!f)return;f.render();assert.deepEqual(f.fields('mapped-slot'),['numbers.1']);assert.deepEqual(f.fields('filtered-slot'),['numbers.2']);assert.deepEqual(f.fields('sliced-slot'),['numbers.1']);assert.deepEqual(f.fields('count'),['numbers']);
});

test('opaque filter controls stay explicit through clone, map, slice, append and dependency deduplication',async t=>{
 const f=await fixture(t,`const opaque=()=>true;export function App({data}) {const known=data.items.filter(item=>!item.hidden),unknown=data.items.filter(item=>opaque()),copied=structuredClone(unknown),mapped=copied.map(item=>item).slice();data.target.push(...data.items,...mapped);return <main><p id="known-filter">{known.length}</p><p id="unknown-filter">{unknown.length}</p><p id="derived-filter">{data.target.length}</p></main>;}`,{items:[{hidden:false},{hidden:true}],target:[]});if(!f)return;f.render();assert.equal(f.hosts.get('known-filter').props.children,1);assert.ok(f.record('known-filter').dependencies.every(row=>row.collectionUnknown!==true));assert.ok(f.record('unknown-filter').dependencies.some(row=>row.collectionUnknown===true));assert.ok(f.record('derived-filter').dependencies.some(row=>row.field==='items'&&row.collectionUnknown===true));
});

test('conditional single-object append traces observed true and false controls without payload cardinality inputs',async t=>{
 const source=`export function App({data}) {const projects=data.projects.map(project=>({id:project.id}));const unassigned=data.tasks.filter(task=>!task.milestone_id);if(unassigned.length)projects.push({id:(calls.push('payload'),'synthetic-'+data.payloadId),tasks:unassigned.map(task=>task)});return <main><p id="project-count">{projects.length}</p><p id="project-id">{projects[0]?.id}</p></main>;}`;
 const f=await fixture(t,source,{projects:[],tasks:[{milestone_id:null}],payloadId:'Local project'});if(!f)return;f.render();assert.equal(f.hosts.get('project-count').props.children,1);assert.deepEqual(f.fields('project-count').sort(),['projects','tasks']);assert.deepEqual(f.fields('project-id'),['payloadId']);assert.deepEqual(f.calls,['payload']);assert.ok(f.record('project-count').dependencies.some(row=>row.field==='tasks'&&row.role==='control'));assert.ok(f.record('project-count').dependencies.every(row=>!row.collectionUnknown));
 const g=await fixture(t,source,{projects:[{id:'Original'}],tasks:[],payloadId:'Unused'});if(!g)return;g.render();assert.equal(g.hosts.get('project-count').props.children,1);assert.deepEqual(g.fields('project-count').sort(),['projects','tasks']);assert.deepEqual(g.calls,[]);assert.ok(g.record('project-count').dependencies.some(row=>row.field==='tasks'&&row.role==='control'));
});

test('opaque conditional controls remain partial on both observed branches and map payloads retain only slot origins',async t=>{
 const f=await fixture(t,`const opaque=()=>false;export function App({data}) {const projects=data.projects.slice();if(opaque())projects.push({id:data.other});const mapped=data.projects.map(()=>data.other);return <main><p id="opaque-count">{projects.length}</p><p id="map-count">{mapped.length}</p><p id="map-slot">{mapped[0]}</p></main>;}`,{projects:[{id:'Known'}],other:'Unrelated payload'});if(!f)return;f.render();assert.ok(f.record('opaque-count').dependencies.some(row=>row.collectionUnknown===true));assert.deepEqual(f.fields('map-count'),['projects']);assert.deepEqual(f.fields('map-slot'),['other']);
 const g=await fixture(t,`const opaque=()=>true;export function App({data}) {const projects=data.projects.slice();if(opaque())projects.push(data.other);return <p id="opaque-true">{projects.length}</p>;}`,{projects:[],other:'Unrelated payload'});if(!g)return;g.render();assert.ok(g.record('opaque-true').dependencies.some(row=>row.collectionUnknown===true));assert.deepEqual(g.fields('opaque-true'),['projects']);
});

test('conditional append preserves getter order, native throws and skipped dynamic or uninitialized receivers',async t=>{
 const f=await fixture(t,`export function App({data}) {const target=data.target;const check={get ready(){calls.push('test');return true;}};Object.defineProperty(target,'push',{get(){calls.push('method');return function(value){calls.push(this===target);return Array.prototype.push.call(this,value);};}});if(check.ready)target.push((calls.push('arg'),data.value));const frozen=data.frozen;Object.freeze(frozen);try{if(data.ready)frozen.push((calls.push('frozen-arg'),data.value));}catch(error){calls.push(error.name);}if(false)later.push(data.value);const later=[];const holder={get items(){calls.push('skipped-getter');return [];}};if(false)holder.items.push(data.value);return <p id="effects">{target.length}</p>;}`,{target:[],frozen:[],ready:true,value:'Synthetic'});if(!f)return;f.render();assert.deepEqual(f.calls,['test','method','arg',true,'frozen-arg','TypeError']);assert.equal(f.data.target.length,1);assert.equal(f.data.frozen.length,0);assert.ok(f.output.includes('conditionalAppend'));assert.ok(!f.output.includes('()=>later'));
});

test('find predicates cannot crowd out the chosen object field and optional calls preserve receivers and short circuit',async t=>{
 const f=await fixture(t,`
 export function App({data}) {const selected=data.items.find(item=>item.id==='item19')?.name;const formatted=data.items[0].name?.replaceAll(' ','-');const absent=data.missing?.method().name;return <main><p id="chosen">{selected}</p><p id="formatted">{formatted}</p><p id="absent">{absent}</p></main>;}`,{items:Array.from({length:20},(_,i)=>({id:'item'+i,name:'Same synthetic value'})),missing:null});if(!f)return;f.render();assert.deepEqual(f.fields('chosen'),['items.19.name']);assert.deepEqual(f.fields('formatted'),['items.0.name']);assert.deepEqual(f.fields('absent'),['missing']);
});

test('native callback thisArg, sparse holes, exceptions and coercive slice arguments preserve application behavior',async t=>{
 const sparse=[];sparse.length=4;sparse[1]=3;sparse[3]=5;
 const f=await fixture(t,`
 export let result;export function App({data}) {const owner={label:'owner'};result=data.numbers.map(function(value,index,array){calls.push([this.label,index,array===data.numbers]);return value;},owner);const sliced=data.numbers.slice({valueOf(){calls.push('coerce');return 1;}});return <p id="coerced">{sliced[0]}</p>;}`,{numbers:sparse});if(!f)return;f.render();assert.equal(0 in f.exports.result,false);assert.equal(2 in f.exports.result,false);assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[['owner',1,true],['owner',3,true],'coerce']);assert.deepEqual(f.fields('coerced'),[]);
});

test('native structuredClone transfers exact own-path origins without confusing equal fields or later mutations',async t=>{
 const f=await fixture(t,`export function App({data}) {const copied=structuredClone(data),changed=structuredClone(data);changed.first='Same synthetic value';return <main><p id="clone-first">{copied.first}</p><p id="clone-second">{copied.second}</p><p id="clone-changed">{changed.first}</p></main>;}`);if(!f)return;f.render();assert.deepEqual(f.fields('clone-first'),['first']);assert.deepEqual(f.fields('clone-second'),['second']);assert.deepEqual(f.fields('clone-changed'),[]);
});

test('native push spreads retain collection and exact slot provenance including empty pages',async t=>{
 const f=await fixture(t,`export let result;export function App({data}) {const all=data.target;all.push(...data.items);const mapped=all.map(item=>({label:item.title}));const empty=data.emptyTarget;empty.push(...data.empty);const count=empty.map(item=>item).length;result=[all===data.target,all.length,count];return <main><p id="appended">{all[1].title}</p><p id="append-count">{mapped.length}</p><p id="empty-count">{count}</p></main>;}`,{target:[],items:[{title:'Equal'},{title:'Equal'}],emptyTarget:[],empty:[]});if(!f)return;f.render();assert.deepEqual(Array.from(f.exports.result),[true,2,0]);assert.deepEqual(f.fields('appended'),['items.1.title']);assert.ok(f.fields('append-count').includes('items'));assert.ok(f.fields('empty-count').includes('empty'));
 const rows=globalThis.__studioElementFlowV1.get(f.hosts.get('append-count')).dependencies;assert.ok(rows.every(row=>row.collection===true&&row.operations.at(-1)==='length'));assert.ok(rows.some(row=>row.operations.includes('append')&&row.operations.includes('map')));
});

test('push arguments preserve native evaluation, custom receivers, iterator and getter counts',async t=>{
 const f=await fixture(t,`export let result;export function App({data}) {const all=data.target;all.push(data.first,'Same synthetic value',...data.more,data.second);const custom={push(...args){calls.push([this===custom,args.join('|')]);return 31;}};const iterable={get [Symbol.iterator](){calls.push('iterator');let n=0;return function(){return {next(){calls.push('next');return n++?{done:true}:{done:false,value:'value'};}}};}};const length=custom.push(...iterable);result=[all,length];return <main><p id="push-first">{all[0]}</p><p id="push-local">{all[1]}</p><p id="push-spread">{all[2]}</p><p id="push-last">{all[3]}</p></main>;}`,{target:[],first:'Same synthetic value',second:'Same synthetic value',more:['Same synthetic value']});if(!f)return;f.render();assert.equal(f.exports.result[1],31);assert.deepEqual(f.fields('push-first'),['first']);assert.deepEqual(f.fields('push-local'),[]);assert.deepEqual(f.fields('push-spread'),['more.0']);assert.deepEqual(f.fields('push-last'),['second']);assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),['iterator','next','next',[true,'value']]);
});

test('custom iterators cannot borrow native spread cardinality or slot origins',async t=>{
 const f=await fixture(t,`export function App({data}) {Object.defineProperty(data.items,Symbol.iterator,{get(){calls.push('iterator');return function*(){yield 'Unrelated';};}});data.target.push(...data.items);return <main><p id="custom-spread-slot">{data.target[0]}</p><p id="custom-spread-count">{data.target.length}</p></main>;}`,{target:[],items:['Tracked','Tracked']});if(!f)return;f.render();assert.deepEqual(f.calls,['iterator']);assert.deepEqual(f.fields('custom-spread-slot'),[]);assert.ok(!f.fields('custom-spread-count').includes('items'));assert.equal(f.hosts.get('custom-spread-count').props.children,1);
});

test('executed nullish literal fallbacks keep their local value and actual API control context',async t=>{
 const f=await fixture(t,`export function Label({text}) {const alias=text;return <p id="forwarded">{alias}</p>;}export function App({data}) {const label=data.missing??'Product',row={label,title:data.title},copy=structuredClone(row);return <main><p id="fallback">{label}</p><Label text={copy.label}/><p id="present">{data.title??'Product'}</p><p id="sibling">{row.title}</p><p id="literal">{null??'Literal'}</p></main>;}`,{missing:null,title:'Product'});if(!f)return;f.render();
 for(const id of ['fallback','forwarded','literal']){const record=f.record(id);assert.equal(record.valueOrigin,'local',id);assert.equal(record.localValues[0].role,'value');assert.equal(record.localValues[0].source.kind,'literal-fallback');assert.ok(record.dependencies.every(row=>row.role==='control'));}
 assert.equal(f.record('present').valueOrigin,undefined);assert.equal(f.record('present').localValues,undefined);assert.equal(f.record('sibling').localValues,undefined);assert.deepEqual(f.fields('sibling'),['title']);
});

test('fallback claims never absorb opaque values, sibling expressions or unused custom props',async t=>{
 const f=await fixture(t,`const opaque=()=> 'Untracked';export function Child({unused}) {return <span>{opaque()}</span>;}export function App({data}) {const local=data.missing??'Fallback',mixed=local+opaque(),row={local,unknown:opaque()};return <main id="parent"><p id="mixed-children">{local} {opaque()}</p><p id="mixed-expression">{(data.missing??'Fallback')+opaque()}</p><p id="mixed-alias">{mixed}</p><p id="mixed-property">{row.unknown}</p><Child unused={local}/><p id="safe">{row.local}</p></main>;}`,{missing:null});if(!f)return;f.render();for(const id of ['parent','mixed-children','mixed-expression','mixed-alias','mixed-property'])assert.equal(f.record(id).valueOrigin,undefined,id);assert.equal(f.record('safe').valueOrigin,'local');
});

test('computed lookup keys are controls and nullish fallbacks preserve lazy getters and errors',async t=>{
 const f=await fixture(t,`export function App({data}) {const first=data.names[data.id]??'Fallback',absent=data.names[data.absent]??'Fallback';const source={get value(){calls.push('getter');return data.missing;}};const lazy=source.value??'Fallback';let caught;try{null.method??'Fallback';}catch(error){caught=error.name;}calls.push(caught);return <main><p id="looked-up">{first}</p><p id="lookup-fallback">{absent}</p><p id="getter-fallback">{lazy}</p></main>;}`,{id:'a',absent:'b',names:{a:'Fallback'},missing:null});if(!f)return;f.render();assert.deepEqual(f.calls,['getter','TypeError']);const lookup=f.record('looked-up');assert.equal(lookup.valueOrigin,undefined);assert.equal(lookup.dependencies.find(row=>row.field==='id').role,'control');assert.notEqual(lookup.dependencies.find(row=>row.field==='names.a').role,'control');assert.equal(f.record('lookup-fallback').valueOrigin,'local');assert.equal(f.record('getter-fallback').valueOrigin,'local');
});

test('structuredClone invokes getters once and preserves transfers and native errors',async t=>{
 let getters=0;const raw={first:'Same synthetic value',buffer:new ArrayBuffer(8),get custom(){getters++;return 'Same synthetic value';}};
 const f=await fixture(t,`export let lengths;export function App({data}) {const copied=structuredClone(data,{transfer:[data.buffer]});lengths=[data.buffer.byteLength,copied.buffer.byteLength];try{structuredClone(()=>{});}catch(error){calls.push(error.name);}return <p id="getter-clone">{copied.custom}</p>;}`,raw);if(!f)return;f.render();assert.equal(getters,1);assert.deepEqual(Array.from(f.exports.lengths),[0,8]);assert.deepEqual(f.calls,['DataCloneError']);assert.deepEqual(f.fields('getter-clone'),[]);
});

test('installed Connectodot component sources compile after instrumentation',async t=>{
 const root=path.resolve(__dirname,'../../../connectodot'),esbuild=compiler();if(!esbuild||!fs.existsSync(path.join(root,'frontend/src')))return t.skip('Connectodot read-only acceptance fixture is unavailable.');
 const {transformStudio}=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/vite.mjs')).href);let count=0;
 function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else if(/\.[jt]sx?$/.test(file)){const result=transformStudio(fs.readFileSync(file,'utf8'),file,root);if(result){esbuild.transformSync(result,{loader:/\.tsx$/.test(file)?'tsx':/\.ts$/.test(file)?'ts':'jsx',format:'esm'});count++;}}}}
 walk(path.join(root,'frontend/src'));assert.ok(count>80);
});
