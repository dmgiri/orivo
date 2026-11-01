// Offline beta acceptance: a separate React/Vite application using the exported kit.
// ORIVO_FIXTURE_DEPS points to a project with installed React, React DOM and Vite.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, realpath, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const dependencyProject = process.env.ORIVO_FIXTURE_DEPS;
assert.ok(dependencyProject, 'Set ORIVO_FIXTURE_DEPS to a project with installed React, React DOM and Vite. No packages are downloaded.');
const dependencyRequire = createRequire(path.join(path.resolve(dependencyProject), 'package.json'));
const versions = Object.fromEntries(['react', 'react-dom', 'vite'].map(name => [name, dependencyRequire(`${name}/package.json`).version]));
const { createServer, build } = await import(pathToFileURL(dependencyRequire.resolve('vite')).href);
const fixture = path.join(root, '.tmp', 'product-fixture', `external-${Date.now()}`);
const evidence = path.join(fixture, 'acceptance');
await mkdir(path.join(fixture, 'node_modules', '@orivo'), { recursive: true });
await mkdir(path.join(fixture, 'src'));
await mkdir(evidence);
const fixtureRequire = createRequire(path.join(fixture, 'package.json'));
await cp(path.join(root, 'adapters', 'tracing'), path.join(fixture, 'node_modules', '@orivo', 'tracing'), { recursive: true, errorOnExist: true });
for (const name of ['react', 'react-dom', 'scheduler']) {
  const manifest = dependencyRequire.resolve(`${name}/package.json`);
  await symlink(await realpath(path.dirname(manifest)), path.join(fixture, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
}
await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'orivo-external-invoice-acceptance', private: true, type: 'module', engines: { node: '>=24.13' }, dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite, '@orivo/tracing': 'file:node_modules/@orivo/tracing' } }, null, 2));
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><title>External invoice fixture</title></head><body><div id="root"></div><script type="module" src="/src/Invoice.jsx"></script></body></html>');
const source = `import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
function Invoice() {
  const [invoice, setInvoice] = useState(null);
  useEffect(() => { fetch('/api/invoice').then(response => response.json()).then(body => setInvoice(body.invoice)); }, []);
  if (!invoice) return <p>Loading invoice</p>;
  return <main style={{fontFamily:'system-ui',padding:24}}><h1>External invoice</h1><p>Invoice total</p><span id="invoice-total">{invoice.total}</span></main>;
}
createRoot(document.getElementById('root')).render(<Invoice />);
`;
const sourceFile = path.join(fixture, 'src', 'Invoice.jsx');
await writeFile(sourceFile, source);
await writeFile(path.join(fixture, 'server.cjs'), `'use strict';
const http = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const {createTracing} = require('@orivo/tracing/node-http');
exports.start = async function start() {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE billing_entries(id INTEGER PRIMARY KEY, total REAL); INSERT INTO billing_entries VALUES (7, 246.5)');
  const tracing = createTracing({repositoryRoot:__dirname,development:true});
  const server = http.createServer(tracing.handler(function invoiceHandler(request, response) {
    if (request.url !== '/api/invoice') { response.writeHead(404); return response.end(); }
    const result = tracing.read(database, 'SELECT total FROM billing_entries WHERE id = ?', [7]);
    const invoice = {total:result.field(0, 'total', 'invoice.total')};
    response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    response.end(JSON.stringify({invoice}));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url:'http://127.0.0.1:'+server.address().port, close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close();}};
};
`);

