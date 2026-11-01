'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net');
const {inflateSync}=require('node:zlib');
const {createAutoAttach,cleanOutput}=require('../adapters/tracing/auto-attach.cjs');
const {pathToFileURL}=require('node:url');
const proxyModule=()=>import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/auto-vite.mjs')).href);

async function fixture(t,{backend=false,second=false,fail=false,hang=false,bindGate=false}={}){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'orivo-automatic-')),root=path.join(temporary,'project'),runtime=path.join(temporary,'profile');
 await fs.mkdir(path.join(root,'frontend/node_modules/vite'),{recursive:true});
 await fs.writeFile(path.join(root,'frontend/package.json'),JSON.stringify({name:'automatic-fixture',dependencies:{react:'19.0.0',vite:'8.0.0'},scripts:{dev:'vite',predev:'node forbidden-side-effect.js'}}));
 await fs.writeFile(path.join(root,'frontend/node_modules/vite/package.json'),JSON.stringify({name:'vite',version:'8.0.0',type:'module',exports:'./index.mjs'}));
 // A tiny Vite API double isolates process lifecycle and proxy behavior. Real
 // React/Vite acceptance uses the independently installed framework separately.
 await fs.writeFile(path.join(root,'frontend/node_modules/vite/index.mjs'),`import http from 'node:http';import fs from 'node:fs/promises';
 export async function loadConfigFromFile(){${fail?"throw Error('fixture config failed')":`return {config:{server:{proxy:{'/api':{target:'http://127.0.0.1:32001',changeOrigin:false,ws:true}}}}}`};}
 export async function createServer(config){${bindGate?"await fs.mkdir(config.cacheDir,{recursive:true});await fs.writeFile(config.cacheDir+'/before-bind','ready');while(true){try{await fs.stat(config.cacheDir+'/continue-bind');break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}":""}let middleware=[];const app=http.createServer((req,res)=>{let i=0;const next=()=>{if(i<middleware.length)return middleware[i++](req,res,next);if(req.url.startsWith('/api')){const target=new URL(config.server.proxy['/api'].target);const proxy=http.request(target.origin+req.url,{headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});proxy.on('error',()=>{res.statusCode=502;res.end('unavailable')});req.pipe(proxy);return;}res.end('automatic fixture')};next()});const server={middlewares:{use(fn){middleware.push(fn)}},async listen(){${hang?"await new Promise(()=>{})":"await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(config.server.port,config.server.host,resolve)})"}},async close(){await new Promise(resolve=>app.close(resolve))}};for(const plugin of config.plugins)plugin.configureServer?.(server);return server;}
 `);
 if(backend){
  await fs.mkdir(path.join(root,'backend'));
  await fs.writeFile(path.join(root,'backend/package.json'),JSON.stringify({name:'automatic-backend',scripts:{dev:'node server.cjs',predev:'node do-not-run.js'},engines:{node:'>=24.13.0'}}));
  await fs.writeFile(path.join(root,'backend/server.cjs'),`const http=require('node:http');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE parcels(reference TEXT); INSERT INTO parcels VALUES('AUTO-314')");http.createServer(function parcelRequest(req,res){const rows=db.prepare('SELECT reference FROM parcels').all();res.setHeader('content-type','application/json');res.end(JSON.stringify({items:rows}));}).listen(32001,'127.0.0.1');`);
 }
 if(second){await fs.mkdir(path.join(root,'other'));await fs.writeFile(path.join(root,'other/package.json'),JSON.stringify({dependencies:{react:'19',vite:'8.0.0'}}));await fs.mkdir(path.join(root,'other/node_modules'),{recursive:true});await fs.symlink(path.join(root,'frontend/node_modules/vite'),path.join(root,'other/node_modules/vite'),process.platform==='win32'?'junction':'dir');}
 const manager=createAutoAttach({runtimeDirectory:runtime});
 t.after(async()=>{await manager.close();assert.equal(path.dirname(temporary),os.tmpdir());assert.ok(path.basename(temporary).startsWith('orivo-automatic-'));await fs.rm(temporary,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
 return {root,runtime,manager,temporary};
}
async function files(directory){const result={};async function scan(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await scan(file);else if(entry.isFile())result[path.relative(directory,file)]=await fs.readFile(file,'utf8');}}await scan(directory);return result;}
async function unusedPort(host='127.0.0.1'){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function occupiedPort(t,host='127.0.0.1'){const server=http.createServer((_req,res)=>res.end('original application'));await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));return server.address().port;}

