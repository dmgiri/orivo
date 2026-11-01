'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const {deflateSync}=require('node:zlib');
const {spawnSync}=require('node:child_process');
const adapter=path.resolve(__dirname,'../adapters/tracing');
const codec=()=>import(pathToFileURL(path.join(adapter,'trace-codec.mjs')).href);
const header=payload=>'z1.'+deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64');
function pooled(id='request_123'){
 const hash='a'.repeat(64);
 return {encoding:'orivo-pool-v1',root:8,pool:[
  [0,{path:'models.py',line:8,name:'Idea',hash}],
  [0,{model:'Idea',table:'ideas',modelSource:[0]}],
  [1,[[1]]],
  [0,{id:'query_123',sql:'SELECT body FROM ideas',site:[0],models:[2],failed:false}],
  [1,[[3]]],
  [1,['query_123']],
  [0,{model:'Idea',table:'ideas',column:'body',attribute:'body',type:'String',nullable:false,queries:[5],modelSource:[0],fieldSource:[0]}],
  [0,{'items.0.body':[6]}],
  [0,{id,route:[0],queries:[4],fields:[7],truncated:false}]
 ]};
}

test('compact metadata restores SQL, ORM sources and shared references without changing legacy traces',async()=>{
 const {unpackTracePayload,decodeTraceHeader}=await codec(),payload=pooled(),trace=unpackTracePayload(payload);
 assert.equal(trace.queries[0].sql,'SELECT body FROM ideas');
 assert.equal(trace.fields['items.0.body'].modelSource.path,'models.py');
 assert.equal(trace.fields['items.0.body'].fieldSource.line,8);
 assert.equal(trace.fields['items.0.body'].nullable,false);
 assert.equal(trace.route,trace.fields['items.0.body'].modelSource,'Source references share bounded immutable transport objects');
 assert.deepEqual(await decodeTraceHeader(header(payload),'request_123'),trace);
 assert.deepEqual(await decodeTraceHeader(Buffer.from(JSON.stringify(trace)).toString('base64'),'request_123'),trace);
 assert.deepEqual(await decodeTraceHeader(header(trace),'request_123'),trace);
 assert.equal(await decodeTraceHeader(header(payload),'another_request'),null);
 const unicode={id:'unicode_request',route:{path:'backend/模型.py',name:'विचार 🚀'},queries:[],fields:{},truncated:false};
 assert.deepEqual(await decodeTraceHeader(header(unicode),unicode.id),unicode);
});

test('malformed compact references, cycles, prototypes and accessors cannot become evidence',async()=>{
 const {unpackTracePayload,decodeTraceHeader}=await codec();
 const bad=[];
 for(const reference of [-1,0,0.5,'0',null])bad.push({encoding:'orivo-pool-v1',root:0,pool:[[0,{id:[reference]}]]});
 bad.push({encoding:'orivo-pool-v1',root:0,pool:[[0,{id:[1]}],[0,{}]]});
 bad.push({encoding:'orivo-pool-v1',root:1,pool:[[0,{}],[1,[]]]});
 bad.push({encoding:'orivo-pool-v2',root:0,pool:[[0,{}]]});
 bad.push({encoding:'orivo-pool-v1',root:0,pool:[[2,{}]]});
 bad.push({encoding:'orivo-pool-v1',root:0,pool:[[0,{id:{nested:true}}]]});
 bad.push(JSON.parse('{"encoding":"orivo-pool-v1","root":0,"pool":[[0,{"__proto__":{"polluted":true}}]]}'));
 bad.push(JSON.parse('{"id":"request_123","nested":{"constructor":{"prototype":{"polluted":true}}}}'));
 for(const payload of bad){assert.throws(()=>unpackTracePayload(payload));assert.equal(await decodeTraceHeader(header(payload),'request_123'),null);}
 let accessed=false;const accessor={id:'request_123'};Object.defineProperty(accessor,'route',{enumerable:true,get(){accessed=true;return {};}});
 assert.throws(()=>unpackTracePayload(accessor));assert.equal(accessed,false);
 const cycle={id:'request_123'};cycle.self=cycle;assert.throws(()=>unpackTracePayload(cycle));
 assert.equal({}.polluted,undefined);
 assert.equal(await decodeTraceHeader('z1.not base64','request_123'),null);
 assert.equal(await decodeTraceHeader('z1.'+deflateSync(Buffer.from([0xff,0xfe])).toString('base64'),'request_123'),null);
});

