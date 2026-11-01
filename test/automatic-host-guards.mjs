// Exercise the real Electron host's asynchronous guards with a controlled
// attachment manager. The fixture, bootstrap and profile stay under .tmp.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url), id = 'automatic-host-guards-' + Date.now();
const artifacts = path.join(root, '.tmp', id), fixture = path.join(artifacts, 'project');
await mkdir(fixture, { recursive: true });
const source = '// Independent application source remains unchanged.\nexport const title="Host guard fixture";\n';
await writeFile(path.join(fixture, 'app.js'), source);
const servers = [];
async function server(title) {
  const value = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>' + title + '</title></head><body><h1>' + title + '</h1></body></html>');
  });
  await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  servers.push(value);
  return 'http://127.0.0.1:' + value.address().port + '/';
}
const managed = await server('Managed attachment fixture'), other = await server('Other application origin');
const originalApp = await server('Original uninstrumented development app');
const bootstrap = path.join(artifacts, 'bootstrap.cjs');
await writeFile(bootstrap, `const Module=require('node:module');
const {app,BrowserWindow}=require('electron');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};BrowserWindow.prototype.moveTop=function(){};
app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));
const main=${JSON.stringify(path.join(root, 'main.cjs'))};
const actualSecurity=require(${JSON.stringify(path.join(root, 'host-security.cjs'))});
const original=Module._load;
const control=global.__orivoHostGuards={starts:0,stops:0,active:false,gate:null,entered:false,release:null};
const security={...actualSecurity,async rescanRepository(...args){
  if(control.gate){control.gate=null;control.entered=true;await new Promise(resolve=>{control.release=resolve;});}
  return actualSecurity.rescanRepository(...args);
}};
const manager={createAutoAttach({onState}){
  let repository=null;
  const snapshot=()=>({status:control.active?'running':'stopped',active:control.active,url:control.active?${JSON.stringify(managed)}:null,requestedUrl:${JSON.stringify(originalApp)},urlMode:'separate',frontend:'vite:frontend',backend:'python:backend:fixture:app',notice:'Controlled host guard fixture',output:''});
  return {
    async detect(){return {supported:true,frontends:[{id:'vite:frontend',supported:true}],backends:[{id:'python:backend:fixture:app'}],selected:{frontend:'vite:frontend',backend:'python:backend:fixture:app'},requiresSelection:false,issues:[]};},
    async start(folder){control.starts++;repository=folder;control.active=true;const state=snapshot();onState(folder,state);return state;},
    async stop(folder){control.stops++;control.active=false;const state=snapshot();onState(folder,state);return state;},
    async state(){return snapshot();},
    async close(){control.active=false;if(repository)onState(repository,snapshot());}
  };
}};
Module._load=function(request,parent,isMain){
  if(parent?.filename===main&&request==='./host-security.cjs')return security;
  if(parent?.filename===main&&request==='./adapters/tracing/auto-attach.cjs')return manager;
  return original.apply(this,arguments);
};
require(main);
`);
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: id, ORIVO_START_MODE: 'welcome' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const checks = [], rendererErrors = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(35); }
  throw Error(message);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 });
  const shell = await app.firstWindow();
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.waitForFunction(() => typeof window.traceAtlas?.startAttachment === 'function');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  const selections = { frontend: 'vite:frontend', backend: 'python:backend:fixture:app' };
  const stats = () => app.evaluate(() => ({ starts: global.__orivoHostGuards.starts, stops: global.__orivoHostGuards.stops, active: global.__orivoHostGuards.active }));
  const arm = () => app.evaluate(() => { const control = global.__orivoHostGuards; control.gate = {}; control.entered = false; control.release = null; });
  const release = () => app.evaluate(() => { const control = global.__orivoHostGuards; control.release(); control.release = null; });
  const entered = () => until(() => app.evaluate(() => global.__orivoHostGuards.entered), 'Attachment did not enter the controlled source-rescan barrier');
  const start = () => shell.evaluate(options => window.traceAtlas.startAttachment(options).then(() => ({ ok: true }), error => ({ error: error.message })), selections);
  const hostReady = url => until(async () => { const state = await shell.evaluate(() => window.traceAtlas.getState()); return state.url === url && !state.loading ? state : false; }, 'The host did not retain its expected preview URL');

  await arm();
  const first = start();
  await entered();
  const second = await start();
  assert.match(second.error, /Wait for the current attachment operation/);
  assert.deepEqual(await stats(), { starts: 0, stops: 0, active: false });
  await release();
  assert.deepEqual(await first, { ok: true });
  await hostReady(managed);
  assert.deepEqual(await stats(), { starts: 1, stops: 0, active: true });
  checks.push('A second concurrent start is rejected during source preflight; exactly one manager job starts and the rejected request never stops it');

  const originalRoute=new URL('rooms?floor=2#available',originalApp).href,managedRoute=new URL('rooms?floor=2#available',managed).href;
  await shell.evaluate(url=>window.traceAtlas.openApp(url),originalRoute);
  await hostReady(managedRoute);
  assert.deepEqual(await stats(),{starts:1,stops:0,active:true});
  await app.evaluate(async({webContents},from)=>{const preview=webContents.getAllWebContents().find(w=>w.getURL()===from);await preview.executeJavaScript('setTimeout(()=>location.hash="later-route",100)');},managedRoute);
  await until(async()=>(await shell.evaluate(()=>window.traceAtlas.getState())).pageRuntime==='missing','Runtime checking did not finish after an SPA hash change');
  const originalLink=new URL('guests?search=ada',originalApp).href,managedLink=new URL('guests?search=ada',managed).href;
  await app.evaluate(async({webContents},{from,to})=>{const preview=webContents.getAllWebContents().find(w=>w.getURL().startsWith(from));await preview.executeJavaScript('location.href='+JSON.stringify(to));},{from:new URL(managed).origin,to:originalLink});
  await hostReady(managedLink);
  await shell.evaluate(url=>window.traceAtlas.openApp(url),managed);await hostReady(managed);
  checks.push('Original development URLs entered in the address field or followed as links retain managed tracing and preserve routes; SPA hash changes do not strand runtime checking');

  await shell.evaluate(() => window.traceAtlas.stopAttachment());
  await app.evaluate(() => { global.__orivoHostGuards.starts = 0; global.__orivoHostGuards.stops = 0; });
  await arm();
  const stale = start();
  await entered();
  const latestUrl = new URL('newer-view', other).href;
  await shell.evaluate(url => window.traceAtlas.openApp(url), latestUrl);
  await hostReady(latestUrl);
  await release();
  assert.match((await stale).error, /The project changed/);
  assert.equal((await stats()).starts, 0);
  assert.equal((await shell.evaluate(() => window.traceAtlas.getState())).url, latestUrl);
  checks.push('Opening a newer page in the same source project invalidates a gated attachment request before any managed job starts');

  assert.deepEqual(await start(), { ok: true });
  await hostReady(managed);
  const beforeNavigation = await stats();
  const externalUrl = new URL('external-page', other).href;
  await assert.rejects(shell.evaluate(url => window.traceAtlas.openApp(url), externalUrl), /Stop the current tracing session/);
  assert.equal((await shell.evaluate(() => window.traceAtlas.getState())).url, managed);
  assert.deepEqual(await stats(), beforeNavigation);
  await app.evaluate(async ({ webContents }, { from, to }) => {
    const preview = webContents.getAllWebContents().find(contents => contents.getURL() === from);
    await preview.executeJavaScript('location.href='+JSON.stringify(to));
  }, { from: managed, to: externalUrl });
  await pause(400);
  assert.equal((await shell.evaluate(() => window.traceAtlas.getState())).url, managed);
  checks.push('Opening an unrelated app through the address field or an application link is blocked without stopping the owned session');
  // Native loadURL deliberately bypasses will-navigate. Health must still
  // describe the actual page honestly if privileged host code changes it.
  await app.evaluate(async ({ webContents }, { from, to }) => {
    const preview = webContents.getAllWebContents().find(contents => contents.getURL() === from);
    if (!preview) throw Error('The controlled managed preview is missing');
    await preview.loadURL(to);
  }, { from: managed, to: externalUrl });
  const external = await hostReady(externalUrl);
  assert.equal(external.attachment.status, 'running');
  assert.equal(external.attachment.active, true);
  await until(async () => (await shell.evaluate(() => window.traceAtlas.getState())).pageRuntime === 'missing', 'Uninstrumented page was not reported as missing its runtime');
  assert.equal(await shell.locator('#attach-button').innerText(), 'Runtime missing');
  assert.deepEqual(await stats(), beforeNavigation, 'A native cross-origin navigation keeps the managed session alive');
  const saved = await shell.evaluate(() => window.traceAtlas.saveWorkspace({ name: 'External page after managed navigation' }));
  assert.equal(saved.url, externalUrl);
  assert.equal(Object.hasOwn(saved, 'attachment'), false);
  const stored = await shell.evaluate(() => window.traceAtlas.getWorkspaces());
  assert.equal(stored.find(row => row.id === saved.id).attachment, undefined);
  checks.push('Native preview navigation to another origin keeps the managed session running while saved workspace metadata omits automatic attachment selections');

  assert.equal(await readFile(path.join(fixture, 'app.js'), 'utf8'), source);
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, checks, rendererErrors, artifacts, runAt: new Date().toISOString() };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, checks, rendererErrors, error: error.stack }, null, 2));
  console.error('Host guard artifacts: ' + artifacts);
  throw error;
} finally {
  if (app) await app.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