test('automatic detection is read only, IDs are stable and arbitrary commands cannot be selected',async t=>{
 const {root,manager}=await fixture(t),before=await files(root),found=await manager.detect(root);
 assert.equal(found.supported,true);assert.equal(found.requiresSelection,false);assert.equal(found.selected.frontend,'vite:frontend');assert.equal(found.selected.backend,null);assert.deepEqual(await files(root),before);
 assert.equal((await manager.start(root,{command:'npm install'})).status,'failed');
 assert.match((await manager.state(root)).notice,/selections only/);
 assert.equal((await manager.start(root,{frontend:'../../injected'})).status,'failed');
 assert.deepEqual(await files(root),before);
});
test('automatic detection requires a frontend selection when several installed apps exist',async t=>{
 const {root,manager}=await fixture(t,{second:true}),found=await manager.detect(root);
 assert.equal(found.frontends.length,2);assert.equal(found.requiresSelection,true);assert.equal(found.selected.frontend,null);
 assert.equal((await manager.start(root)).status,'failed');
 const running=await manager.start(root,{frontend:'vite:other',backend:null});assert.equal(running.status,'running');assert.equal(running.frontend,'vite:other');
});
test('managed frontend preserves the provided localhost URL and port across stop and restart',async t=>{
 const {root,manager,runtime}=await fixture(t),before=await files(root),port=await unusedPort(),url=`http://localhost:${port}/workspaces?view=detail#ideas`;
 const started=await manager.start(root,{url});
 assert.equal(started.status,'running',started.notice+'\n'+started.output);assert.equal(started.active,true);assert.equal(started.url,url);assert.equal(started.requestedUrl,url);assert.equal(started.urlMode,'provided');assert.equal(started.errorCode,null);
 assert.equal(await (await fetch(started.url)).text(),'automatic fixture');assert.deepEqual(await files(root),before);
 await assert.rejects(manager.start(root,{command:'node arbitrary.js'}),/selections only/);await assert.rejects(manager.start(root,{frontend:'vite:other'}),/Stop the current/);assert.equal((await manager.state(root)).status,'running');
 assert.ok((await fs.readdir(runtime)).length);assert.equal((await manager.start(root)).url,started.url);
 const route=`http://localhost:${port}/ideas?page=2#details`;
 assert.equal((await manager.start(root,{url:route})).url,route);
 await assert.rejects(manager.start(root,{url:`http://127.0.0.1:${port}/ideas`}),/Stop the current attachment/);
 const stopped=await manager.stop(root);assert.equal(stopped.status,'stopped');assert.equal(stopped.active,false);await assert.rejects(fetch(started.url));
 const restarted=await manager.start(root,{url:route});assert.equal(restarted.status,'running',restarted.notice);assert.equal(restarted.url,route);assert.equal(restarted.errorCode,null);assert.deepEqual(await files(root),before);
});

test('an occupied provided port stays untouched and fails before either traced child starts',async t=>{
 const {root,manager,runtime}=await fixture(t,{backend:true}),port=await occupiedPort(t),url=`http://localhost:${port}/ideas`;
 const failed=await manager.start(root,{url});
 assert.equal(failed.status,'failed');assert.equal(failed.active,false);assert.equal(failed.errorCode,'port-in-use');assert.equal(failed.requestedUrl,url);assert.equal(failed.url,null);assert.match(failed.notice,/already in use/);
 assert.equal(await (await fetch(url)).text(),'original application');await assert.rejects(fs.stat(runtime),{code:'ENOENT'});
});

