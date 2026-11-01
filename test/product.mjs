import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile,readFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
const require=createRequire(import.meta.url),root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const evidence=path.join(root,'evidence');await mkdir(evidence,{recursive:true});await mkdir(path.join(root,'.tmp'),{recursive:true});
const profile='product-'+Date.now();
const env={...process.env,TRACE_ATLAS_TEST_PROFILE:profile,ORIVO_START_MODE:'welcome',ORIVO_TEST_SINGLE_INSTANCE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const projectRoot=await mkdtemp(path.join(root,'.tmp','product-source-'));
await writeFile(path.join(projectRoot,'app.js'),'// PRIVATE SOURCE: never belongs in diagnostics\nexport const label="Sample";\nexport function PatientCard(){return <h1>{label}</h1>}\n');
let holdNextNavigation=false,heldResponse=null,navigationHeld;
function respond(response){response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><h1 data-trace-id="sample">External project</h1>');}
const server=createServer((request,response)=>{if(holdNextNavigation&&request.url==='/'){holdNextNavigation=false;heldResponse=response;navigationHeld?.();return;}respond(response);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
let app;
const checks=[],rendererErrors=[];
async function launch(){app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>rendererErrors.push(error.stack||error.message));return page;}
async function waitForWorkspace(page,id){await page.waitForFunction(()=>!document.querySelector('.workspace-open').disabled);const current=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(current.workspaceId,id);assert.equal(current.url,url);assert.equal(current.loading,false);}
try{
 let page=await launch();
 await page.locator('#welcome-dialog[open]').waitFor();
 let state=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(state.url,'');assert.equal(state.repository,null);assert.equal(state.onboarding,true);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()),false);
 checks.push('First launch stays local and does not open a demo, saved URL, or repository');
 const second=spawn(process.execPath,[path.join(root,'scripts','launch.mjs')],{env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let secondOutput='';second.stdout.on('data',chunk=>secondOutput+=chunk);second.stderr.on('data',chunk=>secondOutput+=chunk);
 let secondTimer;
 const existing=await Promise.race([new Promise((resolve,reject)=>{second.on('message',message=>{if(message.type==='trace-atlas:existing')resolve(true);});second.on('error',reject);second.on('exit',code=>{if(code!==0)reject(Error(secondOutput));});}),new Promise((_,reject)=>{secondTimer=setTimeout(()=>reject(Error('Second launch did not hand off')),15000);})]).finally(()=>clearTimeout(secondTimer));
 assert.equal(existing,true);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
 checks.push('Repeated launch hands off to the existing window without a false startup failure');
 await page.locator('#welcome-open').click();
 await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},projectRoot);
 await page.locator('#dialog-connect').click();
 await page.waitForFunction(()=>window.traceAtlas.getState().then(state=>!!state.repository));
 await page.locator('#project-url').fill(url);await page.locator('#project-workspace-name').fill('Acceptance project');await page.locator('#project-open-button').click();
 await page.waitForFunction(url=>window.traceAtlas.getState().then(state=>state.url===url&&!state.loading),url);
 await page.locator('#save-workspace').click();
 await page.waitForFunction(()=>window.traceAtlas.getWorkspaces().then(items=>items.length===1));
 const [saved]=await page.evaluate(()=>window.traceAtlas.getWorkspaces());assert.equal(saved.url,url);assert.equal(saved.repositoryPath,projectRoot);
 checks.push('A separate source folder and running app can be connected and saved through the real setup UI');
 await page.locator('#tab-project').click();
 await page.locator('.project-map-row').filter({hasText:'PatientCard'}).waitFor();
 assert.match(await page.locator('#project-map-status').textContent(),/source-only/i);
 await page.locator('.project-map-row').filter({hasText:'PatientCard'}).click();
 await page.locator('#project-map-source:not([hidden])').waitFor();
 assert.match(await page.locator('#project-map-source-code').textContent(),/PatientCard/);
 assert.equal((await page.evaluate(()=>window.traceAtlas.getProjectMap())).cached,true);
 await page.locator('#project-map-clear').click();
 await page.locator('#project-map-status').filter({hasText:'cleared'}).waitFor();
 await page.locator('#project-map-scan').click();
 await page.locator('.project-map-row').filter({hasText:'PatientCard'}).waitFor();
 checks.push('Local project map finds a React component, verifies its current source excerpt, caches only metadata, and clears/rebuilds its index');
 await page.keyboard.press('Escape');
 const captured=await page.evaluate(()=>window.traceAtlas.capture('[data-trace-id="sample"]'));assert.notEqual(captured.coverage,'complete');
 await page.evaluate(()=>window.traceAtlas.inspect());
 await page.evaluate(()=>window.traceAtlas.connectRepository());
 state=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(state.inspectMode,false);
 assert.equal(await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(item=>item.getURL()===url).executeJavaScript('typeof globalThis.__traceAtlasPickerCleanupV1'),url),'undefined');
 await assert.rejects(page.evaluate(id=>window.traceAtlas.exportTrace(id),captured.id),/captured session/);
 checks.push('Changing source cleans up the picker and prevents stale trace export');
 const beforeMissing=await page.evaluate(()=>window.traceAtlas.getState());const moved=projectRoot+'-moved';await rename(projectRoot,moved);
 try{
  await page.locator('#nav-home').click();await page.locator('#welcome-dialog[open]').waitFor();await page.locator('.workspace-open').click();
  await page.waitForFunction(()=>!document.querySelector('#welcome-dialog').open&&[...document.querySelectorAll('#toast-region .toast.error')].some(toast=>toast.textContent.includes('unavailable'))&&!document.querySelector('.workspace-open').disabled);
  const after=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(after.contextRevision,beforeMissing.contextRevision);assert.equal(after.url,beforeMissing.url);
 }finally{await rename(moved,projectRoot);}
 checks.push('A failed recent-project click closes Welcome, reports the missing source folder, and preserves the active workspace');
 await page.locator('#nav-home').click();await page.locator('#welcome-dialog[open]').waitFor();await page.locator('.workspace-open').click();
 await waitForWorkspace(page,saved.id);
 assert.equal(await page.locator('#welcome-dialog').evaluate(dialog=>dialog.open),false);
 checks.push('A failed recent-project open resets its busy state and can be retried successfully');
 await page.evaluate(url=>Promise.all([window.traceAtlas.openDemo(),window.traceAtlas.openApp(url)]),url);
 state=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(state.url,url);assert.equal(state.demo,false);
 checks.push('Rapid demo and application commands preserve the latest user request');
 const diagnosticFile=path.join(evidence,'product-diagnostics.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},diagnosticFile);
 await page.evaluate(()=>window.traceAtlas.exportDiagnostics());
 const diagnostic=await readFile(diagnosticFile,'utf8');assert.ok(!diagnostic.includes(projectRoot)&&!diagnostic.includes('PRIVATE SOURCE'));
 checks.push('Diagnostic exports contain no source snippets or absolute repository paths');
 await app.close();app=null;page=await launch();
 await page.locator('#welcome-dialog[open]').waitFor();
 state=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(state.url,'');assert.equal(state.repository,null);
 assert.equal((await page.evaluate(()=>window.traceAtlas.getWorkspaces()))[0].id,saved.id);
 const navigationStarted=new Promise(resolve=>{navigationHeld=resolve;});holdNextNavigation=true;
 await page.locator('.workspace-open').click();
 let navigationTimer;
 try{
  await Promise.race([navigationStarted,new Promise((_,reject)=>{navigationTimer=setTimeout(()=>reject(Error('Recent project did not request its saved application')),20000);})]);
  assert.equal(await page.locator('#welcome-dialog').evaluate(dialog=>dialog.open),false);
  state=await page.evaluate(()=>window.traceAtlas.getState());assert.equal(state.loading,true);assert.equal(state.url,url);
 }finally{clearTimeout(navigationTimer);navigationHeld=null;if(heldResponse){respond(heldResponse);heldResponse=null;}}
 await waitForWorkspace(page,saved.id);
 checks.push('A recent-project click closes Welcome before the saved application finishes loading');
 const restoredTrace=await page.evaluate(()=>window.traceAtlas.capture('[data-trace-id="sample"]'));
 assert.ok(restoredTrace?.id);
 await page.waitForFunction(()=>document.querySelector('#trace-id').textContent.startsWith('TRC'));
 const recovery=await app.evaluate(({BrowserWindow,dialog})=>new Promise(resolve=>{
  const contents=BrowserWindow.getAllWindows()[0].webContents;dialog.showMessageBox=async()=>({response:0});
  contents.once('did-finish-load',async()=>{let latest;for(let attempts=0;attempts<100;attempts++){latest=await contents.executeJavaScript('({traceId:document.querySelector("#trace-id")?.textContent,errors:document.querySelector("#toast-region")?.textContent})').catch(error=>({error:error.message}));if(latest?.traceId?.startsWith('TRC')){const state=await contents.executeJavaScript('window.traceAtlas.getState()');resolve({traceId:latest.traceId,state});return;}await new Promise(resolve=>setTimeout(resolve,50));}resolve({failed:true,latest});});
  contents.forcefullyCrashRenderer();
 }));
 assert.ok(recovery?.traceId,JSON.stringify(recovery));assert.equal(recovery.state.workspaceId,saved.id);
 assert.ok(restoredTrace.id);
 checks.push('Saved projects survive restart and the current captured path survives workspace renderer recovery');
 const remaining=await app.evaluate(async({BrowserWindow},id)=>{const contents=BrowserWindow.getAllWindows()[0].webContents;await contents.executeJavaScript('window.traceAtlas.removeWorkspace('+JSON.stringify(id)+')');return contents.executeJavaScript('window.traceAtlas.getWorkspaces()');},saved.id);assert.deepEqual(remaining,[]);
 await writeFile(path.join(evidence,'product-result.json'),JSON.stringify({passed:true,checks,runAt:new Date().toISOString()},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
}catch(error){await writeFile(path.join(evidence,'product-result.json'),JSON.stringify({passed:false,error:error.stack,checks,rendererErrors},null,2));if(app){const page=await app.firstWindow().catch(()=>null);await page?.screenshot({path:path.join(evidence,'product-failure.png')}).catch(()=>{});}throw error;}
finally{if(app)await app.close();await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});await rm(projectRoot,{recursive:true,force:true});}
