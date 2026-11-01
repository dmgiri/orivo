// Actual Vite 5 fallback acceptance. Supply preinstalled isolated dependencies;
// this script never downloads packages or starts a desktop/browser window.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url), dependencyRoot = process.env.ORIVO_VITE5_DEPS;
assert.ok(dependencyRoot, 'Set ORIVO_VITE5_DEPS to an existing isolated project with Vite 5, @vitejs/plugin-react, React and React DOM.');
const packageRoots = Object.fromEntries(await Promise.all(['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'scheduler'].map(async name => [name, await realpath(path.join(path.resolve(dependencyRoot), 'node_modules', name))])));
const versions = Object.fromEntries(await Promise.all(['vite', '@vitejs/plugin-react', 'react', 'react-dom'].map(async name => [name, JSON.parse(await readFile(path.join(packageRoots[name], 'package.json'), 'utf8')).version])));
assert.match(versions.vite, /^5\.4\./, 'This acceptance specifically verifies the Vite 5.4 fallback');
const cjs = process.argv.includes('--cjs'), configName = cjs ? 'vite.config.cjs' : 'vite.config.ts', helperName = cjs ? 'aliases.cjs' : 'aliases.ts';
const marker = cjs ? 'vite5-cjs-package' : 'vite5-import-only-package';
const id = 'automatic-vite5-' + (cjs ? 'cjs-' : 'esm-') + Date.now();
const fixture = path.join(root, '.tmp/product-fixture', id), evidence = path.join(root, '.tmp/product-fixture', id + '-evidence');
const frontend = path.join(fixture, 'frontend');
await mkdir(path.join(frontend, 'config'), { recursive: true });
await mkdir(path.join(frontend, 'src'), { recursive: true });
await mkdir(path.join(frontend, 'node_modules/config-policy'), { recursive: true });
await mkdir(path.join(fixture, 'backend'), { recursive: true });
await mkdir(evidence, { recursive: true });
for (const name of ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'scheduler']) {
  await mkdir(path.dirname(path.join(frontend, 'node_modules', name)), { recursive: true });
  await symlink(packageRoots[name], path.join(frontend, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
}
await writeFile(path.join(frontend, 'node_modules/config-policy/package.json'), JSON.stringify({ name: 'config-policy', version: '0.0.0-test', type: 'module', exports: { import: './index.mjs', ...(cjs ? { require: './index.cjs' } : {}) } }));
await writeFile(path.join(frontend, 'node_modules/config-policy/index.mjs'), "export const endpoint='/__config-proof';export const marker='vite5-import-only-package';\n");
await writeFile(path.join(frontend, 'node_modules/config-policy/index.cjs'), "module.exports={endpoint:'/__config-proof',marker:'vite5-cjs-package'};\n");
await writeFile(path.join(frontend, 'package.json'), JSON.stringify({ name: 'normal-vite5-project', private: true, type: cjs ? 'commonjs' : 'module', scripts: { dev: 'vite' }, dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite, '@vitejs/plugin-react': versions['@vitejs/plugin-react'], 'config-policy': '0.0.0-test' } }, null, 2));
await writeFile(path.join(frontend, 'index.html'), '<!doctype html><html><head><title>Normal Vite 5 shipment project</title></head><body><div id="root"></div><script type="module" src="/src/Shipments.jsx"></script></body></html>');
await writeFile(path.join(frontend, 'src/caption.ts'), "export const caption:string='Shipment reference';\n");
const client = `import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {caption} from '@/caption';
function Shipments(){
 const [shipment,setShipment]=useState(null);
 useEffect(()=>{fetch('/service/shipments').then(response=>response.json()).then(body=>setShipment(body.items[0]));},[]);
 return <main><h1>{caption}</h1>{shipment&&<strong id="shipment-reference">{shipment.reference}</strong>}</main>;
}
createRoot(document.getElementById('root')).render(<Shipments/>);
`;
await writeFile(path.join(frontend, 'src/Shipments.jsx'), client);
await writeFile(path.join(frontend, 'config', helperName), cjs ? `const path=require('node:path');
module.exports={aliases:{'@':path.resolve(__dirname,'../src')},originalLocations:{directory:__dirname,filename:__filename,urlDirectory:__dirname}};
` : `import path from 'node:path';
import {fileURLToPath} from 'node:url';
const configDirectory:string=path.dirname(fileURLToPath(import.meta.url));
export const aliases={'@':path.resolve(__dirname,'../src')};
export const originalLocations={directory:__dirname,filename:__filename,urlDirectory:configDirectory};
`);
const esmImports = `import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {endpoint,marker} from 'config-policy';
import {aliases,originalLocations} from './config/aliases';
export default `;
const cjsImports = `const {defineConfig}=require('vite');
const plugin=require('@vitejs/plugin-react');const react=plugin.default||plugin;
const {endpoint,marker}=require('config-policy');
const {aliases,originalLocations}=require('./config/aliases.cjs');
module.exports=`;
await writeFile(path.join(frontend, configName), (cjs ? cjsImports : esmImports) + `defineConfig(async({command,mode})=>({
 root:__dirname,
 resolve:{alias:aliases},
 plugins:[react(),{name:'normal-config-observation',configureServer(server){server.middlewares.use((request,response,next)=>{if(request.url!==endpoint)return next();response.setHeader('Content-Type','application/json');response.end(JSON.stringify({command,mode,marker,cwd:process.cwd(),directory:__dirname,filename:__filename,urlFile:${cjs ? '__filename' : 'fileURLToPath(import.meta.url)'},aliases,originalLocations}));});}}],
 server:{host:'127.0.0.1',proxy:{'/service':{target:'http://localhost:18843',changeOrigin:false,rewrite:value=>value.replace(/^\\/service/,'/api')}}}
}));
`);
await writeFile(path.join(fixture, 'backend/package.json'), JSON.stringify({ name: 'ordinary-sqlite-api', private: true, scripts: { dev: 'node server.cjs' }, engines: { node: '>=24.13.0' } }));
const backend = `const http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const database=new DatabaseSync(':memory:');
database.exec("CREATE TABLE shipments(reference TEXT);INSERT INTO shipments VALUES('VITE5-2048')");
http.createServer(function shipmentRequest(request,response){
 if(request.url!=='/api/shipments'){response.statusCode=404;response.end('Unknown route');return;}
 const items=database.prepare('SELECT reference FROM shipments').all();
 response.setHeader('Content-Type','application/json');response.end(JSON.stringify({items}));
}).listen(18843,'127.0.0.1');
`;
await writeFile(path.join(fixture, 'backend/server.cjs'), backend);
assert.equal(/@orivo|studio_tracing|__studioFlow/.test(client + backend), false);
async function snapshot(directory = fixture, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    assert.equal(entry.isSymbolicLink(), false);
    const file = path.join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(file, name + '/'));
    else result[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
const before = await snapshot(), checks = [];
const { createAutoAttach } = require('../adapters/tracing/auto-attach.cjs');
const runtime = path.join(evidence, 'runtime'), manager = createAutoAttach({ runtimeDirectory: runtime });
try {
  const detected = await manager.detect(fixture);
  assert.equal(detected.frontends.length, 1);
  assert.equal(detected.frontends[0].viteVersion, versions.vite);
  assert.equal(detected.frontends[0].supported, true);
  assert.equal(detected.backends.length, 1);
  const started = await manager.start(fixture);
  assert.equal(started.status, 'running', started.notice + '\n' + started.output);
  const observed = await (await fetch(new URL('/__config-proof', started.url))).json();
  assert.deepEqual(observed, { command: 'serve', mode: 'development', marker, cwd: frontend, directory: frontend, filename: path.join(frontend, configName), urlFile: path.join(frontend, configName), aliases: { '@': path.join(frontend, 'src') }, originalLocations: { directory: path.join(frontend, 'config'), filename: path.join(frontend, 'config', helperName), urlDirectory: path.join(frontend, 'config') } });
  checks.push(cjs ? 'Actual Vite 5.4 loads legacy CommonJS config, React plugin, require/module.exports helpers and conditional require dependencies from the original project' : 'Actual Vite 5.4 loads async TypeScript config, React plugin, a relative TypeScript helper and an import-only ESM config dependency from the original project');
  checks.push('__dirname, __filename, import.meta.url, process.cwd and frontend module aliases retain their original application locations');
  const transformed = await (await fetch(new URL('/src/Shipments.jsx', started.url))).text();
  assert.ok(transformed.includes('__studioFlow'), 'Automatic JSX binding is present');
  assert.ok(transformed.includes('/src/caption.ts'), 'The application alias resolves to its original TypeScript source');
  assert.ok(transformed.includes('$RefreshReg$') || transformed.includes('RefreshRuntime'), 'The original React plugin remains active');
  checks.push('The original React plugin and module alias work together with automatic Orivo JSX instrumentation');
  const normal = await fetch(new URL('/service/shipments', started.url));
  assert.equal(normal.status, 200);
  assert.equal(normal.headers.get('Studio-Trace'), null);
  assert.deepEqual(await normal.json(), { items: [{ reference: 'VITE5-2048' }] });
  const requestId = randomUUID();
  const traced = await fetch(new URL('/service/shipments', started.url), { headers: { 'X-Studio-Trace': requestId } });
  assert.equal(traced.status, 200);
  const encoded = traced.headers.get('Studio-Trace');
  assert.ok(encoded);
  const execution = JSON.parse((encoded.startsWith('z1.') ? inflateSync(Buffer.from(encoded.slice(3), 'base64')) : Buffer.from(encoded, 'base64')).toString());
  assert.equal(execution.id, requestId);
  assert.equal(execution.fields['items.0.reference'].table, 'shipments');
  assert.equal(execution.fields['items.0.reference'].column, 'reference');
  assert.ok(execution.queries.some(query => query.sql.includes('SELECT reference FROM shipments')));
  checks.push('The original proxy rewrite reaches the owned Node backend and carries real SQLite query/column evidence while normal requests remain unchanged');
  await writeFile(path.join(evidence, 'execution.json'), JSON.stringify(execution, null, 2));
  const ports = [];
  for (const directory of await readdir(runtime)) for (const name of ['frontend.json', 'backend.json']) try { ports.push(JSON.parse(await readFile(path.join(runtime, directory, name), 'utf8')).port); } catch {}
  await manager.stop(fixture);
  for (const port of ports) await assert.rejects(fetch('http://127.0.0.1:' + port));
  const after = await snapshot();
  assert.deepEqual(after, before);
  await writeFile(path.join(evidence, 'source-integrity.json'), JSON.stringify({ unchanged: true, before, after }, null, 2));
  checks.push('Stop closes both owned ports; every application file name and source hash stays identical and all bundled config/cache output lives outside the project');
  const report = { passed: true, mode: cjs ? 'cjs' : 'esm-typescript', versions, checks, fixture, evidence, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, fixture, versions, error: error.stack }, null, 2));
  console.error('Vite 5 acceptance artifacts: ' + evidence);
  throw error;
} finally { await manager.close(); }
