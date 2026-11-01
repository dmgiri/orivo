// Separate-project acceptance: React/Vite + FastAPI response models/SQLAlchemy.
// Environment variables select existing dependencies; nothing is installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const python = process.env.ORIVO_FIXTURE_PYTHON;
assert.ok(python, 'Set ORIVO_FIXTURE_PYTHON to an existing Python environment with FastAPI, SQLAlchemy and Uvicorn. No packages are downloaded.');
const dependencyProject = process.env.ORIVO_FIXTURE_DEPS;
assert.ok(dependencyProject, 'Set ORIVO_FIXTURE_DEPS to an existing project with React, React DOM and Vite. No packages are downloaded.');
const dependencyRequire = createRequire(path.join(path.resolve(dependencyProject), 'package.json'));
const versions = Object.fromEntries(['react', 'react-dom', 'vite'].map(name => [name, dependencyRequire(`${name}/package.json`).version]));
const { createServer } = await import(pathToFileURL(dependencyRequire.resolve('vite')).href);
const fixture = path.join(root, '.tmp', 'product-fixture', `external-python-${Date.now()}`);
const evidence = path.join(fixture, 'acceptance');
await mkdir(path.join(fixture, 'src'), { recursive: true });
await mkdir(evidence);
await mkdir(path.join(fixture, 'node_modules', '@orivo'), { recursive: true });
const kit = path.join(fixture, 'node_modules', '@orivo', 'tracing');
await cp(path.join(root, 'adapters', 'tracing'), kit, { recursive: true, errorOnExist: true });
for (const name of ['react', 'react-dom', 'scheduler']) {
  const manifest = dependencyRequire.resolve(`${name}/package.json`);
  await symlink(await realpath(path.dirname(manifest)), path.join(fixture, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
}
await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'orivo-independent-shipment-acceptance', private: true, type: 'module', dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite, '@orivo/tracing': 'file:node_modules/@orivo/tracing' } }, null, 2));
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Independent shipment application</title></head><body><div id="root"></div><script type="module" src="/src/Shipment.jsx"></script></body></html>');
const client = `import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
function ShipmentReference() {
  const [shipment, setShipment] = useState(null);
  useEffect(() => {
    window.loadShipment = async (mode = '') => {
      const body = await fetch('/api/shipments' + mode).then(response => response.json());
      setShipment(body.shipments[0]);
    };
    window.loadShipment();
  }, []);
  if (!shipment) return <p>Loading shipment</p>;
  return <main style={{fontFamily:'system-ui',padding:24}}><h1>Shipment tracker</h1><p>Reference</p><strong id="shipment-reference">{shipment.label}</strong></main>;
}
createRoot(document.getElementById('root')).render(<ShipmentReference />);
`;
const sourceFile = path.join(fixture, 'src', 'Shipment.jsx');
await writeFile(sourceFile, client);
const serverSource = `from __future__ import annotations
import base64
import json
import socket
import zlib
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool
import studio_tracing
import uvicorn

ROOT = Path(__file__).resolve().parent
class Base(DeclarativeBase):
    pass
class ShipmentRecord(Base):
    __tablename__ = 'shipment_records'
    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(80))

class ShipmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    label: str = Field(validation_alias='reference')

class ShipmentsResponse(BaseModel):
    shipments: list[ShipmentResponse]

engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)
with Session.begin() as session:
    session.add_all([ShipmentRecord(id=8, reference='SH-2048'), ShipmentRecord(id=9, reference='SH-4096')])
app = FastAPI()
detach = studio_tracing.setup(app, ROOT, development=True, engine=engine, sessions=Session, response_models=True)

@app.middleware('http')
async def mismatch_for_acceptance(request, call_next):
    response = await call_next(request)
    encoded = response.headers.get('Studio-Trace')
    if encoded and request.query_params.get('mismatch') == '1':
        packed = encoded.startswith('z1.')
        raw = base64.b64decode(encoded[3:] if packed else encoded)
        payload = json.loads(zlib.decompress(raw) if packed else raw)
        payload['id'] = 'different-request-acceptance'
        response.headers['Studio-Trace'] = base64.b64encode(json.dumps(payload).encode()).decode()
    return response

@app.get('/api/shipments', response_model=ShipmentsResponse)
def shipment_list():
    with Session() as session:
        record = session.scalars(select(ShipmentRecord).where(ShipmentRecord.id == 8)).one()
        return {'shipments':[record]}

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
const backendFile = path.join(fixture, 'shipment_api.py');
await writeFile(backendFile, serverSource);
const backend = spawn(python, ['-u', backendFile], { cwd: fixture, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: kit }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', app, vite;
backend.stdout.on('data', chunk => { stdout += chunk; });
backend.stderr.on('data', chunk => { stderr += chunk; });
const checks = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message, timeout = 25000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const result = await check();
    if (result) return result;
    if (backend.exitCode !== null) throw Error(`Python fixture exited (${backend.exitCode}): ${stderr}`);
    await pause(60);
  }
  throw Error(`${message}\n${stderr}`);
}
try {
  const backendUrl = await until(() => { try { return JSON.parse(stdout.split('\n')[0]).url; } catch { return false; } }, 'Python fixture did not report its ephemeral URL');
  await until(async () => { try { return (await fetch(`${backendUrl}/api/shipments`)).ok; } catch { return false; } }, 'Python fixture did not start HTTP');
  const normal = await fetch(`${backendUrl}/api/shipments`);
  assert.equal(normal.headers.get('Studio-Trace'), null);
  assert.deepEqual(await normal.json(), { shipments: [{ label: 'SH-2048' }] });
  checks.push('Independent FastAPI/SQLAlchemy app preserves its normal response and emits no trace without a correlation header');
  const studioTracing = (await import(pathToFileURL(path.join(kit, 'vite.mjs')).href)).default;
  vite = await createServer({ configFile: false, root: fixture, plugins: [studioTracing({ repositoryRoot: fixture, enabled: true })], server: { host: '127.0.0.1', port: 0, proxy: { '/api': backendUrl }, watch: { ignored: ['**'] } }, logLevel: 'warn' });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const transformed = await (await fetch(`${url}/src/Shipment.jsx`)).text();
  assert.ok(transformed.includes('__studioFlow'), 'The copied Vite plugin instruments original React JSX.');
  const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `external-python-${Date.now()}`, ORIVO_START_MODE: 'welcome' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  const shell = await app.firstWindow();
  shell.setDefaultTimeout(25000);
  const errors = [];
  shell.on('pageerror', error => errors.push(error.message));
  await shell.waitForFunction(() => typeof window.traceAtlas?.getState === 'function');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
  await shell.evaluate(value => window.traceAtlas.openApp(value), url);
  const previewId = await app.evaluate(({ webContents }, value) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(value))?.id, url);
  assert.ok(previewId, 'The independent project opens in the native preview');
  const previewEval = script => app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id: previewId, script });
  await until(() => previewEval("document.querySelector('#shipment-reference')?.textContent === 'SH-2048'"), 'Shipment reference did not render');
  assert.deepEqual(await previewEval('({require:typeof require,process:typeof process,bridge:typeof window.traceAtlas})'), { require: 'undefined', process: 'undefined', bridge: 'undefined' });
  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await shell.evaluate(() => { window.__shipmentPick = null; window.addEventListener('trace-atlas:graph', event => { window.__shipmentPick = event.detail; }); });
  await shell.locator('#inspect-button').click();
  await shell.locator('#inspect-button.inspecting').waitFor();
  await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    const point = await contents.executeJavaScript("(()=>{const r=document.querySelector('#shipment-reference').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }, previewId);
  await shell.waitForFunction(() => window.__shipmentPick?.coverage === 'complete');
  const graph = await shell.evaluate(() => window.__shipmentPick);
  assert.equal(graph.coverage, 'complete');
  assert.ok(graph.nodes.some(node => node.kind === 'source' && node.file === 'src/Shipment.jsx'));
  assert.ok(graph.nodes.some(node => node.kind === 'backend' && node.file === 'shipment_api.py'));
  assert.ok(graph.nodes.some(node => node.kind === 'query' && node.code.includes('shipment_records')));
  assert.ok(graph.nodes.some(node => node.kind === 'database' && node.label === 'shipment_records.reference'));
  assert.equal(graph.nodes.find(node => node.kind === 'api').meta.responseField, 'shipments.0.label');
  assert.deepEqual(graph.gaps, []);
  assert.equal(await shell.locator('#trace-graph .node-missing').count(), 0);
  checks.push('Genuine native pick -> automatically instrumented React JSX -> same-origin JSON field -> FastAPI response_model alias -> actual SQLAlchemy SQLite query -> shipment_records.reference, without per-field serialization calls');
  await writeFile(path.join(evidence, 'complete-trace.json'), JSON.stringify(graph, null, 2));
  await shell.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const screenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * 1.5), height: Math.round(bounds.height * 1.5) } });
    const own = sources.find(source => source.id === window.getMediaSourceId());
    return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(evidence, 'python-complete.png'), Buffer.from(screenshot, 'base64'));

  await writeFile(backendFile, serverSource + '\n# Repository source changed after the captured request.\n');
  const staleBackend = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
  assert.equal(staleBackend.coverage, 'partial');
  assert.equal(staleBackend.nodes.some(node => node.kind === 'database'), false);
  assert.ok(staleBackend.nodes.some(node => node.kind === 'source'));
  checks.push('Stale independent backend source invalidates database claims while preserving the observed frontend/request path');
  await writeFile(path.join(evidence, 'stale-backend-trace.json'), JSON.stringify(staleBackend, null, 2));
  await previewEval('window.loadShipment().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  const staleLoadedBackend = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
  assert.equal(staleLoadedBackend.coverage, 'partial');
  assert.equal(staleLoadedBackend.nodes.some(node => node.kind === 'database'), false);
  assert.equal(staleLoadedBackend.nodes.some(node => node.kind === 'backend'), false);
  checks.push('A new request after backend bytes change cannot validate old loaded Python code against the newly edited file');
  await writeFile(path.join(evidence, 'stale-loaded-backend-trace.json'), JSON.stringify(staleLoadedBackend, null, 2));
  await writeFile(backendFile, serverSource);

  await previewEval("window.loadShipment('?mismatch=1').then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  const mismatched = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
  assert.equal(mismatched.coverage, 'partial');
  assert.equal(mismatched.nodes.some(node => node.kind === 'database'), false);
  assert.equal(mismatched.nodes.some(node => node.kind === 'query'), false);
  assert.ok(mismatched.gaps.length > 0);
  await shell.waitForFunction(id => window.__shipmentPick?.id === id, mismatched.id);
  assert.equal(await shell.locator('#trace-graph .graph-node[data-node^="gap-"]').count(), 0);
  assert.equal(await shell.locator('#trace-graph .node-missing').count(), 0);
  const exportPath = path.join(evidence, 'partial-export.json');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await shell.evaluate(id => window.traceAtlas.exportTrace(id), mismatched.id);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.deepEqual(exported.graph.gaps, mismatched.gaps);
  assert.ok(exported.graph.nodes.some(node => node.kind === 'gap'));
  checks.push('A real HTTP response carrying a different request ID cannot be attached as backend/query/column evidence');
  checks.push('Partial UI omits repeated missing-link cards while native export retains the full raw evidence gaps');
  await writeFile(path.join(evidence, 'mismatched-request-trace.json'), JSON.stringify(mismatched, null, 2));

  await previewEval('window.loadShipment().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  await writeFile(sourceFile, client + '\n// Repository source changed after binding.\n');
  const staleFrontend = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
  assert.equal(staleFrontend.coverage, 'unavailable');
  assert.equal(staleFrontend.captured, false);
  assert.equal(staleFrontend.nodes.some(node => node.kind === 'database'), false);
  checks.push('Stale frontend bytes invalidate the recorded binding rather than borrowing a source or database match');
  await writeFile(path.join(evidence, 'stale-frontend-trace.json'), JSON.stringify(staleFrontend, null, 2));
  await writeFile(sourceFile, client);
  assert.deepEqual(errors, []);
  const report = { passed: true, checks, versions, fixture, evidence, rendererErrors: errors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, error: error.stack, stderr }, null, 2));
  console.error('Acceptance artifacts: ' + evidence);
  throw error;
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  if (backend.exitCode === null) {
    const closed = once(backend, 'exit');
    backend.kill();
    await Promise.race([closed, pause(5000)]);
  }
}