const studioTracing = (await import(pathToFileURL(fixtureRequire.resolve('@orivo/tracing/vite')).href)).default;
let backend, vite, app;
const checks = [];
try {
  backend = await fixtureRequire('./server.cjs').start();
  const normal=await fetch(backend.url+'/api/invoice');assert.equal(normal.headers.get('Studio-Trace'),null);assert.deepEqual(await normal.json(),{invoice:{total:246.5}});
  vite = await createServer({ configFile: false, root: fixture, plugins: [studioTracing({ repositoryRoot: fixture, enabled: true })], server: { host: '127.0.0.1', port: 0, proxy: { '/api': backend.url }, watch: { ignored: ['**'] } }, logLevel: 'warn' });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const transformed = await (await fetch(`${url}/src/Invoice.jsx`)).text();
  assert.ok(transformed.includes('__studioFlow'), 'Vite serves the plugin-instrumented JSX, using the exported package.');
  checks.push('React JSX automatically instrumented by copied/exported @orivo/tracing Vite plugin');
  const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: 'external-' + Date.now(), ORIVO_START_MODE: 'welcome' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  const shell = await app.firstWindow();
  shell.setDefaultTimeout(25000);
  const errors = [];
  shell.on('pageerror', error => errors.push(error.message));
  await shell.waitForFunction(() => typeof window.traceAtlas?.getState === 'function');
  assert.equal((await shell.evaluate(() => window.traceAtlas.getState())).demo, false);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
  await shell.evaluate(url => window.traceAtlas.openApp(url), url);
  const previewId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))?.id, url);
  assert.ok(previewId);
  await app.evaluate(async ({ webContents }, id) => { await webContents.fromId(id).executeJavaScript(`new Promise((resolve,reject)=>{let attempts=0;const poll=()=>{if(document.querySelector('#invoice-total')?.textContent==='246.5')resolve();else if(++attempts>200)reject(Error('Invoice did not render'));else setTimeout(poll,40);};poll();})`); }, previewId);
  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await shell.locator('#inspect-button').click();
  await shell.locator('#inspect-button.inspecting').waitFor();
  await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    const point = await contents.executeJavaScript(`(()=>{const box=document.querySelector('#invoice-total').getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};})()`);
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }, previewId);
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  const graph = await shell.evaluate(() => window.traceAtlas.capture('#invoice-total'));
  assert.equal(graph.coverage, 'complete');
  assert.ok(graph.nodes.some(node => node.kind === 'database' && node.label === 'billing_entries.total'));
  assert.ok(graph.nodes.some(node => node.kind === 'source' && node.file === 'src/Invoice.jsx'));
  assert.ok(graph.nodes.some(node => node.kind === 'backend' && node.file === 'server.cjs'));
  assert.ok(graph.nodes.some(node => node.kind === 'query' && node.code.includes('SELECT total FROM billing_entries')));
  assert.equal(graph.nodes.find(node => node.kind === 'api').meta.responseField, 'invoice.total');
  checks.push('Genuine native picker -> React source -> proxied JSON field -> external Node handler -> executed SQLite -> billing_entries.total');
  await writeFile(path.join(evidence, 'complete-trace.json'), JSON.stringify(graph, null, 2));
  await shell.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const screenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * 1.5), height: Math.round(bounds.height * 1.5) } });
    const own = sources.find(source => source.id === window.getMediaSourceId());
    return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(evidence, 'external-complete.png'), Buffer.from(screenshot, 'base64'));
  const backendFile = path.join(fixture, 'server.cjs'), backendSource = await readFile(backendFile, 'utf8');
  await writeFile(backendFile, backendSource + '\n// Backend source changed after the request executed.\n');
  const staleBackend = await shell.evaluate(() => window.traceAtlas.capture('#invoice-total'));
  assert.equal(staleBackend.coverage, 'partial');
  assert.equal(staleBackend.captured, true);
  assert.equal(staleBackend.nodes.some(node => node.kind === 'database'), false);
  checks.push('Changed external backend source preserves frontend/request evidence but removes database-column claims');
  await writeFile(path.join(evidence, 'stale-backend-trace.json'), JSON.stringify(staleBackend, null, 2));
  await writeFile(backendFile, backendSource);
  await writeFile(sourceFile, source + '\n// Original source changed after indexing and capture.\n');
  const stale = await shell.evaluate(() => window.traceAtlas.capture('#invoice-total'));
  assert.equal(stale.coverage, 'unavailable');
  assert.equal(stale.captured, false);
  assert.equal(stale.nodes.some(node => node.kind === 'database'), false);
  assert.ok(stale.gaps.some(gap => /source differs|changed/i.test(gap)));
  checks.push('Changed original external source removes complete lineage and reports unavailable evidence');
  await writeFile(path.join(evidence, 'stale-trace.json'), JSON.stringify(stale, null, 2));
  await writeFile(sourceFile, source);
  const buildDir = path.join(fixture, 'production-output');
  await build({ configFile: false, root: fixture, plugins: [studioTracing({ repositoryRoot: fixture, enabled: true })], build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'warn' });
  async function outputText(directory) { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map(entry => entry.isDirectory() ? outputText(path.join(directory, entry.name)) : /\.(?:js|html)$/.test(entry.name) ? readFile(path.join(directory, entry.name), 'utf8') : ''))).join('\n'); }
  const output = await outputText(buildDir);
  for (const marker of ['__studioFlow', '__studioElementFlowV1', 'virtual:studio-tracing', 'x-studio-trace', 'Studio-Trace']) assert.ok(!output.includes(marker), `Production output excludes ${marker}`);
  checks.push('Production build excludes tracing runtime, binding helpers and trace headers even with plugin enabled');
  assert.deepEqual(errors, []);
  const report = { passed: true, checks, versions, fixture, evidence, rendererErrors: errors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, versions, error: error.stack }, null, 2));
  console.error('Acceptance artifacts: ' + evidence);
  throw error;
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  if (backend) await backend.close();
}