test('a process taking the port after preflight gets a clear conflict without a fallback URL',async t=>{
 const {root,manager,runtime}=await fixture(t,{bindGate:true}),port=await unusedPort(),url=`http://localhost:${port}/ideas`,pending=manager.start(root,{url});
 let cache;
 for(let attempt=0;attempt<600&&!cache;attempt++){
  try{for(const directory of await fs.readdir(runtime)){const value=JSON.parse(await fs.readFile(path.join(runtime,directory,'frontend.json'),'utf8'));await fs.stat(path.join(value.cacheDirectory,'before-bind'));cache=value.cacheDirectory;break;}}catch{}
  if(!cache)await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.ok(cache,'The owned frontend reached its controlled pre-bind gate');
 const existing=http.createServer((_request,response)=>response.end('original application'));await new Promise((resolve,reject)=>{existing.once('error',reject);existing.listen(port,'127.0.0.1',resolve);});t.after(()=>new Promise(resolve=>existing.close(resolve)));
 await fs.writeFile(path.join(cache,'continue-bind'),'continue');const failed=await pending;
 assert.equal(failed.status,'failed');assert.equal(failed.active,false);assert.equal(failed.errorCode,'port-in-use');assert.equal(failed.url,null);assert.equal(failed.requestedUrl,url);assert.ok(failed.notice.includes(`Port ${port}`));assert.ok(failed.notice.includes(new URL(url).origin));assert.match(failed.notice,/Stop the frontend development server and retry/);assert.equal(await (await fetch(url)).text(),'original application');
});

test('a separately chosen tracing URL is explicit and reuses its owned port after stopping',async t=>{
 const {root,manager}=await fixture(t),port=await occupiedPort(t),requested=`http://localhost:${port}/ideas?order=new#details`;
 const separate=await manager.start(root,{url:requested,urlMode:'separate'});
 assert.equal(separate.status,'running',separate.notice);assert.equal(separate.urlMode,'separate');assert.equal(separate.requestedUrl,requested);assert.notEqual(new URL(separate.url).port,String(port));assert.equal(new URL(separate.url).hash,'#details');assert.equal(new URL(separate.url).search,'?order=new');
 assert.equal(await (await fetch(requested)).text(),'original application');assert.equal(await (await fetch(separate.url)).text(),'automatic fixture');
 await assert.rejects(manager.start(root,{url:requested}),/Stop the current attachment/);assert.equal((await manager.start(root,{url:requested,urlMode:'separate'})).url,separate.url);
 await manager.stop(root);assert.equal((await manager.start(root)).url,separate.url);
 await manager.stop(root);const restarted=await manager.start(root,{url:separate.url});assert.equal(restarted.status,'running',restarted.notice);assert.equal(restarted.url,separate.url);assert.equal(restarted.requestedUrl,requested);
 await manager.stop(root);const original=await manager.start(root,{url:requested});assert.equal(original.status,'failed');assert.equal(original.errorCode,'port-in-use');assert.equal(original.urlMode,'provided');assert.equal(original.url,null);assert.equal(original.requestedUrl,requested);assert.equal(await (await fetch(requested)).text(),'original application');
 const provided=`http://localhost:${await unusedPort()}/provided#details`,changed=await manager.start(root,{url:provided,urlMode:'provided'});assert.equal(changed.status,'running',changed.notice);assert.equal(changed.url,provided);assert.equal(changed.urlMode,'provided');assert.equal(changed.errorCode,null);
});

test('automatic attachment without an entered URL retains its first owned URL after stop',async t=>{
 const {root,manager}=await fixture(t),first=await manager.start(root);assert.equal(first.status,'running',first.notice);assert.equal(first.requestedUrl,null);
 await manager.stop(root);const next=await manager.start(root);assert.equal(next.status,'running',next.notice);assert.equal(next.url,first.url);assert.equal(next.errorCode,null);
});

test('an HTTPS address requires explicit separate mode and remains metadata across stable restarts',async t=>{
 const {root,manager}=await fixture(t),requested='https://example.com/ideas?view=detail#description';
 const failed=await manager.start(root,{url:requested});assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'unsupported-origin');assert.equal(failed.requestedUrl,requested);assert.equal(failed.url,null);
 const separate=await manager.start(root,{url:requested,urlMode:'separate'});assert.equal(separate.status,'running',separate.notice);assert.equal(separate.errorCode,null);assert.equal(separate.requestedUrl,requested);assert.equal(new URL(separate.url).protocol,'http:');assert.equal(new URL(separate.url).hostname,'127.0.0.1');assert.equal(new URL(separate.url).pathname,'/ideas');assert.equal(new URL(separate.url).search,'?view=detail');assert.equal(new URL(separate.url).hash,'#description');
 assert.equal(await (await fetch(separate.url)).text(),'automatic fixture');assert.equal((await manager.start(root,{url:requested,urlMode:'separate'})).url,separate.url);
 await manager.stop(root);const restarted=await manager.start(root,{url:requested,urlMode:'separate'});assert.equal(restarted.status,'running',restarted.notice);assert.equal(restarted.url,separate.url);assert.equal(restarted.requestedUrl,requested);
 await manager.stop(root);const provided=await manager.start(root,{url:requested});assert.equal(provided.status,'failed');assert.equal(provided.errorCode,'unsupported-origin');assert.equal(provided.url,null);
});

