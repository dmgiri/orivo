'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const adapter=path.resolve(__dirname,'../adapters/tracing');
const load=name=>import(pathToFileURL(path.join(adapter,name)).href);
const id='managed_request_123',key='a'.repeat(32),token='backend_ready_token_12345';
const encoded=()=>Buffer.from(JSON.stringify({id,ref:'orivo-managed-v1',key})).toString('base64');
async function serve(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return 'http://127.0.0.1:'+server.address().port;}

test('managed transport retains 256 actual executions outside the response header',async t=>{
 const {managedTraceProxy}=await load('managed-trace-proxy.mjs');
 const {resolveTraceResponse}=await load('managed-trace.mjs');
 const payload={id,route:{path:'backend.py',line:1,hash:'b'.repeat(64)},queries:Array.from({length:256},(_,index)=>({id:'query_'+index,sql:'SELECT body FROM messages',frames:Array.from({length:12},()=>({path:'backend.py',line:1,hash:'b'.repeat(64)}))})),fields:{'items.19.body':{table:'messages',column:'body',model:'Message',queries:['query_255']}},truncated:false};
 assert.ok(JSON.stringify(payload).length>300000);
 let seen;
 const backend=await serve(t,(request,response)=>{seen={path:request.url,cookie:request.headers.cookie,authorization:request.headers.authorization};response.setHeader('content-type','application/json');response.end(JSON.stringify(payload));});
 const proxy=managedTraceProxy({backendUrl:backend,backendTraceToken:token});
 const frontend=await serve(t,(request,response)=>{if(!proxy(request,response)){response.statusCode=404;response.end();}});
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:new URL(frontend),configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'location',descriptor);else delete globalThis.location;});
 const result=await resolveTraceResponse(new Response('{}',{headers:{'Studio-Trace':encoded()}}),id);
 assert.deepEqual(result,payload);assert.equal(result.queries.at(-1).id,'query_255');
 assert.deepEqual(seen,{path:'/__orivo_trace/'+token+'/'+key,cookie:undefined,authorization:undefined});
 assert.ok(encoded().length<200);
 for(const [url,method] of [['/__orivo_trace/'+key+'?other=1','GET'],['/__orivo_trace/invalid','GET'],['/__orivo_trace/'+key,'POST']])assert.equal((await fetch(frontend+url,{method})).status,404);
});

test('managed metadata remains correlated and rejects malformed, expired and oversized captures',async t=>{
 const {resolveTraceResponse,validateManagedTrace}=await load('managed-trace.mjs');
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:new URL('http://localhost:5173'),configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'location',descriptor);else delete globalThis.location;});
 const response=()=>new Response('{}',{headers:{'Studio-Trace':encoded()}});
 assert.equal(await resolveTraceResponse(response(),id,{fetcher:async()=>new Response(JSON.stringify({id:'another_request'}))}),null);
 assert.equal(await resolveTraceResponse(response(),id,{fetcher:async()=>new Response('{}',{status:404})}),null);
 assert.equal(await resolveTraceResponse(response(),id,{fetcher:async()=>new Response('x'.repeat(2*1024*1024+1))}),null);
 assert.throws(()=>validateManagedTrace(JSON.parse('{"id":"managed_request_123","__proto__":{}}'),id));
 const getter={id};Object.defineProperty(getter,'field',{enumerable:true,get(){throw Error('Accessor executed');}});assert.throws(()=>validateManagedTrace(getter,id),/Invalid trace property/);
 const cycle={id};cycle.self=cycle;assert.throws(()=>validateManagedTrace(cycle,id),/budget/);
 const legacy={id,queries:[],fields:{}};assert.deepEqual(await resolveTraceResponse(new Response('{}',{headers:{'Studio-Trace':Buffer.from(JSON.stringify(legacy)).toString('base64')}}),id,{fetcher:()=>{throw Error('Legacy capture must not request a lookup');}}),legacy);
});

test('metadata lookups reserve at most two connections and release their slot after errors',async t=>{
 const {resolveTraceResponse}=await load('managed-trace.mjs');
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:new URL('http://localhost:5173'),configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'location',descriptor);else delete globalThis.location;});
 let active=0,maximum=0,started=0;const gates=[];
 const fetcher=async(_url,options)=>{assert.equal(options.priority,'low');active++;maximum=Math.max(maximum,active);const index=started++;await new Promise(resolve=>gates.push(resolve));active--;if(index===0)throw Error('Lookup failed');return new Response(JSON.stringify({id,queries:[],fields:{}}));};
 const results=Array.from({length:6},()=>resolveTraceResponse(new Response('{}',{headers:{'Studio-Trace':encoded()}}),id,{fetcher}));
 const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();assert.equal(started,2);
 while(started<6||gates.length){const batch=gates.splice(0);for(const release of batch)release();await tick();}
 const captures=await Promise.all(results);assert.equal(maximum,2);assert.equal(captures[0],null);assert.equal(captures.filter(Boolean).length,5);
});

test('native reader and host engine preserve a late query in a large proven binding',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),vm=require('node:vm');
 const engine=require('../engine/index.cjs'),{readElementFlow}=require('../engine/element-flow.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orivo-large-reader-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'App.jsx'),'export default function App(){return <p>Value</p>}\n');
 await fs.writeFile(path.join(root,'backend.py'),'def route():\n    return None\n');
 const index=await engine.indexRepository(root),site=name=>({path:name,line:1,hash:index.files.find(file=>file.path===name).hash});
 const url='http://localhost:5173/',backend={id,route:site('backend.py'),queries:Array.from({length:256},(_,i)=>({id:'query_'+i,sql:'SELECT body FROM messages',site:site('backend.py'),frames:[site('backend.py')],failed:false})),fields:{body:{table:'messages',column:'body',model:null,queries:['query_255']}}};
 const trace={version:1,url,mode:'data',source:{...site('App.jsx'),kind:'p',expression:'<p>{data.body}</p>'},dependencies:[{field:'body',request:{id,method:'GET',url:url+'api/messages',status:200},backend}]};
 assert.ok(JSON.stringify(trace).length>48000);
 const element={},map=new WeakMap([[element,trace]]);
 const captured=vm.runInNewContext('('+readElementFlow.toString()+')("#body")',{document:{querySelector:()=>element},__studioElementFlowV1:map});
 assert.ok(captured);assert.equal(captured.dependencies[0].backend.queries.length,256);
 const graph=engine.resolveTrace({index,url,trace:captured,target:{selector:'#body',label:'Value'},runtimeAvailable:true});
 assert.equal(graph.coverage,'complete');assert.equal(graph.summary.queries,256);assert.ok(graph.nodes.some(node=>node.kind==='database'&&node.label==='messages.body'));
});

test('owned Node memory store bounds capacity, lifetime and bytes without writing files',()=>{
 const {ManagedTraceStore}=require('../adapters/tracing/managed-trace-store.cjs'),store=new ManagedTraceStore();
 const first=store.publish(JSON.stringify({id}));assert.match(first,/^[a-f0-9]{32}$/);
 for(let i=0;i<256;i++)store.publish(JSON.stringify({id:id+'_'+i}));assert.equal(store.get(first),null);
 assert.equal(store.publish(JSON.stringify({id,extra:'x'.repeat(2*1024*1024)})),null);
 assert.equal(store.publish('invalid JSON'),null);assert.equal(store.get('../'+first),null);
 const current=store.publish(JSON.stringify({id}));store.entries.get(current).created-=91000;assert.equal(store.get(current),null);
 store.close();assert.equal(store.entries.size,0);assert.equal(store.bytes,0);
});