test('compact expansion has independent depth, logical node, UTF-8 byte and wire limits',async()=>{
 const {unpackTracePayload,decodeTraceHeader}=await codec();
 const repeated={encoding:'orivo-pool-v1',root:2,pool:[[1,Array(300).fill(null)],[1,Array.from({length:300},()=>[0])],[0,{id:'request_123',value:[1]}]]};
 assert.throws(()=>unpackTracePayload(repeated),'Shared subtrees count toward the logical node limit');
 const size={encoding:'orivo-pool-v1',root:1,pool:[[0,{text:'🚀'.repeat(30000)}],[0,{id:'request_123',copies:Array(10).fill(0)}]]};
 // Each encoded child is a reference, never an inline array.
 size.pool.splice(1,0,[1,Array.from({length:10},()=>[0])]);size.root=2;size.pool[2][1].copies=[1];
 assert.throws(()=>unpackTracePayload(size),'UTF-8 bytes are charged every time a shared value is referenced');
 const deep={encoding:'orivo-pool-v1',root:20,pool:[[0,{id:'request_123'}]]};for(let index=1;index<=20;index++)deep.pool.push([0,{child:[index-1]}]);
 assert.throws(()=>unpackTracePayload(deep));
 assert.equal(await decodeTraceHeader(header({id:'request_123',padding:'x'.repeat(300001)}),'request_123'),null);
 assert.equal(await decodeTraceHeader('A'.repeat(24001),'request_123'),null);
 const legacy={id:'request_123',value:'x'.repeat(300001)};assert.throws(()=>unpackTracePayload(legacy));
});

test('manual and automatic browser adapters retain compact query and model evidence for the selected field',async t=>{
 const keys=['window','location','fetch','__studioElementFlowV1','__studioElementFlowPendingV1'];
 const saved=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const key of keys)delete globalThis[key];
 t.after(()=>{for(const key of keys){delete globalThis[key];const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);}});
 Object.defineProperties(globalThis,{
  window:{value:{},configurable:true},
  location:{value:{href:'http://localhost:7410/ideas',origin:'http://localhost:7410'},configurable:true},
  fetch:{value:async(input,options)=>new Response('{"items":[{"body":"Application response stays intact"}]}',{headers:{'Content-Type':'application/json','Studio-Trace':header(pooled(new Headers(options.headers).get('X-Studio-Trace')))}}),configurable:true,writable:true}
 });
 const manual=await import(pathToFileURL(path.join(adapter,'browser.mjs')).href+'?compact='+Date.now());
 const response=await manual.request('/api/ideas'),selected=response.field('items.0.body');
 assert.equal(selected.value,'Application response stays intact');assert.equal(selected.dependencies[0].backend.queries.length,1);assert.equal(selected.dependencies[0].backend.fields['items.0.body'].model,'Idea');
 delete globalThis.__studioElementFlowV1;
 const automatic=await import(pathToFileURL(path.join(adapter,'runtime.mjs')).href+'?compact='+Date.now());
 const detach=automatic.installFetch();t.after(detach);
 const result=await fetch('/api/ideas'),body=await result.json(),element={};let mount;
 automatic.element({path:'Idea.jsx'},ref=>{automatic.read(body.items[0],'body');mount=ref;return 'rendered';},false);mount(element);
 const dependency=globalThis.__studioElementFlowV1.get(element).dependencies[0];
 await globalThis.__studioElementFlowPendingV1.get(dependency.request.id);
 assert.equal(dependency.field,'items.0.body');assert.equal(dependency.backend.queries[0].models[0].modelSource.path,'models.py');assert.equal(dependency.backend.fields['items.0.body'].fieldSource.line,8);
});

