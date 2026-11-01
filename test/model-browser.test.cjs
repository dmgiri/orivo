'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {deflateSync}=require('node:zlib');
const {readElementFlow}=require('../engine/element-flow.cjs');

test('manual SDK captures selected ORM evidence from a large response within the page reader limits',async t=>{
  const keys=['location','fetch','__studioElementFlowV1'];
  const saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const key of keys)delete globalThis[key];
  t.after(()=>{for(const key of keys){delete globalThis[key];const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);}});
  const hash='a'.repeat(64),site=(name,line)=>({path:'models.py',name,line,hash}),items=Array.from({length:200},(_,i)=>({label:'Item '+i}));
  const fields=Object.fromEntries(items.map((_,i)=>[`items.${i}.label`,{table:'items',column:'label',model:'Item',attribute:'label',type:'String',nullable:false,queries:['query-1'],modelSource:site('Item',4),fieldSource:site('label',8)}]));
  const queries=[{id:'query-1',sql:'SELECT label FROM items',site:{...site('items',15),path:'api.py'}},{id:'other-query',sql:'SELECT count(*) FROM visits',site:{...site('items',16),path:'api.py'}}];
  let rawBackend,encoded;
  Object.defineProperties(globalThis,{
    location:{value:{href:'http://localhost:7410/items',origin:'http://localhost:7410'},configurable:true},
    fetch:{value:async(input,options)=>{
      rawBackend={id:new Headers(options.headers).get('X-Studio-Trace'),route:{...site('items',12),path:'api.py'},fields,queries};
      encoded='z1.'+deflateSync(Buffer.from(JSON.stringify(rawBackend))).toString('base64');
      return new Response(JSON.stringify({items}),{headers:{'Content-Type':'application/json','Studio-Trace':encoded}});
    },configurable:true}
  });
  const sdk=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/browser.mjs')).href+'?model-budget='+Date.now());
  const response=await sdk.request('/api/items'),selected=response.field('items.0.label'),element={};
  sdk.bind(element,{path:'App.jsx',line:3,hash,name:'App',expression:'item.label',kind:'text'},[selected]);
  const captured=vm.runInNewContext('('+readElementFlow.toString()+')("#item")',{document:{querySelector:()=>element},__studioElementFlowV1:globalThis.__studioElementFlowV1,WeakMap});
  assert.ok(Buffer.byteLength(encoded)<6144);assert.ok(JSON.stringify(rawBackend).length>48000,'The regression includes a valid compressed header that used to exceed page limits');
  assert.ok(captured,'A bounded selected-field capture must survive the expanded model metadata');
  assert.equal(selected.value,'Item 0');assert.deepEqual(Object.keys(captured.dependencies[0].backend.fields),['items.0.label']);
  assert.equal(captured.dependencies[0].backend.fields['items.0.label'].fieldSource.line,8);
  assert.deepEqual(captured.dependencies[0].backend.queries.map(query=>query.id),queries.map(query=>query.id));
  assert.deepEqual(response.dependency().dependencies[0].backend.fields,{});assert.equal(response.dependency().dependencies[0].backend.queries.length,2);
  assert.equal(Object.keys(rawBackend.fields).length,200,'The original backend capture remains unchanged');
});
