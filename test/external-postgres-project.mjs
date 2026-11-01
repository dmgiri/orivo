// Separate-project acceptance: React/Vite + FastAPI + a disposable PostgreSQL cluster.
// --http-only exercises real correlated SQL without launching Electron.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const python = process.env.ORIVO_FIXTURE_PYTHON;
const computedMode = process.argv.includes('--computed');
const dtoMode = process.argv.includes('--dto') || computedMode;
assert.ok(python, 'Set ORIVO_FIXTURE_PYTHON to an existing Python environment with FastAPI, SQLAlchemy and Uvicorn. No packages are downloaded.');
const dependencyProject = process.env.ORIVO_FIXTURE_DEPS;
assert.ok(dependencyProject, 'Set ORIVO_FIXTURE_DEPS to an existing project with React, React DOM and Vite. No packages are downloaded.');
const dependencyRequire = createRequire(path.join(path.resolve(dependencyProject), 'package.json'));
const versions = Object.fromEntries(['react', 'react-dom', 'vite'].map(name => [name, dependencyRequire(`${name}/package.json`).version]));
const { createServer } = await import(pathToFileURL(dependencyRequire.resolve('vite')).href);
const fixture = path.join(root, '.tmp', 'product-fixture', `external-postgres-${Date.now()}`);
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
await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'orivo-independent-postgres-acceptance', private: true, type: 'module', dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite, '@orivo/tracing': 'file:node_modules/@orivo/tracing' } }, null, 2));
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Independent shipment application</title></head><body><div id="root"></div><script type="module" src="/src/Shipment.jsx"></script></body></html>');
const client = `import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
function ShipmentReference() {
  const [shipment, setShipment] = useState(null);
  useEffect(() => {
    window.loadShipment = async (mode = '', endpoint = '/api/shipments') => {
      const body = await fetch(endpoint + mode).then(response => response.json());
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
const projectionSource = `from pydantic import BaseModel, ConfigDict

class ShipmentDTO(BaseModel):
    label: str

class ShipmentDTOEnvelope(BaseModel):
    shipments: list[ShipmentDTO]

class ComputedShipmentDTO(BaseModel):
    model_config = ConfigDict(frozen=True)
    label: float

class ComputedShipmentEnvelope(BaseModel):
    shipments: list[ComputedShipmentDTO]

def project_shipment(record):
    return ShipmentDTO(label=record.reference)

def project_computed(record):
    return {'label':record.amount_cents / 100}

def project_computed_dto(record):
    return ComputedShipmentDTO(label=record.amount_cents / 100)
`;
const projectionFile = path.join(fixture, 'shipment_projection.py');
if (dtoMode) await writeFile(projectionFile, projectionSource);
const serverSource = `from __future__ import annotations
import base64
import json
import os
import socket
import zlib
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, Integer, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
import studio_tracing
import uvicorn

ROOT = Path(__file__).resolve().parent
${dtoMode ? "detach_projection = studio_tracing.instrument_project(ROOT, include=['.'])\nfrom shipment_projection import ShipmentDTOEnvelope, project_shipment, ComputedShipmentEnvelope, project_computed, project_computed_dto\n" : ''}
class Base(DeclarativeBase):
    pass
class ShipmentRecord(Base):
    __tablename__ = 'shipment_records'
    __table_args__ = {'schema':'public'}
    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(80))
    amount_cents: Mapped[int] = mapped_column(Integer)

class ShipmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    label: str = Field(validation_alias='reference')

class ShipmentsResponse(BaseModel):
    shipments: list[ShipmentResponse]

engine = create_engine(os.environ['ORIVO_FIXTURE_DATABASE_URL'])
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)
with Session.begin() as session:
    session.add_all([ShipmentRecord(id=8, reference='SH-2048', amount_cents=1250), ShipmentRecord(id=9, reference='SH-4096', amount_cents=2500)])
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

