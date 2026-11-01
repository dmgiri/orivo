// GUI acceptance for reviewed development setup; generated fixtures only.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const run = path.join(root, '.tmp', 'product-fixture', `guided-setup-${Date.now()}`);
const evidence = path.join(run, 'acceptance');
await mkdir(evidence, { recursive: true });
const checks = [], rendererErrors = [];
const manifest = JSON.stringify({ name: 'independent-guided-fixture', private: true, type: 'module', scripts: { dev: 'vite --host 127.0.0.1 --port 5173', build: 'vite build', check: 'node --check src/keep.mjs' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^8.0.0' } }, null, 2) + '\n';
const originalConfig = "export default {server:{port:5173},define:{ORIGINAL_SETTING:'true'}};\n";
async function fixture(name, configured = false) {
  const directory = path.join(run, name);
  await mkdir(path.join(directory, 'frontend', 'src'), { recursive: true });
  await mkdir(path.join(directory, 'backend', 'app'), { recursive: true });
  await writeFile(path.join(directory, 'frontend', 'package.json'), manifest);
  await writeFile(path.join(directory, 'frontend', 'vite.config.mjs'), configured ? "import studioTracing from '@orivo/tracing/vite';\nexport default {plugins:process.env.STUDIO_TRACE === '1' ? [studioTracing({})] : []};\n" : originalConfig);
  await writeFile(path.join(directory, 'frontend', 'src', 'keep.mjs'), 'export const unchanged = true;\n');
  await writeFile(path.join(directory, 'backend', 'requirements.txt'), 'fastapi==0.141.1\nsqlalchemy==2.0.52\nuvicorn==0.52.4\n');
  await writeFile(path.join(directory, 'backend', 'app', '__init__.py'), '');
  await writeFile(path.join(directory, 'backend', 'app', 'main.py'), '# Inspected, never imported by this acceptance test.\napp = object()\n');
  await writeFile(path.join(directory, 'backend', 'app', 'database.py'), 'engine = object()\nSessionLocal = object()\n');
  return directory;
}
const first = await fixture('freight-app'), second = await fixture('another-app'), existing = await fixture('already-instrumented', true);
async function snapshot(directory) {
  const result = {};
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), name + '/');
      else result[name] = await readFile(path.join(current, entry.name), 'utf8');
    }
  }
  await visit(directory);
  return result;
}
const originalFirst = await snapshot(first), originalSecond = await snapshot(second), originalExisting = await snapshot(existing);
const options = { frontend: 'frontend', backend: { directory: 'backend', app: 'app.main:app', engine: 'app.database:engine', sessions: 'app.database:SessionLocal' } };
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `guided-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
let app, shell;
async function connect(directory) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, directory);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
}
async function nativeVisible() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible());
}
async function waitNativeVisible(expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await nativeVisible() === expected) return;
    await shell.waitForTimeout(25);
  }
  assert.equal(await nativeVisible(), expected, 'Native visibility must follow the current dialog state');
}
async function setupFromConnections() {
  await shell.locator('#nav-connections').click();
  await shell.locator('#connections-dialog[open]').waitFor();
  await shell.locator('#project-tracing-setup').click();
  await shell.locator('#tracing-setup-dialog[open]').waitFor();
}
async function screenshot(name) {
  await shell.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await shell.screenshot({ path: path.join(evidence, name) });
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  shell = await app.firstWindow();
  shell.setDefaultTimeout(20000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  const demoUrl = (await shell.evaluate(() => window.traceAtlas.getState())).url;
  await connect(first);
  await shell.evaluate(url => window.traceAtlas.openApp(url), demoUrl);
  await shell.waitForFunction(() => window.traceAtlas.getState().then(state => !state.loading && !state.demo));
  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await shell.waitForTimeout(100);
  assert.equal(await nativeVisible(), true);
  const setup = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.equal(setup.canConfigure, true);
  assert.equal(setup.guided.installed, false);
  assert.ok(setup.frontends.some(row => row.framework === 'React' && row.guided && row.directory === 'frontend'));
  assert.ok(setup.backends.some(row => row.framework === 'FastAPI' && row.directory === 'backend'));
  assert.deepEqual(await snapshot(first), originalFirst);
  checks.push('Generic React/Vite and FastAPI manifests are detected through the desktop API without project edits or server execution');

  await setupFromConnections();
  await shell.locator('#guided-frontend').waitFor();
  await waitNativeVisible(false);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(...window.getMinimumSize()); });
  await shell.waitForFunction(() => innerWidth <= 1100);
  const geometry = await shell.locator('#tracing-setup-dialog').evaluate(dialog => ({ overflow: dialog.scrollWidth > dialog.clientWidth + 1, scrollable: dialog.scrollHeight > dialog.clientHeight, width: dialog.getBoundingClientRect().width, viewport: innerWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(geometry.overflow, false, JSON.stringify(geometry));
  assert.equal(geometry.documentOverflow, false);
  assert.ok(geometry.width < geometry.viewport);
  assert.equal(geometry.scrollable, true);
  await shell.locator('#guided-frontend').selectOption('frontend');
  await shell.locator('#guided-backend').selectOption('backend');
  await shell.locator('#guided-python-app').fill(options.backend.app);
  await shell.locator('#guided-python-engine').fill(options.backend.engine);
  await shell.locator('#guided-python-sessions').fill(options.backend.sessions);
  await shell.locator('#guided-setup-preview').click();
  await shell.locator('#guided-setup-apply').waitFor();
  assert.deepEqual(await snapshot(first), originalFirst, 'Preview leaves every original file and script byte-identical');
  const diffs = shell.locator('.guided-setup-output details');
  assert.ok(await diffs.count() >= 3);
  await diffs.filter({ hasText: 'studio_app.py' }).locator('summary').click();
  assert.match(await diffs.filter({ hasText: 'studio_app.py' }).textContent(), /response_models=True/);
  assert.match(await shell.locator('.guided-setup-output').textContent(), /npm run dev:studio/);
  assert.match(await shell.locator('.guided-setup-output').textContent(), /python -m uvicorn/);
  await screenshot('guided-preview-minimum.png');
  checks.push('Minimum desktop dialog scrolls without horizontal overflow; users can review exact frontend/backend diffs before any files change');

  await shell.locator('#guided-setup-apply').click();
  await shell.locator('#guided-setup-undo').waitFor();
  const applied = JSON.parse(await readFile(path.join(first, 'frontend', 'package.json'), 'utf8'));
  const previous = JSON.parse(manifest);
  for (const [name, command] of Object.entries(previous.scripts)) assert.equal(applied.scripts[name], command);
  assert.match(applied.scripts['dev:studio'], /vite.*--config.*\.studio-tracing/);
  assert.match(await readFile(path.join(first, '.studio-tracing', 'studio_app.py'), 'utf8'), /response_models=True/);
  assert.equal(await readFile(path.join(first, 'frontend', 'vite.config.mjs'), 'utf8'), originalConfig);
  const installed = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.equal(installed.guided.installed, true);
  assert.equal(await shell.locator('#guided-frontend').count(), 0);
  assert.match(await shell.locator('#tracing-setup-content').textContent(), /npm run dev:studio/);
  assert.match(await shell.locator('#tracing-setup-content').textContent(), /python -m uvicorn/);
  await writeFile(path.join(first, 'user-note.txt'), 'An unrelated user edit survives undo.\n');
  await shell.locator('#guided-setup-undo').click();
  await shell.locator('#guided-setup-preview').waitFor();
  const undone = await snapshot(first);
  assert.equal(undone['user-note.txt'], 'An unrelated user edit survives undo.\n');
  delete undone['user-note.txt'];
  assert.deepEqual(undone, originalFirst);
  assert.equal((await shell.evaluate(() => window.traceAtlas.getTracingSetup())).guided.installed, false);
  checks.push('Apply adds a separate development command and automatic ORM response-model capture; undo restores exact originals and preserves unrelated edits');

  const pending = await shell.evaluate(value => window.traceAtlas.previewTracingSetup(value), options);
  await connect(second);
  await assert.rejects(shell.evaluate(id => window.traceAtlas.applyTracingSetup(id), pending.id), /project changed|preview.*again/i);
  assert.deepEqual(await snapshot(second), originalSecond);
  assert.equal(await readFile(path.join(first, 'frontend', 'package.json'), 'utf8'), manifest);
  checks.push('Switching the connected project invalidates a pending apply plan without writing either project');

  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await connect(existing);
  await setupFromConnections();
  await shell.waitForFunction(() => document.querySelector('#tracing-setup-content').textContent.includes('Activate the existing tracing configuration'));
  const existingSetup = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.equal(existingSetup.existingTracing.length, 1);
  assert.equal(await shell.locator('#guided-frontend').count(), 0);
  assert.equal(await shell.locator('#guided-setup-preview').count(), 0);
  assert.equal(await shell.locator('#guided-setup-apply').count(), 0);
  await assert.rejects(shell.evaluate(value => window.traceAtlas.previewTracingSetup(value), { frontend: 'frontend' }), /already has tracing|existing configuration/i);
  assert.deepEqual(await snapshot(existing), originalExisting);
  await waitNativeVisible(false);
  await screenshot('guided-existing-configuration.png');
  await shell.keyboard.press('Escape');
  await waitNativeVisible(true);
  checks.push('An existing tracing plugin displays activation guidance and prevents duplicate setup; modal close restores the native preview');
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, checks, rendererErrors, run, evidence, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, rendererErrors, error: error.stack }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'guided-failure.png') }).catch(() => {});
  console.error('Guided setup artifacts: ' + evidence);
  throw error;
} finally {
  if (app) await app.close();
}
