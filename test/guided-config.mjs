// Offline acceptance of the generated Vite wrapper with an existing pre-plugin.
// Select installed React/Vite dependencies with ORIVO_FIXTURE_DEPS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const dependencyProject = process.env.ORIVO_FIXTURE_DEPS;
assert.ok(dependencyProject, 'Set ORIVO_FIXTURE_DEPS to a project with installed React, React DOM and Vite. No dependencies are downloaded.');
const dependencyRequire = createRequire(path.join(path.resolve(dependencyProject), 'package.json'));
const versions = Object.fromEntries(['react', 'react-dom', 'vite'].map(name => [name, dependencyRequire(`${name}/package.json`).version]));
const { createServer, build } = await import(pathToFileURL(dependencyRequire.resolve('vite')).href);
const { createGuidedSetup } = require('../adapters/tracing/guided.cjs');
const fixture = path.join(root, '.tmp', 'product-fixture', `guided-config-${Date.now()}`);
const frontend = path.join(fixture, 'frontend');
const evidence = path.join(fixture, 'acceptance');
await mkdir(path.join(frontend, 'src'), { recursive: true });
await mkdir(path.join(frontend, 'node_modules'));
await mkdir(evidence);
for (const name of ['react', 'react-dom', 'scheduler', 'vite']) {
  const manifest = dependencyRequire.resolve(`${name}/package.json`);
  await symlink(await realpath(path.dirname(manifest)), path.join(frontend, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
}
const manifest = JSON.stringify({ name: 'independent-guided-config-fixture', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite } }, null, 2) + '\n';
await writeFile(path.join(frontend, 'package.json'), manifest);
const prefix = "// Existing user pre-transform changes source bytes.\nglobalThis.__guidedExistingPlugin = 'retained';\n";
const config = `export default {
  define: {__GUIDED_EXISTING_SETTING__: JSON.stringify('existing-config-retained')},
  server: {headers: {'X-Guided-Existing-Config':'retained'}},
  plugins: [{
    name: 'existing-user-pre-transform',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0].endsWith('/src/Card.jsx')) return {code:${JSON.stringify(prefix)}+code,map:null};
    },
  }],
};
`;
await writeFile(path.join(frontend, 'vite.config.mjs'), config);
await writeFile(path.join(frontend, 'index.html'), '<!doctype html><html><head><title>Guided wrapper fixture</title></head><body><div id="root"></div><script type="module" src="/src/Card.jsx"></script></body></html>');
const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
function Card() { return <main><h1 id="guided-title">{__GUIDED_EXISTING_SETTING__}</h1></main>; }
createRoot(document.getElementById('root')).render(<Card />);
`;
await writeFile(path.join(frontend, 'src', 'Card.jsx'), source);
const sourceHash = createHash('sha256').update(source).digest('hex');
const transformedHash = createHash('sha256').update(prefix + source).digest('hex');
const guided = createGuidedSetup();
const checks = [];
let server;
try {
  const plan = await guided.preview(fixture, { frontend: 'frontend' });
  assert.equal(await readFile(path.join(frontend, 'vite.config.mjs'), 'utf8'), config);
  assert.equal(await readFile(path.join(frontend, 'package.json'), 'utf8'), manifest);
  await guided.apply(fixture, plan.id);
  const generatedConfig = path.join(fixture, '.studio-tracing', 'vite.config.mjs');
  server = await createServer({ root: frontend, configFile: generatedConfig, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const response = await fetch(`${url}/src/Card.jsx`), output = await response.text();
  await writeFile(path.join(evidence, 'served-module.js'), output);
  assert.equal(response.status, 200, output);
  assert.ok(output.includes('__studioFlow'), 'The applied generated wrapper must serve instrumented JSX.');
  assert.ok(output.includes(sourceHash), 'Bindings must retain the SHA-256 of original source bytes before the existing pre-plugin changes them.');
  assert.ok(!output.includes(transformedHash), 'The source hash must not refer to the user-plugin-transformed text.');
  checks.push('Generated wrapper instruments original JSX before an existing enforce:pre plugin, preserving source hashes');
  assert.equal(response.headers.get('X-Guided-Existing-Config'), 'retained');
  assert.ok(output.includes('__guidedExistingPlugin') && output.includes('retained'), 'The existing pre-plugin must still execute.');
  assert.equal(server.config.define.__GUIDED_EXISTING_SETTING__, JSON.stringify('existing-config-retained'), 'The original define setting must survive wrapper merging.');
  const pluginNames = server.config.plugins.map(plugin => plugin.name);
  assert.ok(pluginNames.indexOf('studio-development-tracing') < pluginNames.indexOf('existing-user-pre-transform'));
  assert.equal(await readFile(path.join(frontend, 'vite.config.mjs'), 'utf8'), config);
  checks.push('Original user plugin, define setting, HTTP headers and untouched configuration survive guided setup');
  await writeFile(path.join(evidence, 'served-module.js'), output);
  await server.close();
  server = null;
  const outDir = path.join(fixture, 'production-output');
  await build({ root: frontend, configFile: generatedConfig, build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  async function textFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? textFiles(path.join(directory, entry.name)) : /\.(?:js|html)$/.test(entry.name) ? readFile(path.join(directory, entry.name), 'utf8') : ''))).join('\n');
  }
  const production = await textFiles(outDir);
  for (const marker of ['__studioFlow', '__studioElementFlowV1', 'virtual:studio-tracing', 'x-studio-trace', 'Studio-Trace']) assert.ok(!production.includes(marker), `Production output excludes ${marker}`);
  assert.ok(production.includes('__guidedExistingPlugin'));
  assert.ok(production.includes('existing-config-retained'));
  checks.push('Production fixture build keeps the original user behavior and excludes development tracing');
  await guided.undo(fixture);
  assert.equal(await readFile(path.join(frontend, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(frontend, 'vite.config.mjs'), 'utf8'), config);
  checks.push('Undo restores the original package and leaves the real application configuration unchanged');
  const report = { passed: true, checks, versions, sourceHash, pluginNames, fixture, evidence, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, versions, error: error.stack }, null, 2));
  console.error('Generated config artifacts: ' + evidence);
  throw error;
} finally {
  if (server) await server.close();
}
