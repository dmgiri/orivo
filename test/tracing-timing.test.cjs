'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

async function browserFixture(t,module){
  const keys=['window','location','performance','fetch','__studioElementFlowV1'];
  const saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let clock=0,lastHeaders;
  for(const key of keys)delete globalThis[key];
  Object.defineProperties(globalThis,{
    window:{value:{},configurable:true},
    location:{value:{href:'http://localhost:7410/items',origin:'http://localhost:7410'},configurable:true},
    performance:{value:{now:()=>clock},configurable:true},
    fetch:{value:async(input,options)=>{
      lastHeaders=new Headers(options?.headers);clock+=11;
      const response=new Response('{"amount":3}',{status:200,headers:{'Content-Type':'application/json'}});
      const json=response.json;
      Object.defineProperty(response,'json',{value:async function(){clock+=200;return json.call(this);},configurable:true});
      return response;
    },configurable:true,writable:true}
  });
  t.after(()=>{for(const key of keys){delete globalThis[key];const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);}});
  const sdk=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/'+module)).href+'?timing='+Date.now()+Math.random());
  return {sdk,lastHeaders:()=>lastHeaders,clock:()=>clock};
}

test('manual browser request timing stops at headers before JSON parsing and retains no response scalar values',async t=>{
  const {sdk,clock,lastHeaders}=await browserFixture(t,'browser.mjs');
  const result=await sdk.request('/api/items');
  assert.equal(result.data.amount,3);assert.equal(clock(),211);
  const dependency=result.field('amount').dependencies[0];
  assert.equal(dependency.request.durationMs,11);assert.equal(dependency.request.status,200);
  assert.equal(lastHeaders().get('X-Studio-Trace'),dependency.request.id);
  assert.equal(dependency.value,undefined);assert.equal(dependency.request.amount,undefined);
});

test('automatic browser timing survives response cloning and is collected with the selected field',async t=>{
  const {sdk}=await browserFixture(t,'runtime.mjs');
  const detach=sdk.installFetch();t.after(detach);
  const response=await fetch('/api/items'),copy=response.clone();
  const body=await response.json(),cloned=await copy.json();
  for(const value of [body,cloned]){
    const element={};let mount;
    sdk.element({path:'Item.tsx'},ref=>{sdk.read(value,'amount');mount=ref;return 'rendered';},false);
    mount(element);
    const trace=globalThis.__studioElementFlowV1.get(element);
    assert.equal(trace.dependencies[0].request.durationMs,11);
    assert.equal(trace.dependencies[0].field,'amount');
    assert.equal(trace.dependencies[0].request.amount,undefined);
  }
});
