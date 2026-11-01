'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {traceToDiagram}=require('../trace-to-diagram.cjs');
const {createDiagramStudio}=require('../diagram-studio.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
test('presentation retains the actual captured graph without inventing relationships or coverage',()=>{
 const graph={id:'trace-test',title:'Price',capturedAt:'2026-10-31T10:00:00Z',coverage:'partial',nodes:[{id:'element-1',kind:'element',label:'Price'},{id:'source-2',kind:'source',label:'Price.jsx',file:'src/Price.jsx',line:4},{id:'gap-3',kind:'gap',label:'Origin missing',detail:'Column lineage is unproven'}],edges:[{id:'a',from:'element-1',to:'source-2',label:'rendered by'},{id:'b',from:'source-2',to:'gap-3',label:'missing evidence',status:'missing'}],gaps:['Column lineage is unproven']};
 const diagram=traceToDiagram(graph);
 assert.deepEqual(new Set(diagram.components.map(node=>node.id)),new Set(graph.nodes.map(node=>node.id)));
 assert.deepEqual(diagram.connections.map(edge=>[edge.from,edge.to]),graph.edges.map(edge=>[edge.from,edge.to]));
 assert.match(diagram.meta.subtitle,/partial/);assert.ok(JSON.stringify(diagram.cards).includes('Column lineage is unproven'));
 assert.match(diagram.cards[0].items.join(' '),/adds no runtime evidence/);
 assert.throws(()=>traceToDiagram(null),/Capture an element/);
});
test('a captured request chain passes original Archify geometry validation',async t=>{
 const base=path.resolve(__dirname,'../.tmp');await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'trace-projection-'));
 const studio=createDiagramStudio({runtimeDirectory:directory});t.after(async()=>{await studio.close();assert.equal(path.dirname(directory),base);await fs.rm(directory,{recursive:true,force:true});});
 const nodes=['element','source','api','backend','query','database'].map((kind,i)=>({id:kind+'-'+i,kind,label:kind==='api'?'GET /api/catalog':kind}));
 const labels=['rendered by','reads products.0.price','handled by','executes','maps to column'];
 const graph={id:'captured-chain',title:'Price',coverage:'complete',nodes,edges:nodes.slice(1).map((node,i)=>({from:nodes[i].id,to:node.id,label:labels[i]}))};
 const rendered=await studio.render({type:'architecture',text:JSON.stringify(traceToDiagram(graph)),preset:'editorial'});assert.equal(rendered.receipt.ok,true);
});
