'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
let respond;
const delegatedFetch=(...args)=>respond(...args);
async function fixture(t,data={items:[{title:'Synthetic title'},{title:'Synthetic title'}]}){
 const keys=['window','location','fetch','__studioElementFlowV1','__studioElementFlowPendingV1'],saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const key of keys)delete globalThis[key];
 globalThis.window={};globalThis.location={href:'http://localhost:7410/',origin:'http://localhost:7410'};globalThis.fetch=delegatedFetch;
 let resolveLookup,rejectLookup,id,lookups=0;
 const lookup=new Promise((resolve,reject)=>{resolveLookup=resolve;rejectLookup=reject;});
 respond=async(input,options)=>{const address=new URL(String(input),location.href);if(address.pathname.startsWith('/__orivo_trace/')){lookups++;return lookup;}id=new Headers(options.headers).get('X-Studio-Trace');return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Studio-Trace':Buffer.from(JSON.stringify({id,ref:'orivo-managed-v1',key:'a'.repeat(32)})).toString('base64')}});};
 const flow=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/runtime.mjs')).href+'?enrichment='+Date.now()+Math.random()),detach=flow.installFetch();
 t.after(async()=>{resolveLookup(new Response('{}',{status:404}));await Promise.allSettled([...globalThis.__studioElementFlowPendingV1.values()]);detach();for(const key of keys){delete globalThis[key];const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);}});
 function bind(read){const element={};let ref;flow.element({path:'App.jsx',line:1,hash:'a'.repeat(64),kind:'p',expression:'selected'},mount=>{ref=mount;read();return null;},false);ref(element);return globalThis.__studioElementFlowV1.get(element);}
 const body=await Promise.race([fetch('/api/items').then(response=>response.json()),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Application JSON waited for optional trace metadata')),1000);timer.unref?.();})]);
 return {flow,body,bind,id:()=>id,lookups:()=>lookups,resolve:payload=>resolveLookup(new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}})),reject:rejectLookup,pending:()=>globalThis.__studioElementFlowPendingV1.get(id)};
}
const backend=id=>({id,route:{path:'api.py',line:1,hash:'b'.repeat(64),name:'items'},queries:[{id:'query_one',sql:'SELECT title FROM items'},{id:'query_other',sql:'SELECT count(*) FROM visits'}],fields:{'items.0.title':{table:'items',column:'title',model:'Item',queries:['query_one']},'items.1.title':{table:'items',column:'title',model:'Item',queries:['query_one']}}});
const collectionWitness=(count=2,queries=['query_one'])=>({queries,count,source:{path:'api.py',line:9,hash:'c'.repeat(64),name:'serialize_items'}});

test('slow metadata never delays app JSON and enriches mounted field, clone and collection records without rerender',async t=>{
 const f=await fixture(t);assert.equal(f.body.items[0].title,'Synthetic title');
 const field=f.bind(()=>f.flow.optionalChain(f.body,[[false,()=> 'items'],[false,()=>0],[false,()=> 'title']]));
 const copied=f.flow.clone(structuredClone,()=>[f.body]),cloned=f.bind(()=>f.flow.optionalChain(copied,[[false,()=> 'items'],[false,()=>1],[false,()=> 'title']]));
 const mapped=f.flow.arrayCall(()=>f.body.items,'map',()=>[row=>f.flow.read(row,'title')]),count=f.bind(()=>f.flow.read(mapped,'length'));
 for(const record of [field,cloned,count])assert.equal(record.dependencies[0].pending,true);
 assert.equal(field.dependencies[0].backend,null);assert.equal(cloned.dependencies[0].backend,null);assert.equal(count.dependencies[0].backend,null);
 const pending=f.pending();assert.ok(pending instanceof Promise);f.resolve(backend(f.id()));await pending;
 for(const record of [field,cloned,count])assert.equal(record.dependencies[0].pending,false);
 assert.deepEqual(field.dependencies[0].backend.queries.map(query=>query.id),['query_one']);assert.deepEqual(cloned.dependencies[0].backend.queries.map(query=>query.id),['query_one']);
 assert.equal(count.dependencies[0].collection,true);assert.equal(count.dependencies[0].field,'items');assert.deepEqual(count.dependencies[0].backend.fields,{});assert.equal(count.dependencies[0].backend.queries.length,2);
 assert.equal(f.pending(),undefined);assert.equal(f.lookups(),1);
});

test('missing or rejected metadata preserves the successful body and clears relevant pending state',async t=>{
 const f=await fixture(t),record=f.bind(()=>f.flow.read(f.body,'items')),pending=f.pending();assert.equal(record.dependencies[0].pending,true);f.reject(Error('Synthetic lookup unavailable'));await pending;
 assert.equal(f.body.items.length,2);assert.equal(record.dependencies[0].backend,null);assert.equal(record.dependencies[0].pending,false);assert.equal(f.pending(),undefined);
});

test('late mismatched metadata cannot enrich another request',async t=>{
 const f=await fixture(t),record=f.bind(()=>f.flow.read(f.body,'items')),pending=f.pending();f.resolve(backend('different_trace_12345'));await pending;assert.equal(record.dependencies[0].backend,null);assert.equal(record.dependencies[0].pending,false);
});

test('the twelve-field capture boundary stays explicit after late metadata enrichment',async t=>{
 const data=Object.fromEntries(Array.from({length:14},(_,index)=>['field'+index,'Same synthetic value'])),f=await fixture(t,data),record=f.bind(()=>{for(const key of Object.keys(f.body))f.flow.read(f.body,key);});
 assert.equal(record.dependencies.length,12);assert.ok(record.dependencies.every(row=>row.truncated===true&&row.pending===true));const pending=f.pending();f.resolve({...backend(f.id()),fields:{}});await pending;
 assert.ok(record.dependencies.every(row=>row.truncated===true&&row.pending===false&&row.backend.id===f.id()));
});