${dtoMode ? `@app.get('/api/dto-shipments', response_model=ShipmentDTOEnvelope)
def shipment_dto_list():
    with Session() as session:
        record = session.scalars(select(ShipmentRecord).where(ShipmentRecord.id == 8)).one()
        return {'shipments':[project_shipment(record)]}
${computedMode ? `
@app.get('/api/computed-shipments')
def shipment_computed_list():
    with Session() as session:
        record = session.scalars(select(ShipmentRecord).where(ShipmentRecord.id == 8)).one()
        return {'shipments':[project_computed(record)]}

@app.get('/api/computed-dto-shipments', response_model=ComputedShipmentEnvelope)
def shipment_computed_dto_list():
    with Session() as session:
        record = session.scalars(select(ShipmentRecord).where(ShipmentRecord.id == 8)).one()
        return {'shipments':[project_computed_dto(record)]}
` : ''}
` : ''}

@app.get('/api/fixture-database')
def database_probe():
    with engine.connect() as connection:
        row = connection.execute(text('SELECT current_database(), version(), inet_server_port()')).one()
        return {'database':row[0], 'version':row[1], 'port':row[2]}

if __name__ == '__main__':
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    print(json.dumps({'url':'http://127.0.0.1:' + str(sock.getsockname()[1])}), flush=True)
    try:
        uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False)).run(sockets=[sock])
    finally:
        detach()
${dtoMode ? '        detach_projection()\n' : ''}
        engine.dispose()
