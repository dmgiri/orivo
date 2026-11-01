// Unmodified Node HTTP + pg acceptance against an owned temporary PostgreSQL 17
// cluster. No app dependency installs or existing database services are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';

const appRoot=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const pgPackage=process.env.ORIVO_PG_PACKAGE;
assert.ok(pgPackage,'Set ORIVO_PG_PACKAGE to an existing pg package directory. No dependencies are downloaded.');
const pgBin=process.env.ORIVO_POSTGRES_BIN||'C:\\Program Files\\PostgreSQL\\17\\bin';
const fixture=path.join(appRoot,'.tmp','auto-node-postgres-'+Date.now()),data=path.join(fixture,'.postgres','data');
await fs.mkdir(path.dirname(data),{recursive:true});
await fs.mkdir(path.join(fixture,'node_modules'),{recursive:true});
await fs.symlink(await fs.realpath(pgPackage),path.join(fixture,'node_modules','pg'),process.platform==='win32'?'junction':'dir');
const runFile=promisify(execFile),checks=[];
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function pg(program,args){const executable=path.join(pgBin,program+(process.platform==='win32'?'.exe':''));if(program!=='pg_ctl'||args[0]!=='start')return runFile(executable,args,{cwd:fixture,windowsHide:true,timeout:45000,maxBuffer:1048576});await new Promise((resolve,reject)=>{const process=spawn(executable,args,{cwd:fixture,windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>{process.kill();reject(Error('Temporary PostgreSQL startup timed out.'));},45000);process.once('error',error=>{clearTimeout(timer);reject(error)});process.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Temporary PostgreSQL startup failed.'))});});}
function decode(value){assert.ok(value);assert.ok(Buffer.byteLength(value)<=6144);return JSON.parse(value.startsWith('z1.')?inflateSync(Buffer.from(value.slice(3),'base64')):Buffer.from(value,'base64'));}
let started=false,child,proxy;
async function stopChild(){if(!child)return;const current=child;child=null;current.kill();await new Promise(resolve=>{if(current.exitCode!==null)return resolve();current.once('exit',resolve);setTimeout(resolve,3000).unref();});}
try {
 const password=randomBytes(24).toString('hex'),passwordFile=path.join(fixture,'.postgres','password.tmp');await fs.writeFile(passwordFile,password+'\n');
 await pg('initdb',['-D',data,'--username=orivo_node','--encoding=UTF8','--locale=C','--auth-local=trust','--auth-host=scram-sha-256','--pwfile='+passwordFile]);await fs.unlink(passwordFile);
 const databasePort=await port();await pg('pg_ctl',['start','-D',data,'-l',path.join(fixture,'.postgres','server.log'),'-w','-o',`-h 127.0.0.1 -p ${databasePort} -c fsync=off -c max_connections=12`]);started=true;
 const baseSource=`const http=require('node:http');
const {Pool,Client}=require('pg');
const {randomBytes}=require('node:crypto');
const pool=new Pool({max:1});
const direct=new Client();
async function route(request,response){
 const mode=new URL(request.url,'http://localhost').pathname;
 const query=mode==='/computed'?"SELECT reference || '' AS label FROM public.parcels WHERE id=$1":'SELECT id,reference AS label,alternate FROM public.parcels WHERE id=$1';
 const result=mode==='/client'?await direct.query(query,[1]):mode==='/callback'?await new Promise((resolve,reject)=>pool.query(query,[1],(error,result)=>error?reject(error):resolve(result))):await pool.query(query,[1]);
 let payload={items:result.rows};
 if(mode==='/copied')payload={items:result.rows.map(row=>({label:row.label,alternate:row.alternate}))};
 if(mode==='/mutated')result.rows[0].label+='-changed';
 if(mode==='/compressed')payload=Object.fromEntries(Array.from({length:100},(_,index)=>['branch'+index,result.rows[0]]));
 if(mode==='/bounded')payload=Object.fromEntries(Array.from({length:100},()=>[randomBytes(48).toString('hex'),result.rows[0]]));
 response.setHeader('Content-Type','application/json');response.end(JSON.stringify(payload));
}
async function start(){await direct.connect();await pool.query('CREATE TABLE IF NOT EXISTS public.parcels(id INTEGER PRIMARY KEY,reference TEXT,alternate TEXT)');await pool.query("INSERT INTO public.parcels VALUES(1,'PRIVATE-REFERENCE','PRIVATE-REFERENCE') ON CONFLICT(id) DO NOTHING");http.createServer((request,response)=>route(request,response).catch(()=>{response.statusCode=500;response.end('application error')})).listen(0,'127.0.0.1');}
start().catch(()=>process.exit(2));
`;
 for(const extension of ['cjs','mjs']) {
  const source=extension==='mjs'?baseSource.replace("const http=require('node:http');","import http from 'node:http';").replace("const {Pool,Client}=require('pg');","import {Pool,Client} from 'pg';").replace("const {randomBytes}=require('node:crypto');","import {randomBytes} from 'node:crypto';"):baseSource;
  const serverFile=path.join(fixture,'application.'+extension),configFile=path.join(fixture,'managed.json'),listenPort=await port(),readyToken=randomUUID();await fs.writeFile(serverFile,source);await fs.writeFile(configFile,JSON.stringify({root:fixture,port:listenPort,host:'127.0.0.1',parentPid:process.pid,readyToken}));
  const env={...process.env,ORIVO_AUTO_NODE_CONFIG:configFile,PGHOST:'127.0.0.1',PGPORT:String(databasePort),PGUSER:'orivo_node',PGPASSWORD:password,PGDATABASE:'postgres'};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  child=spawn(process.execPath,['--require',path.join(appRoot,'adapters/tracing/auto-node.cjs'),serverFile],{cwd:fixture,windowsHide:true,env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const base='http://127.0.0.1:'+listenPort;let ready=false;for(let attempt=0;attempt<200;attempt++){if(child.exitCode!==null)throw Error('Managed pg fixture exited. '+stderr);try{if(await (await fetch(base+'/__orivo_managed_ready/'+readyToken)).text()===readyToken){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'Managed pg fixture was not ready.');
  const normal=await fetch(base+'/');assert.equal(normal.headers.get('studio-trace'),null);assert.equal((await normal.json()).items[0].label,'PRIVATE-REFERENCE');
  for(const route of ['/','/client','/callback']) {
   const id=randomUUID(),response=await fetch(base+route,{headers:{'X-Studio-Trace':id}});assert.equal(response.status,200);assert.equal((await response.json()).items[0].label,'PRIVATE-REFERENCE');
   const trace=decode(response.headers.get('studio-trace'));await fs.writeFile(path.join(fixture,'latest-execution.json'),JSON.stringify({extension,route,trace},null,2));assert.equal(trace.id,id);assert.equal(trace.route?.path,'application.'+extension);assert.equal(trace.route.hash,createHash('sha256').update(source).digest('hex'));assert.equal(trace.queries.length,1);assert.equal(trace.fields['items.0.label'].table,'public.parcels');assert.equal(trace.fields['items.0.label'].column,'reference');assert.equal(trace.fields['items.0.alternate'].column,'alternate');assert.equal(trace.fields['items.0.label'].queries[0],trace.queries[0].id);assert.doesNotMatch(JSON.stringify(trace),/PRIVATE-REFERENCE|password|pg_catalog/);
   if(extension==='cjs'&&route==='/')await fs.writeFile(path.join(fixture,'execution.json'),JSON.stringify(trace,null,2));
  }
  checks.push(extension+': unchanged pg Pool promise, Pool callback and Client promise paths prove aliases from real relation/attribute metadata');
  for(const route of ['/copied','/computed']){const response=await fetch(base+route,{headers:{'X-Studio-Trace':randomUUID()}});await response.text();const trace=decode(response.headers.get('studio-trace'));assert.deepEqual(trace.fields,{});assert.equal(trace.queries.length,1);}
  const changed=await fetch(base+'/mutated',{headers:{'X-Studio-Trace':randomUUID()}});await changed.text();const changedTrace=decode(changed.headers.get('studio-trace'));assert.equal(changedTrace.fields['items.0.label'],undefined);assert.equal(changedTrace.fields['items.0.alternate'].column,'alternate');
  checks.push(extension+': equal values in different columns keep distinct origins; copied, computed and mutated field mappings are rejected');
  const compressed=await fetch(base+'/compressed',{headers:{'X-Studio-Trace':randomUUID()}});await compressed.text();assert.ok(compressed.headers.get('studio-trace').startsWith('z1.'));assert.equal(Object.keys(decode(compressed.headers.get('studio-trace')).fields).length,200);
  const bounded=await fetch(base+'/bounded',{headers:{'X-Studio-Trace':randomUUID()}}),boundedBody=await bounded.json(),boundedTrace=decode(bounded.headers.get('studio-trace'));assert.equal(Object.keys(boundedBody).length,100);assert.equal(boundedTrace.truncated,true);assert.deepEqual(boundedTrace.fields,{});assert.deepEqual(boundedTrace.queries,[]);
  proxy=http.createServer((request,response)=>{const upstream=http.request(base+request.url,{headers:request.headers},incoming=>{response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response)});upstream.on('error',()=>{response.statusCode=502;response.end('proxy error')});request.pipe(upstream)});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxied=await fetch('http://127.0.0.1:'+proxy.address().port+'/compressed',{headers:{'X-Studio-Trace':randomUUID()}});assert.equal(proxied.status,200);assert.equal(Object.keys(await proxied.json()).length,100);assert.equal(Object.keys(decode(proxied.headers.get('studio-trace')).fields).length,200);await new Promise(resolve=>proxy.close(resolve));proxy=null;
  checks.push(extension+': compressed and incompressible metadata stay inside 6 KiB and pass a default Node HTTP proxy without altering JSON');
  await fs.appendFile(serverFile,'\n// source changed after server startup\n');const stale=await fetch(base+'/',{headers:{'X-Studio-Trace':randomUUID()}});await stale.text();const staleTrace=decode(stale.headers.get('studio-trace'));assert.deepEqual(staleTrace.fields,{});assert.equal(staleTrace.route,null);assert.equal(staleTrace.queries[0].site,null);
  checks.push(extension+': stale application source cannot produce verified query or column provenance');
  await stopChild();
 }
 await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify({status:'passed',checks},null,2));console.log(JSON.stringify({status:'passed',checks,receipt:path.join(fixture,'result.json')},null,2));
} finally {
 if(proxy)await new Promise(resolve=>proxy.close(resolve));await stopChild();if(started)await pg('pg_ctl',['stop','-D',data,'-m','fast','-w']);
}
