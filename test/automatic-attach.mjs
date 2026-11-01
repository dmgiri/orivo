// A normal independent project: no copied SDK, source hooks, or server startup
// commands. Orivo itself detects and owns both development servers.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url), runFile = promisify(execFile);
const python = process.env.ORIVO_FIXTURE_PYTHON, deps = process.env.ORIVO_FIXTURE_DEPS;
assert.ok(python && deps, 'Set ORIVO_FIXTURE_PYTHON and ORIVO_FIXTURE_DEPS to existing local dependencies. No downloads are performed.');
const dependencyRequire = createRequire(path.join(path.resolve(deps), 'package.json'));
const versions = Object.fromEntries(['react', 'react-dom', 'vite'].map(name => [name, dependencyRequire(`${name}/package.json`).version]));
const runId = 'automatic-' + Date.now(), base = path.join(root, '.tmp', 'product-fixture');
const fixture = path.join(base, runId), evidence = path.join(base, runId + '-evidence');
const pgRoot = path.join(base, runId + '-postgres'), pgData = path.join(pgRoot, 'data');
const passwordFile = path.join(pgRoot, 'password.tmp');
await mkdir(path.join(fixture, 'frontend/src'), { recursive: true });
await mkdir(path.join(fixture, 'backend/src/shipment_app'), { recursive: true });
await mkdir(evidence, { recursive: true });
await mkdir(pgRoot, { recursive: true });
await symlink(path.dirname(path.dirname(await realpath(python))), path.join(fixture, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
for (const name of ['react', 'react-dom', 'scheduler', 'vite']) {
  await mkdir(path.join(fixture, 'frontend/node_modules'), { recursive: true });
  await symlink(await realpath(path.dirname(dependencyRequire.resolve(`${name}/package.json`))), path.join(fixture, 'frontend/node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
}
await writeFile(path.join(fixture, 'frontend/package.json'), JSON.stringify({ name: 'unmodified-shipment-product', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite } }, null, 2));
await writeFile(path.join(fixture, 'frontend/index.html'), '<!doctype html><html><head><title>Independent automatic shipment app</title></head><body><div id="root"></div><script type="module" src="/src/Shipments.jsx"></script></body></html>');
await writeFile(path.join(fixture, 'frontend/vite.config.mjs'), "export default {server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:18357'}}};\n");
const frontend = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
function Shipments(){
  const [shipment,setShipment]=useState(null);
  useEffect(()=>{window.loadShipment=async(computed=false)=>{const body=await fetch('/api/shipments'+(computed?'?computed=true':'')).then(response=>response.json());setShipment(body.shipments[0]);};window.loadShipment();},[]);
  if(!shipment)return <p>Loading shipment</p>;
  return <main style={{fontFamily:'system-ui',padding:28}}><h1>Shipment tracker</h1><p>Reference</p><strong id="shipment-reference">{shipment.displayLabel}</strong></main>;
}
createRoot(document.getElementById('root')).render(<Shipments/>);
`;
await writeFile(path.join(fixture, 'frontend/src/Shipments.jsx'), frontend);
await writeFile(path.join(fixture, 'backend/requirements.txt'), 'fastapi\nuvicorn\nsqlalchemy\npsycopg\n');
await writeFile(path.join(fixture, 'backend/src/shipment_app/__init__.py'), '');
const projection = `from pydantic import BaseModel,Field
class ShipmentOutput(BaseModel):
    label:str=Field(serialization_alias='displayLabel')
class ShipmentEnvelope(BaseModel):
    shipments:list[ShipmentOutput]
def project(record,computed=False):
    if computed:
        return ShipmentOutput(label=record.reference.upper())
    return ShipmentOutput(label=record.reference)
`;
await writeFile(path.join(fixture, 'backend/src/shipment_app/projection.py'), projection);
const backend = `from contextlib import asynccontextmanager
from types import SimpleNamespace
import os
from fastapi import FastAPI
from sqlalchemy import String,create_engine,select
from sqlalchemy.orm import DeclarativeBase,Mapped,mapped_column,sessionmaker
from .projection import ShipmentEnvelope,project
class Base(DeclarativeBase): pass
class ShipmentRecord(Base):
    __tablename__='shipment_records'
    __table_args__={'schema':'public'}
    id:Mapped[int]=mapped_column(primary_key=True)
    reference:Mapped[str]=mapped_column(String(80))
def create_app():
    @asynccontextmanager
    async def lifespan(app):
        engine=create_engine(os.environ['ORIVO_FIXTURE_DATABASE_URL'])
        sessions=sessionmaker(engine)
        Base.metadata.create_all(engine)
        with sessions.begin() as session:
            if session.get(ShipmentRecord,8) is None:
                session.add(ShipmentRecord(id=8,reference='SH-2048'))
        app.state.database=SimpleNamespace(engine=engine,session_factory=sessions)
        try: yield
        finally: engine.dispose()
    app=FastAPI(lifespan=lifespan)
    @app.get('/api/shipments',response_model=ShipmentEnvelope)
    def shipments(computed:bool=False):
        with app.state.database.session_factory() as session:
            record=session.scalars(select(ShipmentRecord).where(ShipmentRecord.id==8)).one()
            return ShipmentEnvelope(shipments=[project(record,computed)])
    return app
`;
await writeFile(path.join(fixture, 'backend/src/shipment_app/main.py'), backend);
assert.equal(/studio_tracing|@orivo|__studioFlow/.test(frontend + backend + projection), false, 'The ordinary application contains zero tracing hooks');
async function sourceSnapshot(directory = fixture, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.venv') continue;
    const name = prefix + entry.name, absolute = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Unexpected project source link');
    if (entry.isDirectory()) Object.assign(result, await sourceSnapshot(absolute, name + '/'));
    else result[name] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return result;
}
const original = await sourceSnapshot(), checks = [], errors = [];
const postgresBin = process.env.ORIVO_POSTGRES_BIN || 'C:\\Program Files\\PostgreSQL\\17\\bin';
async function pgCommand(program, args) {
  const executable = path.join(postgresBin, program + (process.platform === 'win32' ? '.exe' : ''));
  if (program !== 'pg_ctl' || args[0] !== 'start') return runFile(executable, args, { cwd: evidence, windowsHide: true, timeout: 45000, maxBuffer: 1048576 });
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: evidence, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Fixture PostgreSQL did not start')); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Fixture pg_ctl exited ' + code)); });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(70); }
  throw Error(message);
}
async function reservePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function decodeHeader(header) { const packed = header.startsWith('z1.'); const raw = Buffer.from(packed ? header.slice(3) : header, 'base64'); const trace=JSON.parse((packed ? inflateSync(raw) : raw).toString()); if(trace.ref==='orivo-managed-v1'){const response=await fetch(new URL('/__orivo_trace/'+trace.key,currentUrl));assert.equal(response.status,200);const stored=await response.json();assert.equal(stored.id,trace.id);return stored;}return trace; }
async function closed(port) { try { await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(400) }); return false; } catch { return true; } }
let app, manager, requestedServer, pgStarted = false;
const ports = [];
try {
  const password = randomBytes(24).toString('hex');
  await writeFile(passwordFile, password + '\n');
  await pgCommand('initdb', ['-D', pgData, '--username=orivo_fixture', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile=' + passwordFile]);
  await unlink(passwordFile);
  const pgPort = await reservePort();
  await pgCommand('pg_ctl', ['start', '-D', pgData, '-l', path.join(pgRoot, 'server.log'), '-w', '-o', `-h 127.0.0.1 -p ${pgPort} -c fsync=off -c synchronous_commit=off -c max_connections=12`]);
  pgStarted = true;
  const databaseUrl = `postgresql+psycopg://orivo_fixture:${password}@127.0.0.1:${pgPort}/postgres`;
  const mode = process.argv.includes('--http-only') ? 'http-only' : 'native';
  const requestedUrl = `http://localhost:${await reservePort()}/?view=trace#shipments`;
  let currentUrl;
  if (mode === 'http-only') {
    const { createAutoAttach } = require('../adapters/tracing/auto-attach.cjs');
    const previous = process.env.ORIVO_FIXTURE_DATABASE_URL;
    process.env.ORIVO_FIXTURE_DATABASE_URL = databaseUrl;
    try {
      manager = createAutoAttach({ runtimeDirectory: path.join(evidence, 'runtime') });
      const detected = await manager.detect(fixture);
      assert.ok(detected.selected.frontend && detected.selected.backend);
      assert.deepEqual(detected.issues, []);
      const started = await manager.start(fixture, { url: requestedUrl });
      assert.equal(started.status, 'running', JSON.stringify(started));
      currentUrl = started.url;
      assert.equal(currentUrl, requestedUrl, 'Automatic attachment preserves the supplied hostname, port, path, query and fragment');
    } finally { if (previous === undefined) delete process.env.ORIVO_FIXTURE_DATABASE_URL; else process.env.ORIVO_FIXTURE_DATABASE_URL = previous; }
  } else {
    const entry = path.join(evidence, 'electron-acceptance.cjs');
    await writeFile(entry, `const {app,BrowserWindow}=require('electron');\nBrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};BrowserWindow.prototype.moveTop=function(){};\napp.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));\nrequire(${JSON.stringify(path.join(root, 'main.cjs'))});\n`);
    const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: runId, ORIVO_START_MODE: 'welcome', ORIVO_FIXTURE_DATABASE_URL: databaseUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require('electron'), args: [entry], env, timeout: 30000 });
    const shell = await app.firstWindow();
    shell.setDefaultTimeout(35000);
    shell.on('pageerror', error => errors.push(error.message));
    await shell.waitForFunction(() => typeof window.traceAtlas?.detectAttachment === 'function');
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await shell.evaluate(() => window.traceAtlas.connectRepository());
    await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    const detected = await shell.evaluate(() => window.traceAtlas.detectAttachment());
    assert.equal(detected.frontends.filter(row => row.supported).length, 1);
    assert.equal(detected.backends.length, 1);
    assert.equal(detected.backends[0].factory, true);
    assert.deepEqual(detected.issues, []);
    requestedServer = createHttpServer((_request, response) => { response.setHeader('Connection', 'close'); response.end('Existing development server remains running'); });
    await new Promise((resolve, reject) => { requestedServer.once('error', reject); requestedServer.listen(Number(new URL(requestedUrl).port), '127.0.0.1', resolve); });
    await shell.locator('#connect-top').click();
    await shell.locator('#project-url').fill(requestedUrl);
    await shell.locator('#project-auto-attach').click();
    await shell.locator('#attachment-url-dialog[open]').waitFor();
    const conflict = await shell.evaluate(() => window.traceAtlas.getState());
    assert.equal(conflict.attachment?.errorCode, 'port-in-use');
    assert.equal(conflict.attachment?.active, false, 'A port conflict must be reported before spawning either app server');
    assert.equal(conflict.attachment?.requestedUrl, requestedUrl);
    assert.equal(await shell.locator('#app-url').inputValue(), requestedUrl);
    assert.equal(await shell.locator('#attachment-url-value').textContent(), requestedUrl);
    assert.equal(await (await fetch(requestedUrl)).text(), 'Existing development server remains running');
    await new Promise(resolve => requestedServer.close(resolve));
    requestedServer = null;
    checks.push('An occupied localhost port opens an explicit conflict dialog, preserves the entered URL, and leaves the existing server running without spawning another address');
    await shell.locator('#attachment-url-retry').click();
    const state = await until(async () => {
      const next = await shell.evaluate(() => window.traceAtlas.getState());
      if (next.attachment?.status === 'failed') throw Error(next.attachment.notice + '\n' + next.attachment.output);
      return next.attachment?.status === 'running' && next.url === requestedUrl && !next.loading ? next : false;
    }, 'The automatic preview did not finish opening', 70000);
    currentUrl = state.url;
    assert.equal(currentUrl, requestedUrl);
    assert.equal(await shell.locator('#app-url').inputValue(), requestedUrl);
    await shell.waitForFunction(() => document.querySelector('#attach-button').innerText === 'Runtime connected');
    checks.push('The real Attach automatically button starts both servers without source hooks and keeps the entered localhost address, query and fragment in the address bar');
    const info = await shell.evaluate(() => window.traceAtlas.getProductInfo());
    const automaticDirectory = path.join(info.dataDirectory, 'automatic');
    async function managedPorts() {
      const directories = await readdir(automaticDirectory);
      const found = [];
      for (const directory of directories) for (const filename of ['frontend.json', 'backend.json']) try { const row = JSON.parse(await readFile(path.join(automaticDirectory, directory, filename), 'utf8')); if (row.root === fixture) found.push(row.port); } catch {}
      return [...new Set(found)];
    }
    ports.push(...await managedPorts());
    async function preview() {
      const url = (await shell.evaluate(() => window.traceAtlas.getState())).url;
      const id = await app.evaluate(({ webContents }, value) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(value))?.id, url);
      assert.ok(id, 'The managed project has a native preview');
      return { id, evaluate: script => app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id, script }) };
    }
    let content = await preview();
    await until(() => content.evaluate("document.querySelector('#shipment-reference')?.textContent==='SH-2048'"), 'Managed shipment did not render');
    assert.deepEqual(await content.evaluate('({require:typeof require,process:typeof process,bridge:typeof window.traceAtlas})'), { require: 'undefined', process: 'undefined', bridge: 'undefined' });
    await shell.evaluate(() => { window.__automaticPick = null; window.addEventListener('trace-atlas:graph', event => { window.__automaticPick = event.detail; }); });
    async function pick() {
      await shell.evaluate(() => { window.__automaticPick = null; });
      await shell.locator('#inspect-button').click();
      await shell.locator('#inspect-button.inspecting').waitFor();
      await app.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        const point = await contents.executeJavaScript("(()=>{const r=document.querySelector('#shipment-reference').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      }, content.id);
      await shell.waitForFunction(() => window.__automaticPick);
      return shell.evaluate(() => window.__automaticPick);
    }
    const complete = await pick();
    assert.equal(complete.coverage, 'complete', JSON.stringify(complete.gaps));
    assert.deepEqual(complete.gaps, []);
    assert.ok(complete.nodes.some(node => node.kind === 'source' && node.file === 'frontend/src/Shipments.jsx'));
    assert.ok(complete.nodes.some(node => node.kind === 'backend' && node.file === 'backend/src/shipment_app/main.py'));
    assert.ok(complete.nodes.some(node => node.kind === 'query' && node.code.includes('public.shipment_records')));
    assert.ok(complete.nodes.some(node => node.kind === 'database' && node.label === 'public.shipment_records.reference'));
    assert.equal(complete.nodes.find(node => node.kind === 'api').meta.responseField, 'shipments.0.displayLabel');
    await writeFile(path.join(evidence, 'complete-trace.json'), JSON.stringify(complete, null, 2));
    const restarted = await shell.evaluate(() => window.traceAtlas.restartAndRecapture());
    assert.equal(restarted.recaptured, true, restarted.notice);
    assert.equal(restarted.graph?.coverage, 'complete', JSON.stringify(restarted.graph?.gaps));
    assert.ok(restarted.graph.nodes.some(node => node.kind === 'query'));
    assert.ok(restarted.graph.nodes.some(node => node.kind === 'database' && node.label === 'public.shipment_records.reference'));
    assert.equal(restarted.state.url, requestedUrl, 'Health restart keeps the requested application URL');
    assert.equal(await shell.locator('#app-url').inputValue(), requestedUrl);
    ports.push(...await managedPorts());
    content = await preview();
    await until(() => content.evaluate("document.querySelector('#shipment-reference')?.textContent==='SH-2048'"), 'Health restart did not restore the shipment app');
    checks.push('Health restart keeps the exact localhost URL and automatically recaptures the complete frontend-to-PostgreSQL path');
    checks.push('A genuine native selection proves React JSX → API alias → Python DTO projection → actual PostgreSQL SELECT → public.shipment_records.reference');
    await shell.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    const screenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * 1.5), height: Math.round(bounds.height * 1.5) } });
      const own = sources.find(source => source.id === window.getMediaSourceId());
      return (own && !own.thumbnail.isEmpty() ? own.thumbnail : await window.capturePage()).toPNG().toString('base64');
    });
    await writeFile(path.join(evidence, 'automatic-complete.png'), Buffer.from(screenshot, 'base64'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await content.evaluate('window.loadShipment(true).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const computed = await pick();
    assert.equal(computed.coverage, 'partial');
    assert.equal(computed.nodes.some(node => node.kind === 'database'), false);
    await writeFile(path.join(evidence, 'computed-partial-trace.json'), JSON.stringify(computed, null, 2));
    checks.push('A computed response keeps its real request and SQL while refusing an invented database field origin');
    const initialBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
    await pause(250);
    const minimum = await shell.evaluate(() => {
      const visible = id => { const element = document.getElementById(id), rect = element.getBoundingClientRect(); return !element.hidden && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; };
      return { overflow: document.documentElement.scrollWidth > innerWidth, attach: visible('attach-button'), stop: visible('stop-attachment') };
    });
    assert.deepEqual(minimum, { overflow: false, attach: true, stop: true });
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), initialBounds);
    checks.push('Attach and Stop stay visible at the 1100 × 700 desktop minimum without horizontal page overflow');
    await content.evaluate('window.loadShipment().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const saved = await shell.evaluate(() => window.traceAtlas.saveWorkspace({ name: 'Automatic shipment product' }));
    assert.equal(saved.url, requestedUrl);
    assert.deepEqual(saved.attachment, { frontend: detected.selected.frontend, backend: detected.selected.backend });
    const oldPorts = [...ports];
    await shell.locator('#stop-attachment').click();
    await until(async () => (await shell.evaluate(() => window.traceAtlas.getState())).attachment?.status === 'stopped', 'Stop session did not finish');
    for (const port of oldPorts) await until(() => closed(port), 'Owned server survived Stop session: ' + port);
    checks.push('Stop session closes both owned ports');
    const reopened = await shell.evaluate(id => window.traceAtlas.openWorkspace(id), saved.id);
    assert.equal(reopened.workspaceId, saved.id);
    assert.equal(reopened.attachment.status, 'running');
    assert.equal(reopened.url, requestedUrl, 'Saved workspace restarts the owned frontend at the same requested URL');
    assert.equal(await shell.locator('#app-url').inputValue(), requestedUrl);
    currentUrl = reopened.url;
    ports.push(...await managedPorts());
    content = await preview();
    await until(() => content.evaluate("document.querySelector('#shipment-reference')?.textContent==='SH-2048'"), 'Saved workspace did not restart the normal app');
    const reopenedTrace = await pick();
    assert.equal(reopenedTrace.coverage, 'complete');
    checks.push('A saved automatic workspace restarts the selected app at the exact same localhost URL with the same workspace ID and complete tracing');
    await shell.evaluate(() => window.traceAtlas.stopAttachment());
    for (const port of ports) await until(() => closed(port), 'Owned server survived final stop: ' + port);
  }
  if (mode === 'http-only') {
    const response = await fetch(new URL('/api/shipments', currentUrl), { headers: { 'X-Studio-Trace': randomUUID() } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { shipments: [{ displayLabel: 'SH-2048' }] });
    const execution = await decodeHeader(response.headers.get('Studio-Trace'));
    assert.equal(execution.fields['shipments.0.displayLabel'].table, 'public.shipment_records');
    assert.equal(execution.fields['shipments.0.displayLabel'].column, 'reference');
    assert.equal(execution.fields['shipments.0.displayLabel'].projection.path, 'backend/src/shipment_app/projection.py');
    assert.ok(execution.queries.some(query => query.sql.includes('public.shipment_records')));
    await writeFile(path.join(evidence, 'http-execution.json'), JSON.stringify(execution, null, 2));
    checks.push('Orivo starts the ordinary frontend and Python backend; actual PostgreSQL execution and DTO alias evidence survive its automatic proxy');
    const transformed = await (await fetch(new URL('/src/Shipments.jsx', currentUrl))).text();
    assert.ok(transformed.includes('__studioFlow'));
    await manager.stop(fixture);
    await until(() => closed(Number(new URL(currentUrl).port)), 'Owned frontend survived stop');
  }
  const finalSource = await sourceSnapshot();
  assert.deepEqual(finalSource, original, 'Automatic attachment must leave every original application file and source directory unchanged');
  await writeFile(path.join(evidence, 'source-integrity.json'), JSON.stringify({ unchanged: true, before: original, after: finalSource, excludedDependencyLinks: ['.venv', 'frontend/node_modules'] }, null, 2));
  assert.deepEqual(errors, []);
  checks.push('Application bytes and source file list are identical before and after attachment, capture, stop and restart; no hook files or pycache were created');
  const report = { passed: true, mode, checks, versions, fixture, evidence, rendererErrors: errors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, error: error.stack, rendererErrors: errors }, null, 2));
  console.error('Automatic acceptance artifacts: ' + evidence);
  throw error;
} finally {
  try { if (requestedServer) await new Promise(resolve => requestedServer.close(resolve)); if (app) await app.close(); if (manager) await manager.close(); }
  finally {
    const owned = pgStarted || await stat(path.join(pgData, 'postmaster.pid')).then(() => true, () => false);
    if (owned) await pgCommand('pg_ctl', ['stop', '-D', pgData, '-m', 'fast', '-w']);
    await unlink(passwordFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