test('flat JSON fields and derived pending rows have a bounded explicit capture budget',async t=>{
 const data=Object.fromEntries(Array.from({length:12050},(_,index)=>['field'+index,'Same synthetic value'])),f=await fixture(t,data),first=f.bind(()=>f.flow.read(f.body,'field0')),omitted=f.bind(()=>f.flow.read(f.body,'field12049'));
 assert.equal(Object.keys(f.body).length,12050);assert.equal(first.dependencies[0].truncated,true);assert.equal(omitted.dependencies.length,0);
 const pending=f.pending();f.resolve({...backend(f.id()),fields:{}});await pending;assert.equal(first.dependencies[0].pending,false);assert.equal(first.dependencies[0].truncated,true);
});

test('a flood of derived collection rows cannot retain unlimited pending state',async t=>{
 const f=await fixture(t),mapped=[];for(let index=0;index<12100;index++)mapped.push(f.flow.arrayCall(()=>f.body.items,'map',()=>[row=>f.flow.read(row,'title')]));const first=f.bind(()=>f.flow.read(mapped[0],'length')),last=f.bind(()=>f.flow.read(mapped.at(-1),'length'));
 assert.equal(first.dependencies[0].truncated,true);assert.equal(last.dependencies[0].truncated,true);assert.equal(last.dependencies[0].pending,false);
 const pending=f.pending();f.resolve(backend(f.id()));await pending;assert.equal(first.dependencies[0].pending,false);assert.equal(last.dependencies[0].backend,null);
});

test('actual collection witnesses enrich pending and already settled derived rows by exact path',async t=>{
 const f=await fixture(t),before=f.flow.arrayCall(()=>f.body.items,'map',()=>[row=>f.flow.read(row,'title')]),pendingCount=f.bind(()=>f.flow.read(before,'length')),field=f.bind(()=>f.flow.optionalChain(f.body,[[false,()=> 'items'],[false,()=>0],[false,()=> 'title']])),pending=f.pending();
 const payload={...backend(f.id()),collections:{items:collectionWitness(),unrelated:collectionWitness(98,['query_other'])}};f.resolve(payload);await pending;
 assert.deepEqual(pendingCount.dependencies[0].backend.collections,{items:collectionWitness()});assert.deepEqual(pendingCount.dependencies[0].backend.fields,{});assert.deepEqual(pendingCount.dependencies[0].backend.queries.map(query=>query.id),['query_one']);assert.deepEqual(field.dependencies[0].backend.collections,{});
 const after=f.flow.arrayCall(()=>f.body.items,'map',()=>[row=>f.flow.read(row,'title')]),settledCount=f.bind(()=>f.flow.read(after,'length'));assert.deepEqual(settledCount.dependencies[0].backend.collections,{items:collectionWitness()});assert.deepEqual(settledCount.dependencies[0].backend.queries.map(query=>query.id),['query_one']);
});

test('empty collection witnesses survive native append and missing or invalid membership never gains proof',async t=>{
 const f=await fixture(t,{items:[],unrelatedCount:1}),pending=f.pending();f.resolve({...backend(f.id()),collections:{items:collectionWitness(0),'':collectionWitness(99,['not_executed_query'])}});await pending;
 const direct=f.bind(()=>f.flow.read(f.body.items,'length'));assert.deepEqual(direct.dependencies[0].operations,['length']);assert.deepEqual(direct.dependencies[0].backend.collections,{items:collectionWitness(0)});assert.equal(direct.dependencies[0].backend.queries[0].id,'query_one');
 const target=f.flow.array([]);f.flow.arrayCall(()=>target,'push',()=>[...f.flow.arraySpread(()=>f.flow.read(f.body,'items'))]);const record=f.bind(()=>f.flow.read(target,'length')),matched=record.dependencies.find(row=>row.field==='items');assert.ok(record.dependencies.every(row=>row.field!==null));
 f.flow.arrayCall(()=>target,'push',()=>[f.flow.arrayArgument(()=>f.flow.read(f.body,'unrelatedCount'),true)]);const after=f.bind(()=>f.flow.read(target,'length')).dependencies;
 assert.deepEqual(matched.backend.collections,{items:collectionWitness(0)});assert.equal(matched.backend.queries.length,1);assert.ok(after.every(row=>row.field==='items'));
});

test('redundant container reads transfer safety flags without erasing independent scalar controls',async t=>{
 const f=await fixture(t,{items:[{title:'Synthetic'}],threshold:null}),pending=f.pending();f.resolve({...backend(f.id()),collections:{items:collectionWitness(1)}});await pending;
 const container=f.bind(()=>f.flow.read(f.body,'items')).dependencies[0];container.collectionUnknown=true;container.truncated=true;
 const target=f.flow.array([]);f.flow.conditionalAppend(()=>f.flow.nullish(()=>f.flow.read(f.body,'threshold'),()=>1,{path:'App.jsx',line:1,hash:'a'.repeat(64)},true),()=>f.flow.arrayCall(()=>target,'push',()=>[...f.flow.arraySpread(()=>f.flow.read(f.body,'items'))]),()=>target,true);const rows=f.bind(()=>f.flow.read(target,'length')).dependencies,actual=rows.find(row=>row.field==='items');assert.equal(actual.collectionUnknown,true);assert.equal(actual.truncated,true);assert.ok(rows.some(row=>row.field===null&&row.role==='control'));
});