test('Vite resolves the shared decoder for its virtual runtime and the demo serves its manual SDK dependency',async t=>{
 const {default:createPlugin}=await import(pathToFileURL(path.join(adapter,'vite.mjs')).href),plugin=createPlugin({enabled:true});
 await plugin.configResolved({root:path.resolve(__dirname,'..'),command:'serve',isProduction:false});
 const runtime=plugin.resolveId('virtual:studio-tracing'),runtimeCode=await plugin.load(runtime);
 assert.match(runtimeCode,/from "virtual:studio-managed-trace"/);
 const managed=plugin.resolveId('virtual:studio-managed-trace');assert.match(await plugin.load(managed),/from "virtual:studio-trace-codec"/);assert.match(await plugin.load(managed),/export async function resolveTraceResponse/);
 const decoder=plugin.resolveId('virtual:studio-trace-codec');assert.match(await plugin.load(decoder),/export async function decodeTraceHeader/);
 const {startDemo}=require('../demo/server.cjs'),demo=await startDemo();t.after(()=>demo.close());
 const response=await fetch(demo.url+'/trace/trace-codec.mjs');assert.equal(response.status,200);assert.match(await response.text(),/export async function decodeTraceHeader/);
 assert.equal((await fetch(demo.url+'/trace/unknown.mjs')).status,404);
});

test('a real Python trace carries all 20 queries and 200 ORM origins through a default HTTP proxy',async t=>{
 const candidates=[process.env.ORIVO_FIXTURE_PYTHON,path.resolve(__dirname,'../../physio-clinic/backend/.venv/Scripts/python.exe'),path.resolve(__dirname,'../../physio-clinic/backend/.venv/bin/python')].filter(Boolean);
 const python=candidates.find(file=>fs.existsSync(file));if(!python){t.skip('An installed Python fixture environment is required');return;}
 const script=`import base64,json,sys,zlib
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path('test').resolve()))
from test_python_header_bounds import large_orm_payload
import studio_tracing as studio
payload=large_orm_payload()
trace=studio.Trace(Path.cwd(),payload['id'],_sources={})
trace.route=payload['route'];trace.queries=payload['queries'];trace.fields=payload['fields']
encoded=trace.header()
wire=json.loads(zlib.decompress(base64.b64decode(encoded[3:])))
legacy='z1.'+base64.b64encode(zlib.compress(json.dumps(payload,separators=(',',':')).encode())).decode()
print(json.dumps({'header':encoded,'expected':payload,'encoding':wire.get('encoding'),'legacyBytes':len(legacy)}))`;
 const result=spawnSync(python,['-B','-c',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:20000,maxBuffer:3*1024*1024,windowsHide:true});
 assert.equal(result.status,0,result.stderr);const fixture=JSON.parse(result.stdout);
 assert.equal(fixture.encoding,'orivo-pool-v1');assert.ok(fixture.legacyBytes>6144);assert.ok(Buffer.byteLength(fixture.header)<=6144);
 const upstream=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.setHeader('Studio-Trace',fixture.header);response.end('{"ok":true}');});
 let upstreamPort;
 const proxy=http.createServer((request,response)=>{
  const forwarded=http.get({hostname:'127.0.0.1',port:upstreamPort,path:'/'},received=>{response.writeHead(received.statusCode,received.headers);received.pipe(response);});
  forwarded.on('error',error=>{response.statusCode=502;response.end(error.code||error.message);});
 });
 t.after(async()=>{for(const server of [proxy,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));upstreamPort=upstream.address().port;
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const response=await fetch('http://127.0.0.1:'+proxy.address().port+'/');assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 const {decodeTraceHeader}=await codec(),trace=await decodeTraceHeader(response.headers.get('Studio-Trace'),fixture.expected.id);
 assert.ok(trace,'The Python compact wire format must decode in the browser adapter');
 assert.equal(trace.queries.length,20);assert.equal(Object.keys(trace.fields).length,200);assert.equal(trace.truncated,false);
 assert.deepEqual(trace.route,fixture.expected.route);assert.deepEqual(trace.queries,fixture.expected.queries);assert.deepEqual(trace.fields,fixture.expected.fields);
 assert.equal(trace.fields['items.19.field9'].fieldSource.line,59,'The final row retains its exact model field source');
});
