'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {inflateSync}=require('node:zlib');
const {detectNode}=require('../adapters/tracing/auto-node-detect.cjs');
const preload=path.resolve(__dirname,'../adapters/tracing/auto-node.cjs');
const temporaryRoot=path.resolve(__dirname,'../.tmp');
const closeProcesses=new Map();
function folder(t) {fs.mkdirSync(temporaryRoot,{recursive:true});const root=fs.mkdtempSync(path.join(temporaryRoot,'auto-node-')); t.after(async()=>{await closeProcesses.get(root)?.();closeProcesses.delete(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return root;}
function decode(value) {assert.ok(value);assert.ok(value.length<=6144);return JSON.parse(value.startsWith('z1.')?inflateSync(Buffer.from(value.slice(3),'base64')):Buffer.from(value,'base64'));}
async function freePort() {const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function launch(t,root,source,extension='cjs',ipc=false) {
  const file=path.join(root,'server.'+extension);fs.writeFileSync(file,source);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{dev:'node server.'+extension}}));
  const port=await freePort(), token=randomUUID(), config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({root,port,host:'127.0.0.1',readyToken:token,parentPid:process.pid}));
  const env={...process.env,ORIVO_AUTO_NODE_CONFIG:config};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(process.execPath,['--require',preload,file],{cwd:root,env,stdio:['ignore','pipe','pipe',...(ipc?['ipc']:[])],windowsHide:true});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  closeProcesses.set(root,async()=>{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000).unref();});});
  const base='http://127.0.0.1:'+port;
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(errors);try {const response=await fetch(base+'/__orivo_managed_ready/'+token);if(await response.text()===token){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
  assert.ok(ready,errors||'managed server failed to become ready');return {base,file,child};
}
const cjs=`const http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE records(id INTEGER, label TEXT, amount INTEGER);INSERT INTO records VALUES(1,'PRIVATE-ONE',7),(2,'PRIVATE-TWO',7)");
async function route(request,response) {
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/early') response.writeHead(202,{'Content-Type':'application/json'});
  const id=Number(url.searchParams.get('id')||1);
  await new Promise(resolve=>setTimeout(resolve,id===1?8:2));
  const rows=db.prepare('SELECT id,label,amount FROM records WHERE id = ?').all(id);
  let result={items:rows};
  if(url.pathname==='/copied')result={items:rows.map(row=>({label:row.label,amount:row.amount}))};
  if(url.pathname==='/mutated')rows[0].amount+=1;
  if(url.pathname==='/literal')result={items:[{label:'PRIVATE-ONE',amount:7}]};
  if(url.pathname==='/get')result={item:db.prepare('SELECT label FROM records WHERE id = ?').get(id)};
  response.setHeader('X-App-Status','preserved');
  response.end(JSON.stringify(result));
}
http.createServer((request,response)=>route(request,response).catch(error=>{response.statusCode=500;response.end(error.message)})).listen(0,'127.0.0.1');
`;
test('automatic Node detection only accepts safe static direct entry recipes',async t=>{
 const root=folder(t);fs.mkdirSync(path.join(root,'backend'));
 fs.writeFileSync(path.join(root,'backend/package.json'),JSON.stringify({dependencies:{express:'^5.0.0'},scripts:{dev:'node server.cjs'}}));fs.writeFileSync(path.join(root,'backend/server.cjs'),cjs);
 const candidates=await detectNode(root,null,{node:process.execPath});assert.equal(candidates.length,1);assert.equal(candidates[0].directory,'backend');assert.equal(candidates[0].node,process.execPath);assert.equal(candidates[0].entry,path.join(root,'backend/server.cjs'));assert.deepEqual(candidates[0].arguments,[]);
 fs.writeFileSync(path.join(root,'backend/package.json'),JSON.stringify({dependencies:{express:'^5.0.0'},scripts:{dev:'node server.cjs && node malicious.cjs'}}));
 // Unsafe scripts do not cause an executable to be inferred via conventional names.
 assert.deepEqual(await detectNode(root),[]);
 fs.writeFileSync(path.join(root,'backend/package.json'),JSON.stringify({scripts:{start:'node server.cjs'}}));fs.appendFileSync(path.join(root,'backend/server.cjs'),'\nhttp.createServer().listen(8123);');assert.deepEqual(await detectNode(root),[]);
});
test('automatic preload traces unmodified HTTP and SQLite rows without exposing parameter values',async t=>{
 const root=folder(t),{base}=await launch(t,root,cjs);
 const ordinary=await fetch(base+'/');assert.equal(ordinary.headers.get('studio-trace'),null);assert.equal((await ordinary.json()).items[0].label,'PRIVATE-ONE');
 const response=await fetch(base+'/?id=2',{headers:{'X-Studio-Trace':'auto-test-12345'}});assert.equal(response.status,200);assert.equal(response.headers.get('x-app-status'),'preserved');assert.equal((await response.json()).items[0].label,'PRIVATE-TWO');
 const trace=decode(response.headers.get('studio-trace'));assert.equal(trace.id,'auto-test-12345');assert.equal(trace.queries.length,1);assert.equal(trace.queries[0].sql,'SELECT id,label,amount FROM records WHERE id = ?');assert.equal(trace.route.path,'server.cjs');assert.equal(trace.fields['items.0.label'].table,'records');assert.equal(trace.fields['items.0.label'].column,'label');assert.equal(trace.fields['items.0.amount'].column,'amount');assert.doesNotMatch(JSON.stringify(trace),/PRIVATE-|parameters/);
 assert.ok(Number.isFinite(trace.durationMs)&&trace.durationMs>=0);
 assert.ok(Number.isFinite(trace.queries[0].durationMs)&&trace.queries[0].durationMs>=0);
 assert.ok(trace.queries[0].startOffsetMs>=0&&trace.queries[0].startOffsetMs+trace.queries[0].durationMs<=trace.durationMs);
 const get=await fetch(base+'/get',{headers:{'X-Studio-Trace':'auto-test-12346'}}),getTrace=decode(get.headers.get('studio-trace'));assert.equal(getTrace.fields['item.label'].column,'label');assert.equal(getTrace.queries.length,2);
});
test('automatic provenance rejects copied, mutated, equal-value and stale-source claims',async t=>{
 const root=folder(t),{base,file}=await launch(t,root,cjs);
 for(const route of ['/copied','/literal']){const response=await fetch(base+route,{headers:{'X-Studio-Trace':'auto-negative-1234'}});await response.text();const trace=decode(response.headers.get('studio-trace'));assert.deepEqual(trace.fields,{});assert.equal(trace.queries.length,1);}
 const mutated=await fetch(base+'/mutated',{headers:{'X-Studio-Trace':'auto-negative-1235'}}),mutationTrace=decode(mutated.headers.get('studio-trace'));assert.equal(mutationTrace.fields['items.0.amount'],undefined);assert.equal(mutationTrace.fields['items.0.label'].column,'label');
 fs.appendFileSync(file,'\n// source changed after application startup\n');const stale=await fetch(base+'/',{headers:{'X-Studio-Trace':'auto-negative-1236'}});await stale.text();const staleTrace=decode(stale.headers.get('studio-trace'));assert.deepEqual(staleTrace.fields,{});assert.equal(staleTrace.route,null);assert.equal(staleTrace.queries[0].site,null);
});
test('concurrent automatic requests keep query and row origins isolated',async t=>{
 const root=folder(t),{base}=await launch(t,root,cjs);
 const traces=await Promise.all([1,2,1,2].map(async(id,index)=>{const traceId='automatic-concurrency-'+index,response=await fetch(base+'/?id='+id,{headers:{'X-Studio-Trace':traceId}}),body=await response.json(),trace=decode(response.headers.get('studio-trace'));assert.equal(trace.id,traceId);assert.equal(body.items[0].id,id);assert.equal(trace.fields['items.0.label'].queries[0],trace.queries[0].id);return trace;}));
 assert.equal(new Set(traces.map(trace=>trace.queries[0].id)).size,4);
});
test('ES module HTTP and built-in SQLite imports use the automatic preload',async t=>{
 const root=folder(t),source=cjs.replace("const http=require('node:http');","import http from 'node:http';").replace("const {DatabaseSync}=require('node:sqlite');","import {DatabaseSync} from 'node:sqlite';");
 const {base}=await launch(t,root,source,'mjs'),response=await fetch(base+'/',{headers:{'X-Studio-Trace':'esm-auto-test-1234'}});await response.text();const trace=decode(response.headers.get('studio-trace'));assert.equal(trace.fields['items.0.label'].column,'label');assert.equal(trace.route.path,'server.mjs');
});
test('managed IPC disconnect closes the owned listener and bounds active socket cleanup',async t=>{
 const root=folder(t),{base,child}=await launch(t,root,cjs,'cjs',true),url=new URL(base);
 const socket=net.createConnection({host:'127.0.0.1',port:Number(url.port)});socket.on('error',()=>{});
 await new Promise(resolve=>socket.once('connect',resolve));socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
 const closed=new Promise(resolve=>socket.once('close',resolve)),exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned Node backend outlived its IPC host disconnect')),2500);child.once('exit',code=>{clearTimeout(timer);resolve(code)});});
 child.disconnect();assert.equal(await exited,0);await closed;assert.equal(socket.destroyed,true);await assert.rejects(fetch(base+'/'));
});