`;
const backendFile = path.join(fixture, 'shipment_api.py');
await writeFile(backendFile, serverSource);
const testEntry = path.join(fixture, '.electron-acceptance.cjs');
await writeFile(testEntry, `const {app,BrowserWindow}=require('electron');\nBrowserWindow.prototype.show=function(){};\nBrowserWindow.prototype.focus=function(){};\nBrowserWindow.prototype.moveTop=function(){};\napp.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));\nrequire(${JSON.stringify(path.join(root, 'main.cjs'))});\n`);
const postgresBin = process.env.ORIVO_POSTGRES_BIN || 'C:\\Program Files\\PostgreSQL\\17\\bin';
const postgresRoot = path.join(fixture, '.postgres'), postgresData = path.join(postgresRoot, 'data');
const passwordFile = path.join(postgresRoot, 'password.tmp');
const runFile = promisify(execFile);
async function pgCommand(program, args) {
  const executable = path.join(postgresBin, program + (process.platform === 'win32' ? '.exe' : ''));
  if (program !== 'pg_ctl' || args[0] !== 'start') return runFile(executable, args, { cwd: fixture, windowsHide: true, timeout: 45000, maxBuffer: 1048576 });
  // PostgreSQL inherits pipe handles on Windows; wait for pg_ctl itself and
  // leave the database process writing only to its dedicated fixture log.
  await new Promise((resolve, reject) => {
    const control = spawn(executable, args, { cwd: fixture, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { control.kill(); reject(Error('Temporary PostgreSQL startup timed out; inspect the fixture server.log.')); }, 45000);
    control.once('error', error => { clearTimeout(timeout); reject(error); });
    control.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(Error(`Temporary pg_ctl start exited ${code}; inspect the fixture server.log.`)); });
  });
}
let stdout = '', stderr = '', app, vite, backend, postgresStarted = false, database;
const checks = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message, timeout = 25000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const result = await check();
    if (result) return result;
    if (backend && backend.exitCode !== null) throw Error(`Python fixture exited (${backend.exitCode}): ${stderr}`);
    await pause(60);
  }
  throw Error(`${message}\n${stderr}`);
}
try {
  await mkdir(postgresRoot);
  const password = randomBytes(24).toString('hex');
  await writeFile(passwordFile, password + '\n');
  await pgCommand('initdb', ['-D', postgresData, '--username=orivo_fixture', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile=' + passwordFile]);
  await unlink(passwordFile);
  const reservation = createNetServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const postgresPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await pgCommand('pg_ctl', ['start', '-D', postgresData, '-l', path.join(postgresRoot, 'server.log'), '-w', '-o', `-h 127.0.0.1 -p ${postgresPort} -c fsync=off -c synchronous_commit=off -c max_connections=12`]);
  postgresStarted = true;
  const databaseUrl = `postgresql+psycopg://orivo_fixture:${password}@127.0.0.1:${postgresPort}/postgres`;
  backend = spawn(python, ['-u', backendFile], { cwd: fixture, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: kit, ORIVO_FIXTURE_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', chunk => { stdout += chunk; });
  backend.stderr.on('data', chunk => { stderr += chunk; });
  const backendUrl = await until(() => { try { return JSON.parse(stdout.split('\n')[0]).url; } catch { return false; } }, 'Python fixture did not report its ephemeral URL');
  await until(async () => { try { return (await fetch(`${backendUrl}/api/shipments`)).ok; } catch { return false; } }, 'Python fixture did not start HTTP');
  const normal = await fetch(`${backendUrl}/api/shipments`);
  assert.equal(normal.headers.get('Studio-Trace'), null);
  assert.deepEqual(await normal.json(), { shipments: [{ label: 'SH-2048' }] });
  database = await (await fetch(`${backendUrl}/api/fixture-database`)).json();
  assert.match(database.version, /^PostgreSQL 17\./);
  assert.equal(database.port, postgresPort);
  checks.push('A dedicated PostgreSQL 17 cluster runs on its own loopback port with a fixture-only database/schema; normal API responses contain no tracing');
  const requestId = randomUUID();
  const observed = await fetch(`${backendUrl}/api/shipments`, { headers: { 'X-Studio-Trace': requestId } });
  const encoded = observed.headers.get('Studio-Trace');
  assert.ok(encoded, 'The actual PostgreSQL-backed HTTP response carries execution evidence.');
  const headerBytes = { orm: Buffer.byteLength(encoded, 'ascii') };
  assert.ok(headerBytes.orm <= 6144, 'Observed backend evidence must fit the proxy-safe trace header bound.');
  const packed = encoded.startsWith('z1.'), bytes = Buffer.from(packed ? encoded.slice(3) : encoded, 'base64');
  const execution = JSON.parse((packed ? inflateSync(bytes) : bytes).toString());
  assert.equal(execution.id, requestId);
  assert.equal(execution.route.path, 'shipment_api.py');
  assert.equal(execution.route.hash, createHash('sha256').update(serverSource).digest('hex'));
  assert.equal(execution.fields['shipments.0.label'].table, 'public.shipment_records');
  assert.equal(execution.fields['shipments.0.label'].column, 'reference');
  assert.ok(execution.queries.some(query => query.sql.includes('public.shipment_records') && query.columns.includes('public.shipment_records.reference')));
  assert.deepEqual(await observed.json(), { shipments: [{ label: 'SH-2048' }] });
  checks.push('Real PostgreSQL SELECT -> SQLAlchemy loaded ORM attribute -> aliased FastAPI response field is correlated to the HTTP request and hash-verified backend source');
  await writeFile(path.join(evidence, 'http-execution.json'), JSON.stringify(execution, null, 2));
  if (dtoMode) {
    const dtoId = randomUUID();
    const dtoResponse = await fetch(`${backendUrl}/api/dto-shipments`, { headers: { 'X-Studio-Trace': dtoId } });
    const dtoEncoded = dtoResponse.headers.get('Studio-Trace');
    assert.ok(dtoEncoded, 'The prebuilt DTO response carries execution evidence.');
    headerBytes.dto = Buffer.byteLength(dtoEncoded, 'ascii');
    assert.ok(headerBytes.dto <= 6144, 'DTO evidence must fit the proxy-safe trace header bound.');
    const dtoPacked = dtoEncoded.startsWith('z1.'), dtoBytes = Buffer.from(dtoPacked ? dtoEncoded.slice(3) : dtoEncoded, 'base64');
    const dtoExecution = JSON.parse((dtoPacked ? inflateSync(dtoBytes) : dtoBytes).toString());
    assert.equal(dtoExecution.id, dtoId);
    assert.equal(dtoExecution.fields['shipments.0.label'].table, 'public.shipment_records');
    assert.equal(dtoExecution.fields['shipments.0.label'].column, 'reference');
    assert.equal(dtoExecution.fields['shipments.0.label'].projection.path, 'shipment_projection.py');
    assert.equal(dtoExecution.fields['shipments.0.label'].projection.hash, createHash('sha256').update(projectionSource).digest('hex'));
    assert.ok(dtoExecution.queries.some(query => query.sql.includes('public.shipment_records') && query.columns.includes('public.shipment_records.reference')));
    assert.deepEqual(await dtoResponse.json(), { shipments: [{ label: 'SH-2048' }] });
    await writeFile(path.join(evidence, 'dto-http-execution.json'), JSON.stringify(dtoExecution, null, 2));
    checks.push('A separately imported project module builds a normal Pydantic DTO from the loaded PostgreSQL ORM field without manual tracing calls');
  }
  if(computedMode)for(const endpoint of ['/api/computed-shipments','/api/computed-dto-shipments']){
    const id=randomUUID(),response=await fetch(backendUrl+endpoint,{headers:{'X-Studio-Trace':id}}),encoded=response.headers.get('Studio-Trace');
    assert.ok(encoded&&Buffer.byteLength(encoded)<=6144);
    const execution=JSON.parse((encoded.startsWith('z1.')?inflateSync(Buffer.from(encoded.slice(3),'base64')):Buffer.from(encoded,'base64')).toString());
    assert.deepEqual(await response.json(),{shipments:[{label:12.5}]});
    const origin=execution.fields['shipments.0.label'];
    if(endpoint.includes('-dto-')){
      assert.equal(origin.kind,'computed');assert.equal(origin.immutable,true);
      assert.equal(origin.operation.op,'divide');assert.equal(origin.operation.left.column,'amount_cents');
      assert.deepEqual(origin.operation.right,{kind:'constant'});assert.equal(origin.inputs[0].table,'public.shipment_records');
      assert.equal(origin.projection.hash,createHash('sha256').update(projectionSource).digest('hex'));
    }else assert.equal(origin,undefined,'Mutable dictionary computations must remain unsupported');
    assert.ok(execution.durationMs>=0);assert.ok(execution.queries.every(query=>query.durationMs>=0&&query.startOffsetMs>=0));
    assert.ok(execution.queries.every(query=>query.startOffsetMs+query.durationMs<=execution.durationMs));
    await writeFile(path.join(evidence,endpoint.includes('-dto-')?'computed-dto-http-execution.json':'computed-dict-http-execution.json'),JSON.stringify(execution,null,2));
  }
  if(computedMode)checks.push('Actual PostgreSQL numeric column -> instrumented Python division -> frozen Pydantic DTO JSON field preserves values, source hashes, column inputs and monotonic timing; mutable dict calculation remains an explicit boundary');
  if (process.argv.includes('--http-only')) {
    const report = { passed: true, mode: 'http-only', dtoMode, computedMode, checks, versions, database, headerBytes, fixture, evidence, runAt: new Date().toISOString() };
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else {
  const studioTracing = (await import(pathToFileURL(path.join(kit, 'vite.mjs')).href)).default;
  vite = await createServer({ configFile: false, root: fixture, plugins: [studioTracing({ repositoryRoot: fixture, enabled: true })], server: { host: '127.0.0.1', port: 0, proxy: { '/api': backendUrl }, watch: { ignored: ['**'] } }, logLevel: 'warn' });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const transformed = await (await fetch(`${url}/src/Shipment.jsx`)).text();
  assert.ok(transformed.includes('__studioFlow'), 'The copied Vite plugin instruments original React JSX.');
  const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `external-postgres-${Date.now()}`, ORIVO_START_MODE: 'welcome' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [testEntry], env, timeout: 30000 });
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
  async function writeScreenshot(name) {
    await shell.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    const screenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds();
      try {
        window.setFocusable(false);
        window.showInactive();
        await new Promise(resolve => setTimeout(resolve, 150));
        if (window.isFocused()) throw Error('Acceptance window must not take focus from the normal application.');
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * 1.5), height: Math.round(bounds.height * 1.5) } });
        const own = sources.find(source => source.id === window.getMediaSourceId());
        return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
      } finally { window.hide(); }
    });
    await writeFile(path.join(evidence, name), Buffer.from(screenshot, 'base64'));
  }
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
  assert.ok(graph.nodes.some(node => node.kind === 'database' && node.label === 'public.shipment_records.reference'));
  assert.equal(graph.nodes.find(node => node.kind === 'api').meta.responseField, 'shipments.0.label');
  assert.ok(graph.nodes.find(node=>node.kind==='api').meta.durationMs>=0);
  assert.ok(graph.nodes.find(node=>node.kind==='backend').meta.durationMs>=0);
  assert.ok(graph.nodes.find(node=>node.kind==='query').meta.executions.every(execution=>execution.durationMs>=0&&execution.startOffsetMs>=0));
  assert.deepEqual(graph.gaps, []);
  assert.equal(await shell.locator('#trace-graph .node-missing').count(), 0);
  checks.push('Genuine native pick -> automatically instrumented React JSX -> same-origin JSON field -> FastAPI response_model alias -> actual SQLAlchemy PostgreSQL query -> public.shipment_records.reference');
  await writeFile(path.join(evidence, 'complete-trace.json'), JSON.stringify(graph, null, 2));
  await writeScreenshot('postgres-complete.png');

  if (dtoMode) {
    await previewEval("window.loadShipment('', '/api/dto-shipments').then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    await shell.evaluate(() => { window.__shipmentPick = null; });
    await shell.locator('#inspect-button').click();
    await shell.locator('#inspect-button.inspecting').waitFor();
    await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      const point = await contents.executeJavaScript("(()=>{const r=document.querySelector('#shipment-reference').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
      contents.sendInputEvent({ type: 'mouseMove', ...point });
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    }, previewId);
    await shell.waitForFunction(() => window.__shipmentPick?.coverage === 'complete' && window.__shipmentPick.nodes.some(node => node.kind === 'api' && node.label.includes('/api/dto-shipments')));
    const dtoGraph = await shell.evaluate(() => window.__shipmentPick);
    assert.ok(dtoGraph.nodes.some(node => node.kind === 'database' && node.label === 'public.shipment_records.reference'));
    assert.deepEqual(dtoGraph.gaps, []);
    await writeFile(path.join(evidence, 'dto-complete-trace.json'), JSON.stringify(dtoGraph, null, 2));
    await writeScreenshot('postgres-dto-complete.png');
    checks.push('Genuine native pick traces an ordinary prebuilt DTO through React, actual HTTP/SQL and the PostgreSQL result column');
    await writeFile(projectionFile, projectionSource + '\n# Source changed while the old projection bytecode remains loaded.\n');
    const changedProjection = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
    assert.equal(changedProjection.coverage, 'partial');
    assert.equal(changedProjection.nodes.some(node => node.kind === 'database'), false);
    await writeFile(path.join(evidence, 'changed-projection-trace.json'), JSON.stringify(changedProjection, null, 2));
    checks.push('Changing projection bytes after the HTTP response invalidates the old column claim when the existing DOM is picked again');
    await previewEval("window.loadShipment('', '/api/dto-shipments').then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    const staleProjection = await shell.evaluate(() => window.traceAtlas.capture('#shipment-reference'));
    assert.equal(staleProjection.coverage, 'partial');
    assert.equal(staleProjection.nodes.some(node => node.kind === 'database'), false);
    await writeFile(path.join(evidence, 'stale-projection-trace.json'), JSON.stringify(staleProjection, null, 2));
    checks.push('Changing the DTO projection source invalidates its database origin on a new actual HTTP request');
    await writeFile(projectionFile, projectionSource);
    await previewEval('window.loadShipment().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  }

  if(computedMode)for(const endpoint of ['/api/computed-shipments','/api/computed-dto-shipments']){
    await previewEval(`window.loadShipment('', ${JSON.stringify(endpoint)}).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    await shell.evaluate(()=>{window.__shipmentPick=null;});
    await shell.locator('#inspect-button').click();await shell.locator('#inspect-button.inspecting').waitFor();
    await app.evaluate(async({webContents},id)=>{
      const contents=webContents.fromId(id),point=await contents.executeJavaScript("(()=>{const r=document.querySelector('#shipment-reference').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
      contents.sendInputEvent({type:'mouseMove',...point});contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    },previewId);
    await shell.waitForFunction(endpoint=>window.__shipmentPick&&window.__shipmentPick.nodes.some(node=>node.kind==='api'&&node.label.includes(endpoint)),endpoint);
    const computedGraph=await shell.evaluate(()=>window.__shipmentPick),mapping=computedGraph.nodes.find(node=>node.meta?.computed);
    if(endpoint.includes('-dto-')){
      assert.equal(computedGraph.coverage,'complete');assert.ok(mapping);assert.deepEqual(mapping.meta.inputColumns,['public.shipment_records.amount_cents']);
      assert.equal(mapping.meta.expression,'(public.shipment_records.amount_cents / constant)');
      assert.ok(computedGraph.nodes.some(node=>node.kind==='database'&&node.label==='public.shipment_records.amount_cents'));
      assert.deepEqual(computedGraph.gaps,[]);
    }else {
      assert.equal(computedGraph.coverage,'partial');assert.equal(mapping,undefined);
      assert.equal(computedGraph.nodes.some(node=>node.kind==='database'),false);
    }
    assert.ok(computedGraph.nodes.find(node=>node.kind==='api').meta.durationMs>=0);
    assert.ok(computedGraph.summary.timing.queryMeasuredCount>=1);
    await writeFile(path.join(evidence,endpoint.includes('-dto-')?'computed-dto-complete-trace.json':'computed-dict-complete-trace.json'),JSON.stringify(computedGraph,null,2));
    await writeScreenshot(endpoint.includes('-dto-')?'postgres-computed-dto.png':'postgres-computed-dict.png');
  }
  if(computedMode){checks.push('Genuine native picks trace React numeric fields through actual HTTP, frozen Python DTO arithmetic, PostgreSQL execution and the original numeric column, with measured timings; mutable dict arithmetic shows no inferred column');await previewEval('window.loadShipment().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');}

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
  const report = { passed: true, mode: 'native', dtoMode, computedMode, checks, versions, database, headerBytes, fixture, evidence, rendererErrors: errors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, error: error.stack, stderr }, null, 2));
  console.error('Acceptance artifacts: ' + evidence);
  throw error;
} finally {
  try {
    if (app) await app.close();
    if (vite) await vite.close();
  } finally {
    try {
      if (backend && backend.exitCode === null) {
        const closed = once(backend, 'exit');
        backend.kill();
        await Promise.race([closed, pause(5000)]);
      }
    } finally {
      const ownsServer = postgresStarted || await stat(path.join(postgresData, 'postmaster.pid')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      try {
        if (ownsServer) await pgCommand('pg_ctl', ['stop', '-D', postgresData, '-m', 'fast', '-w']);
      } finally {
        await unlink(passwordFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
}