test('remote and HTTPS origins cannot be silently replaced by a local HTTP server',async t=>{
 const {root,manager,runtime}=await fixture(t);
 for(const url of ['https://localhost:5173/ideas','https://example.com/ideas']){
  const failed=await manager.start(root,{url});assert.equal(failed.status,'failed');assert.equal(failed.active,false);assert.equal(failed.url,null);assert.equal(failed.errorCode,'unsupported-origin');assert.equal(failed.requestedUrl,url);await assert.rejects(fs.stat(runtime),{code:'ENOENT'});
 }
 const invalid=await manager.start(root,{urlMode:'automatic-fallback'});assert.equal(invalid.status,'failed');assert.equal(invalid.errorCode,null);assert.match(invalid.notice,/provided application address/);
});

test('an explicit IPv6 loopback URL binds and remains unchanged when IPv6 is available',async t=>{
 let port;try{port=await unusedPort('::1');}catch(error){if(['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code))return t.skip('IPv6 loopback is unavailable.');throw error;}
 const {root,manager}=await fixture(t),url=`http://[::1]:${port}/ideas#details`,started=await manager.start(root,{url});
 assert.equal(started.status,'running',started.notice+'\n'+started.output);assert.equal(started.url,url);assert.equal(await (await fetch(url)).text(),'automatic fixture');
});

test('localhost also detects an existing IPv6 listener without starting an IPv4 duplicate',async t=>{
 let port;try{port=await occupiedPort(t,'::1');}catch(error){if(['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code))return t.skip('IPv6 loopback is unavailable.');throw error;}
 const {root,manager,runtime}=await fixture(t),url=`http://localhost:${port}/ideas`,failed=await manager.start(root,{url});
 assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'port-in-use');assert.equal(failed.active,false);assert.equal(failed.url,null);await assert.rejects(fs.stat(runtime),{code:'ENOENT'});
 assert.equal(await (await fetch(`http://[::1]:${port}`)).text(),'original application');
});
test('managed Node listener and proxy capture real SQLite metadata without modifying either application',async t=>{
 const {root,manager}=await fixture(t,{backend:true}),before=await files(root),found=await manager.detect(root);
 assert.equal(found.backends.length,1);assert.match(found.selected.backend,/^node-/);
 const started=await manager.start(root);assert.equal(started.status,'running',started.notice+'\n'+started.output);
 const response=await fetch(new URL('/api/parcels',started.url),{headers:{'X-Studio-Trace':'automatic_test_12345'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{items:[{reference:'AUTO-314'}]});
 const encoded=response.headers.get('Studio-Trace');assert.ok(encoded);let trace=JSON.parse((encoded.startsWith('z1.')?inflateSync(Buffer.from(encoded.slice(3),'base64')):Buffer.from(encoded,'base64')).toString());
 if(trace.ref==='orivo-managed-v1'){assert.ok(encoded.length<200);const metadata=await fetch(new URL('/__orivo_trace/'+trace.key,started.url));assert.equal(metadata.status,200);trace=await metadata.json();assert.equal(trace.id,'automatic_test_12345');}
 assert.equal(trace.fields['items.0.reference'].table,'parcels');assert.equal(trace.fields['items.0.reference'].column,'reference');assert.match(trace.queries[0].sql,/SELECT reference FROM parcels/);assert.deepEqual(await files(root),before);
 const stopped=await manager.stop(root);assert.equal(stopped.active,false);
});
test('explicit frontend only does not spawn a detected backend',async t=>{
 const {root,manager}=await fixture(t,{backend:true}),started=await manager.start(root,{backend:null});assert.equal(started.status,'running');assert.equal(started.backend,null);assert.match(started.notice,/frontend tracing/);
});

test('managed Node transport preserves late field lineage across eighty actual SQL executions',async t=>{
 const {root,manager}=await fixture(t,{backend:true});
 await fs.writeFile(path.join(root,'backend/server.cjs'),`const http=require('node:http');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE parcels(reference TEXT); INSERT INTO parcels VALUES('TRACE-ROW')");http.createServer(function listParcels(req,res){const rows=[];for(let i=0;i<80;i++)rows.push(db.prepare('SELECT reference FROM parcels').get());res.setHeader('content-type','application/json');res.end(JSON.stringify({items:rows}));}).listen(32001,'127.0.0.1');`);
 const started=await manager.start(root);assert.equal(started.status,'running',started.notice+'\n'+started.output);
 const response=await fetch(new URL('/api/parcels',started.url),{headers:{'X-Studio-Trace':'many_queries_request'}});assert.equal((await response.json()).items.length,80);
 const encoded=response.headers.get('Studio-Trace');let trace=JSON.parse((encoded.startsWith('z1.')?inflateSync(Buffer.from(encoded.slice(3),'base64')):Buffer.from(encoded,'base64')).toString());
 if(trace.ref==='orivo-managed-v1'){const stored=await fetch(new URL('/__orivo_trace/'+trace.key,started.url));assert.equal(stored.status,200);trace=await stored.json();}
 assert.equal(trace.queries.length,80);assert.equal(trace.truncated,false);assert.equal(trace.fields['items.79.reference'].column,'reference');assert.deepEqual(trace.fields['items.79.reference'].queries,[trace.queries[79].id]);
 assert.equal((await fetch(new URL('/__orivo_trace/not-a-key',started.url))).status,404);
});
test('startup failure clears owned processes and the next start can recover',async t=>{
 const {root,manager}=await fixture(t,{backend:true,fail:true});
 const failed=await manager.start(root);assert.equal(failed.status,'failed');assert.equal(failed.active,false);assert.match(failed.output,/fixture config failed/);
 const entry=path.join(root,'frontend/node_modules/vite/index.mjs'),source=await fs.readFile(entry,'utf8');await fs.writeFile(entry,source.replace("throw Error('fixture config failed')","return {config:{server:{proxy:{'/api':{target:'http://127.0.0.1:32001'}}}}}"));
 const retry=await manager.start(root);assert.equal(retry.status,'running',retry.notice+'\n'+retry.output);
});
test('Stop and close cancel an unfinished launch promptly without leaking its child',async t=>{
 const {root,manager}=await fixture(t,{hang:true});const pending=manager.start(root);let starting=false;
 for(let count=0;count<100;count++){if((await manager.state(root)).status==='starting'){starting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}assert.ok(starting);
 const began=Date.now(),stopped=await manager.stop(root);assert.equal(stopped.status,'stopped');assert.equal((await pending).active,false);assert.ok(Date.now()-began<7000);
});
test('proxy target replacement keeps rewrite, WebSockets and remote targets; ambiguity is explicit',async()=>{
 const {managedProxy}=await proxyModule(),rewrite=p=>p.replace(/^\/service/,'/api');
 const original={'/service':{target:'http://localhost:8000/base',changeOrigin:false,ws:true,rewrite},'/admin':'http://127.0.0.1:8000','/remote':{target:'https://example.com'}};
 const result=managedProxy(original,'http://127.0.0.1:49999');assert.equal(result['/service'].target,'http://127.0.0.1:49999/base');assert.equal(result['/service'].rewrite,rewrite);assert.equal(result['/service'].ws,true);assert.equal(result['/service'].changeOrigin,false);assert.equal(result['/admin'].target,'http://127.0.0.1:49999/');assert.equal(result['/remote'],original['/remote']);assert.equal(original['/service'].target,'http://localhost:8000/base');
 assert.throws(()=>managedProxy({'/a':'http://127.0.0.1:8000','/b':'http://127.0.0.1:9000'},'http://127.0.0.1:49999'),/multiple local/);
 const chosen=managedProxy({'/a':'http://127.0.0.1:8000','/b':'http://127.0.0.1:9000'},'http://127.0.0.1:49999',8000);assert.equal(chosen['/b'],'http://127.0.0.1:9000');assert.match(chosen['/a'].target,/49999/);
 assert.throws(()=>managedProxy(undefined,'http://127.0.0.1:49999'),/no local API proxy/);assert.equal(managedProxy(original,null),original);
});
test('development output redacts credentials, tokens and authorization values',()=>{
 const value=cleanOutput('postgresql://user:private@localhost/db?token=sensitive password="never show" Authorization: Bearer abcdef\nhttps://example.com/?api_key=hush\npostgresql+psycopg://user:driverpassword@localhost/db\n{"password":"jsonpassword","access_token":"jsontoken"}\nAuthorization: Basic basiccredential\nGITHUB_TOKEN=envtoken session_id=envsession');for(const secret of ['private','sensitive','never show','abcdef','hush','driverpassword','jsonpassword','jsontoken','basiccredential','envtoken','envsession'])assert.ok(!value.includes(secret),secret+' must be redacted');
});
test('retargeted roots cannot be adopted and a moved root remains stoppable by its pinned identity',async t=>{
 const {root,manager,temporary}=await fixture(t),alias=path.join(temporary,'alias');await fs.symlink(root,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(manager.detect(alias),/project folder changed/);
 assert.equal((await manager.start(root,{frontend:'invalid'})).status,'failed');
 const moved=path.join(temporary,'moved');await fs.rename(root,moved);await fs.mkdir(root);
 assert.equal((await manager.stop(root)).status,'stopped');assert.equal((await manager.state(root)).active,false);
});
test('a split oversized application log line is omitted without exposing its secret tail',async t=>{
 const {root,manager}=await fixture(t,{backend:true}),entry=path.join(root,'backend/server.cjs');
 await fs.writeFile(entry,"process.stdout.write('password=');process.stdout.write('sensitive_tail'.repeat(2000));process.stdout.write('\\nSafe application output\\n');"+await fs.readFile(entry,'utf8'));
 const started=await manager.start(root);assert.equal(started.status,'running',started.notice);assert.equal(started.output.includes('sensitive_tail'),false);assert.ok(started.output.includes('Safe application output'));assert.ok(started.output.length<=6000);
});
