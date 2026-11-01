// Independent native acceptance: query-loaded ORM class with ordinary dict serialization.
// Uses existing dependencies and an isolated, disposable PostgreSQL cluster.
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {cp, mkdir, realpath, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {promisify} from 'node:util';
import {inflateSync} from 'node:zlib';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {_electron as electron} from 'playwright-core';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),require=createRequire(import.meta.url);
const python=process.env.ORIVO_FIXTURE_PYTHON,dependencies=process.env.ORIVO_FIXTURE_DEPS;
assert.ok(python,'Set ORIVO_FIXTURE_PYTHON to an existing Python with FastAPI, SQLAlchemy, psycopg and Uvicorn. No packages are downloaded.');
assert.ok(dependencies,'Set ORIVO_FIXTURE_DEPS to an existing React/React DOM/Vite project. No packages are downloaded.');
const dependencyRequire=createRequire(path.join(path.resolve(dependencies),'package.json'));
const {createServer}=await import(pathToFileURL(dependencyRequire.resolve('vite')).href);
const fixture=path.join(root,'.tmp','product-fixture','query-model-tracing-'+Date.now()),evidence=path.join(fixture,'acceptance');
await mkdir(path.join(fixture,'src'),{recursive:true});await mkdir(evidence);
await mkdir(path.join(fixture,'node_modules','@orivo'),{recursive:true});
const kit=path.join(fixture,'node_modules','@orivo','tracing');
await cp(path.join(root,'adapters','tracing'),kit,{recursive:true,errorOnExist:true});
for(const name of ['react','react-dom','scheduler'])await symlink(await realpath(path.dirname(dependencyRequire.resolve(name+'/package.json'))),path.join(fixture,'node_modules',name),process.platform==='win32'?'junction':'dir');
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'orivo-query-model-acceptance',private:true,type:'module'}));
await writeFile(path.join(fixture,'index.html'),'<html><head><title>Shipment model acceptance</title></head><body><div id="root"></div><script type="module" src="/src/Shipment.jsx"></script></body></html>');
const client=`import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
function Shipment(){
  const [shipment,setShipment]=useState(null);
  useEffect(()=>{window.loadShipment=()=>fetch('/api/shipments').then(r=>r.json()).then(body=>setShipment(body.shipments[0]));window.loadShipment();},[]);
  return shipment?<main><h1>Shipment tracker</h1><strong id="shipment-reference">{shipment.label}</strong></main>:<p>Loading</p>;
}
createRoot(document.getElementById('root')).render(<Shipment/>);
`;
await writeFile(path.join(fixture,'src','Shipment.jsx'),client);
const modelSource=`from sqlalchemy import String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class ShipmentRecord(Base):
    __tablename__ = 'shipment_records'
    __table_args__ = {'schema': 'public'}
    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(80))
`;
const modelFile=path.join(fixture,'shipment_models.py'),modelHash=createHash('sha256').update(modelSource).digest('hex');
const classLine=modelSource.split('\n').findIndex(line=>line.startsWith('class ShipmentRecord'))+1;
await writeFile(modelFile,modelSource);
const backendSource=`from __future__ import annotations
import json
import os
import socket
from pathlib import Path
from fastapi import FastAPI
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from shipment_models import Base, ShipmentRecord
import studio_tracing
import uvicorn

engine = create_engine(os.environ['ORIVO_FIXTURE_DATABASE_URL'])
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)
with Session.begin() as session:
    session.add(ShipmentRecord(id=8, reference='SH-2048'))
    session.add(ShipmentRecord(id=9, reference='SH-4096'))
    session.add(ShipmentRecord(id=10, reference='SH-8192'))
app = FastAPI()
detach = studio_tracing.setup(app, Path(__file__).resolve().parent, development=True, engine=engine, sessions=Session)

@app.get('/api/shipments')
def shipment_list():
    with Session() as session:
        records = session.scalars(select(ShipmentRecord).order_by(ShipmentRecord.id)).all()
        return {'shipments': [{'label': record.reference} for record in records]}

if __name__ == '__main__':
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    print(json.dumps({'url':'http://127.0.0.1:' + str(sock.getsockname()[1])}), flush=True)
    try:
        uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False)).run(sockets=[sock])
    finally:
        detach()
        engine.dispose()
`;
const backendFile=path.join(fixture,'shipment_api.py');await writeFile(backendFile,backendSource);
const entry=path.join(fixture,'.electron-acceptance.cjs');
// Mock only the OS editor boundary. Actual adapter, request, graph and source reads run.
await writeFile(entry,`const electron=require('electron');global.__modelEditorUrls=[];electron.shell.openExternal=async url=>{global.__modelEditorUrls.push(url);};electron.BrowserWindow.prototype.show=function(){};electron.BrowserWindow.prototype.focus=function(){};electron.BrowserWindow.prototype.moveTop=function(){};electron.app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));require(${JSON.stringify(path.join(root,'main.cjs'))});`);
const postgresBin=process.env.ORIVO_POSTGRES_BIN||'C:\\Program Files\\PostgreSQL\\17\\bin';
const postgresRoot=path.join(fixture,'.postgres'),postgresData=path.join(postgresRoot,'data'),passwordFile=path.join(postgresRoot,'password.tmp'),runFile=promisify(execFile);
async function pgCommand(program,args){
  const executable=path.join(postgresBin,program+(process.platform==='win32'?'.exe':''));
  if(program!=='pg_ctl'||args[0]!=='start')return runFile(executable,args,{cwd:fixture,windowsHide:true,timeout:45000,maxBuffer:1048576});
  await new Promise((resolve,reject)=>{const control=spawn(executable,args,{cwd:fixture,windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>{control.kill();reject(Error('Fixture PostgreSQL startup timed out'));},45000);control.once('error',error=>{clearTimeout(timer);reject(error);});control.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Fixture pg_ctl start exited '+code));});});
}
const checks=[],rendererErrors=[];let app,shell,vite,backend,postgresStarted=false,stdout='',stderr='';
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(check,message,timeout=25000){const expires=Date.now()+timeout;while(Date.now()<expires){const result=await check();if(result)return result;if(backend?.exitCode!==null&&backend?.exitCode!==undefined)throw Error('Python fixture exited: '+stderr);await pause(60);}throw Error(message+'\n'+stderr);}
try{
  await mkdir(postgresRoot);const password=randomBytes(24).toString('hex');await writeFile(passwordFile,password+'\n');
  await pgCommand('initdb',['-D',postgresData,'--username=orivo_query_model_fixture','--encoding=UTF8','--locale=C','--auth-local=trust','--auth-host=scram-sha-256','--pwfile='+passwordFile]);await unlink(passwordFile);
  const reservation=createNetServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const postgresPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  await pgCommand('pg_ctl',['start','-D',postgresData,'-l',path.join(postgresRoot,'server.log'),'-w','-o',`-h 127.0.0.1 -p ${postgresPort} -c fsync=off -c synchronous_commit=off -c max_connections=12`]);postgresStarted=true;
  backend=spawn(python,['-u',backendFile],{cwd:fixture,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:kit,ORIVO_FIXTURE_DATABASE_URL:`postgresql+psycopg://orivo_query_model_fixture:${password}@127.0.0.1:${postgresPort}/postgres`},stdio:['ignore','pipe','pipe']});backend.stdout.on('data',chunk=>{stdout+=chunk;});backend.stderr.on('data',chunk=>{stderr+=chunk;});
  const backendUrl=await until(()=>{try{return JSON.parse(stdout.split('\n')[0]).url;}catch{return false;}},'Backend did not report URL');
  await until(async()=>{try{return(await fetch(backendUrl+'/api/shipments')).ok;}catch{return false;}},'Backend did not become ready');
  const requestId=randomUUID(),response=await fetch(backendUrl+'/api/shipments',{headers:{'X-Studio-Trace':requestId}}),encoded=response.headers.get('Studio-Trace');assert.ok(encoded);assert.ok(Buffer.byteLength(encoded,'ascii')<=6144);
  const execution=JSON.parse((encoded.startsWith('z1.')?inflateSync(Buffer.from(encoded.slice(3),'base64')):Buffer.from(encoded,'base64')).toString());
  assert.equal(execution.id,requestId);assert.equal(execution.fields?.['shipments.0.label'],undefined,'Ordinary dictionaries must not invent response field lineage');
  assert.equal(execution.queries.length,1);const loaded=execution.queries[0].models;
  assert.equal(loaded.length,1,'Three rows of the same class must emit one class definition');
  assert.equal(loaded[0].model,'ShipmentRecord');assert.equal(loaded[0].table,'public.shipment_records');
  assert.equal(loaded[0].modelSource.path,'shipment_models.py');assert.equal(loaded[0].modelSource.line,classLine);assert.equal(loaded[0].modelSource.hash,modelHash);
  assert.deepEqual(await response.json(),{shipments:[{label:'SH-2048'},{label:'SH-4096'},{label:'SH-8192'}]});
  await writeFile(path.join(evidence,'http-execution.json'),JSON.stringify(execution,null,2));checks.push('Real PostgreSQL query emits one exact, hash-verified class declaration for three ORM rows without inventing dictionary field lineage');
  const studioTracing=(await import(pathToFileURL(path.join(kit,'vite.mjs')).href)).default;
  vite=await createServer({configFile:false,root:fixture,plugins:[studioTracing({repositoryRoot:fixture,enabled:true})],server:{host:'127.0.0.1',port:0,proxy:{'/api':backendUrl},watch:{ignored:['**']}},logLevel:'warn'});await vite.listen();
  const url='http://127.0.0.1:'+vite.httpServer.address().port,env={...process.env,TRACE_ATLAS_TEST_PROFILE:'query-model-tracing-'+Date.now(),ORIVO_START_MODE:'welcome'};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:require('electron'),args:[entry],env,timeout:30000});shell=await app.firstWindow();shell.setDefaultTimeout(25000);shell.on('pageerror',error=>rendererErrors.push(error.message));await shell.waitForFunction(()=>typeof window.traceAtlas?.getState==='function');
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},fixture);await shell.evaluate(()=>window.traceAtlas.connectRepository());await shell.evaluate(value=>window.traceAtlas.openApp(value),url);
  const previewId=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(url))?.id,url);assert.ok(previewId);
  const previewEval=script=>app.evaluate(({webContents},{id,script})=>webContents.fromId(id).executeJavaScript(script),{id:previewId,script});
  await until(()=>previewEval("document.querySelector('#shipment-reference')?.textContent==='SH-2048'"),'Rendered shipment was not ready');await shell.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()));
  await shell.locator('#inspect-button').click();await shell.locator('#inspect-button.inspecting').waitFor();
  await shell.evaluate(()=>{window.__modelPick=null;window.addEventListener('trace-atlas:graph',event=>{window.__modelPick=event.detail;});});
  await app.evaluate(async({webContents},id)=>{const contents=webContents.fromId(id),point=await contents.executeJavaScript("(()=>{const r=document.querySelector('#shipment-reference').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");contents.sendInputEvent({type:'mouseMove',...point});contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});},previewId);
  await shell.waitForFunction(()=>window.__modelPick?.nodes?.some(node=>node.kind==='model'));const graph=await shell.evaluate(()=>window.__modelPick);
  const models=graph.nodes.filter(node=>node.kind==='model'),model=models[0],query=graph.nodes.find(node=>node.kind==='query');
  assert.equal(models.length,1,'The graph must deduplicate model rows into one class card');assert.ok(query);assert.equal(model.file,'shipment_models.py');assert.equal(model.line,classLine);assert.equal(model.label,'ShipmentRecord');assert.ok(graph.files.includes('shipment_models.py'));
  assert.equal(graph.coverage,'partial');assert.ok(graph.gaps.some(gap=>gap.includes('lineage is not proven')));assert.equal(graph.nodes.some(node=>node.kind==='database'),false,'A loaded class is not proof of a selected response field origin');
  assert.equal(model.meta.sourceRole,'model-definition');assert.equal(model.meta.definitionOnly,true);assert.equal(model.meta.modelEvidence,'query-loaded');assert.equal(model.meta.sourceHash,modelHash);assert.equal(model.meta.modelSource.line,classLine);assert.equal(model.meta.model,'ShipmentRecord');assert.equal(model.meta.table,'public.shipment_records');assert.equal(model.meta.attribute,undefined);
  assert.ok(graph.edges.some(edge=>edge.to===model.id&&edge.from===query.id&&edge.label==='loads model'),'The actual query links to its loaded class');
  await writeFile(path.join(evidence,'query-model-trace.json'),JSON.stringify(graph,null,2));checks.push('Native element pick shows React, HTTP, Python, SQL and the query-loaded class, while dictionary column coverage remains partial');
  await shell.locator(`.graph-node[data-node="${model.id}"]`).click();await shell.locator('#code-path').filter({hasText:'shipment_models.py:'+classLine}).waitFor();
  await shell.locator('#code-content .code-line.highlight').filter({hasText:'class ShipmentRecord'}).waitFor();assert.match(await shell.locator('#detail-kind').textContent(),/MODEL/i);
  assert.equal(await shell.locator('#open-editor').isEnabled(),true);await shell.locator('#open-editor').click();
  await until(async()=>{const urls=await app.evaluate(()=>global.__modelEditorUrls);return urls.length&&urls;},'Editor boundary did not receive model location');
  const editorUrls=await app.evaluate(()=>global.__modelEditorUrls);assert.equal(editorUrls.length,1);assert.ok(editorUrls[0].startsWith('vscode://file/'));assert.ok(decodeURIComponent(editorUrls[0]).includes('shipment_models.py:'+classLine));
  await shell.locator('#tab-files').click();assert.ok((await shell.locator('#file-list').textContent()).includes('shipment_models.py'));
  assert.equal(await shell.locator('#model-count').textContent(),'1');await shell.locator('#files-models').click();assert.equal(await shell.locator('#files-models').getAttribute('aria-pressed'),'true');
  const modelRows=shell.locator('#file-list .file-row');assert.equal(await modelRows.count(),1);assert.match(await modelRows.textContent(),/ShipmentRecord/);assert.ok((await modelRows.locator('small').textContent()).includes('shipment_models.py'));assert.equal(await modelRows.locator('.file-row-end').textContent(),'L'+classLine);await modelRows.click();await shell.locator('#code-content .code-line.highlight').filter({hasText:'class ShipmentRecord'}).waitFor();
  await shell.locator('#tab-files').click();await shell.locator('#files-all').click();assert.equal(await shell.locator('#files-all').getAttribute('aria-pressed'),'true');const allFiles=await shell.locator('#file-list').textContent();for(const file of ['src/Shipment.jsx','shipment_api.py','shipment_models.py'])assert.ok(allFiles.includes(file));await shell.locator('#tab-map').click();
  checks.push('Model inspector highlights its class, Models filter shows one class with exact file/line, All files restores frontend/backend/model files, and editor navigation receives the verified class location');
  await shell.evaluate(()=>document.querySelectorAll('.toast').forEach(node=>node.remove()));await shell.screenshot({path:path.join(evidence,'model-dark.png')});
  await shell.locator('#theme-toggle').click();await shell.locator(`.graph-node[data-node="${model.id}"]`).click();assert.match(await shell.locator('#detail-kind').textContent(),/MODEL/i);await shell.screenshot({path:path.join(evidence,'model-light.png')});await shell.locator('#theme-toggle').click();
  await writeFile(modelFile,modelSource+'\n# Model source changed after this request.\n');const stale=await shell.evaluate(()=>window.traceAtlas.capture('#shipment-reference'));assert.equal(stale.nodes.some(node=>node.kind==='model'),false,'Changed model bytes cannot retain a verified class-source claim');assert.ok(stale.nodes.some(node=>node.kind==='query'),'Optional model-source failure must retain the real captured SQL query');assert.equal(stale.nodes.some(node=>node.kind==='database'),false);assert.equal(stale.coverage,'partial');await writeFile(modelFile,modelSource);
  checks.push('Changed model bytes suppress stale class definitions while retaining captured SQL and partial field coverage; dark and light rendering remains usable');
  assert.deepEqual(rendererErrors,[]);const report={passed:true,checks,fixture,evidence,rendererErrors,runAt:new Date().toISOString()};await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:false,checks,error:error.stack,stderr,rendererErrors},null,2));if(shell)await shell.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});console.error('Acceptance artifacts: '+evidence);throw error;}
finally{
  try{if(app)await app.close();if(vite)await vite.close();}finally{
    try{if(backend&&backend.exitCode===null){const closed=once(backend,'exit');backend.kill();await Promise.race([closed,pause(5000)]);}}finally{
      const ownsServer=postgresStarted||await stat(path.join(postgresData,'postmaster.pid')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      try{if(ownsServer)await pgCommand('pg_ctl',['stop','-D',postgresData,'-m','fast','-w']);}finally{await unlink(passwordFile).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
  }
}
