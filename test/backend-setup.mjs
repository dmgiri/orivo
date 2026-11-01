// Desktop acceptance for independent backend setup on an already traced frontend.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const run = path.join(root, '.tmp', 'product-fixture', `backend-setup-${Date.now()}`);
const evidence = path.join(run, 'acceptance');
await mkdir(evidence, { recursive: true });
const checks = [], rendererErrors = [];
const manifest = JSON.stringify({ name: 'already-traced-frontend', private: true, type: 'module', scripts: { dev: 'vite --host 127.0.0.1 --port 5173', build: 'vite build' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^8.0.0' } }, null, 2) + '\n';
const config = "import studioTracing from '@orivo/tracing/vite';\nexport default {plugins:process.env.STUDIO_TRACE === '1' ? [studioTracing({})] : []};\n";
async function fixture(name) {
  const folder = path.join(run, name);
  await mkdir(path.join(folder, 'frontend', 'src'), { recursive: true });
  await mkdir(path.join(folder, 'backend', 'src', 'service'), { recursive: true });
  await mkdir(path.join(folder, '.studio-tracing'), { recursive: true });
  await writeFile(path.join(folder, 'frontend', 'package.json'), manifest);
  await writeFile(path.join(folder, 'frontend', 'vite.config.mjs'), config);
  await writeFile(path.join(folder, 'frontend', 'src', 'keep.mjs'), 'export const keep = true;\n');
  await writeFile(path.join(folder, '.studio-tracing', 'keep.txt'), 'Existing frontend integration stays untouched.\n');
  await writeFile(path.join(folder, 'backend', 'requirements.txt'), 'fastapi\nsqlalchemy\nuvicorn\n');
  await writeFile(path.join(folder, 'backend', 'src', 'service', '__init__.py'), '');
  await writeFile(path.join(folder, 'backend', 'src', 'service', 'main.py'), '# Inspected only. This fixture application is never executed.\ndef create_app():\n    raise RuntimeError("Do not launch fixture server")\n');
  return folder;
}
async function snapshot(folder) {
  const result = {};
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), name + '/');
      else result[name] = await readFile(path.join(current, entry.name), 'utf8');
    }
  }
  await visit(folder); return result;
}
const first = await fixture('factory-app'), second = await fixture('another-factory-app');
const originalFirst = await snapshot(first), originalSecond = await snapshot(second);
const options = { backendOnly: true, backend: { directory: 'backend', app: 'service.main:create_app', factory: true, engine: '@app.state.database.engine', sessions: '@app.state.database.session_factory', instrument: true } };
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `backend-setup-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
let app, shell;
async function connect(folder) {
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, folder);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
}
async function nativeVisible() { return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()); }
async function waitNativeVisible(expected) {
  for (let attempt = 0; attempt < 50; attempt++) { if (await nativeVisible() === expected) return; await shell.waitForTimeout(25); }
  assert.equal(await nativeVisible(), expected);
}
async function openSetup() {
  await shell.locator('#nav-connections').click(); await shell.locator('#connections-dialog[open]').waitFor();
  await shell.locator('#project-tracing-setup').click(); await shell.locator('#tracing-setup-dialog[open]').waitFor();
  await shell.locator('#backend-setup-preview').waitFor();
}
async function screenshot(name) {
  await shell.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await shell.screenshot({ path: path.join(evidence, name) });
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], env, timeout: 30000 });
  shell = await app.firstWindow(); shell.setDefaultTimeout(20000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.contentView.children[0].webContents.setBackgroundThrottling(false); window.hide(); });
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  const demoUrl = (await shell.evaluate(() => window.traceAtlas.getState())).url;
  await connect(first); await shell.evaluate(url => window.traceAtlas.openApp(url), demoUrl);
  await shell.waitForFunction(() => window.traceAtlas.getState().then(state => !state.loading && !state.demo));
  await shell.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await waitNativeVisible(true);
  const setup = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.equal(setup.existingTracing.length, 1); assert.equal(setup.guided.backendInstalled, false);
  assert.ok(setup.backends.some(row => row.directory === 'backend' && row.framework === 'FastAPI'));
  await openSetup(); await waitNativeVisible(false);
  assert.equal(await shell.locator('#guided-setup-preview').count(), 0);
  assert.equal(await shell.locator('#backend-setup-preview').count(), 1);
  await assert.rejects(shell.evaluate(value => window.traceAtlas.previewTracingSetup(value), { frontend: 'frontend' }), /already has tracing|existing configuration/i);
  assert.deepEqual(await snapshot(first), originalFirst);
  checks.push('Existing frontend tracing keeps its activation guidance while the independent Python backend form remains available; duplicate frontend setup stays blocked');

  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(...window.getMinimumSize()); });
  await shell.waitForFunction(() => innerWidth <= 1100);
  const geometry = await shell.locator('#tracing-setup-dialog').evaluate(dialog => ({ overflow: dialog.scrollWidth > dialog.clientWidth + 1, scrollable: dialog.scrollHeight > dialog.clientHeight, width: dialog.getBoundingClientRect().width, viewport: innerWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(geometry.overflow, false, JSON.stringify(geometry)); assert.equal(geometry.documentOverflow, false); assert.equal(geometry.scrollable, true);
  await shell.locator('#backend-setup-directory').selectOption('backend');
  await shell.locator('#backend-setup-app').fill(options.backend.app);
  assert.equal(await shell.locator('#backend-setup-factory').isChecked(), true);
  await shell.locator('#backend-setup-engine').fill(options.backend.engine);
  await shell.locator('#backend-setup-sessions').fill(options.backend.sessions);
  assert.equal(await shell.locator('#backend-setup-instrument').isChecked(), true);
  await shell.locator('#backend-setup-preview').click(); await shell.locator('#backend-setup-apply').waitFor();
  assert.deepEqual(await snapshot(first), originalFirst, 'Preview must not write files or execute project code');
  const details = shell.locator('.guided-setup-output details').filter({ hasText: 'orivo_backend.py' });
  await details.locator('summary').click();
  const diff = await details.textContent();
  assert.match(diff, /instrument_project/); assert.match(diff, /@app\.state\.database\.engine/); assert.match(diff, /app = app\(\)/); assert.match(diff, /response_models=True/);
  assert.ok(diff.indexOf('instrument_project') < diff.indexOf('app = resolve'));
  assert.match(await shell.locator('#tracing-setup-content').textContent(), /python -B -m uvicorn orivo_backend:app/);
  await screenshot('backend-preview-minimum.png');
  checks.push('Factory/app-state references and direct DTO instrumentation are reviewable before writing; the minimum desktop dialog scrolls without horizontal overflow and hides the native preview');

  await shell.locator('#backend-setup-apply').click(); await shell.locator('#backend-setup-undo').waitFor();
  const installed = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.equal(installed.guided.installed, false); assert.equal(installed.guided.backendInstalled, true);
  assert.equal(installed.guided.backend.configuration.factory, true); assert.equal(installed.guided.backend.configuration.instrument, true);
  assert.equal(await readFile(path.join(first, 'frontend', 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(first, 'frontend', 'vite.config.mjs'), 'utf8'), config);
  assert.equal(await readFile(path.join(first, '.studio-tracing', 'keep.txt'), 'utf8'), originalFirst['.studio-tracing/keep.txt']);
  const applied = await snapshot(first);
  assert.ok(Object.keys(applied).filter(name => !(name in originalFirst)).every(name => name.startsWith('.orivo-tracing/backend/')));
  assert.equal(await shell.locator('#backend-setup-preview').count(), 0);
  assert.match(await shell.locator('#tracing-setup-content').textContent(), /python -B -m uvicorn orivo_backend:app/);
  await writeFile(path.join(first, 'user-note.txt'), 'Preserve unrelated work.\n');
  await shell.locator('#backend-setup-undo').click(); await shell.locator('#backend-setup-preview').waitFor();
  const undone = await snapshot(first); assert.equal(undone['user-note.txt'], 'Preserve unrelated work.\n'); delete undone['user-note.txt'];
  assert.deepEqual(undone, originalFirst); assert.equal((await shell.evaluate(() => window.traceAtlas.getTracingSetup())).guided.backendInstalled, false);
  checks.push('Reviewed Apply writes only the separate backend entry, kit, and journal; backend undo preserves existing frontend tracing and unrelated edits');

  const pending = await shell.evaluate(value => window.traceAtlas.previewTracingSetup(value), options);
  await connect(second);
  await assert.rejects(shell.evaluate(id => window.traceAtlas.applyTracingSetup(id), pending.id), /project changed|preview.*again/i);
  assert.deepEqual(await snapshot(second), originalSecond);
  const preserved = await snapshot(first); delete preserved['user-note.txt']; assert.deepEqual(preserved, originalFirst);
  checks.push('Switching connected projects invalidates the pending backend plan without writing either project');

  await shell.keyboard.press('Escape'); await waitNativeVisible(true);
  await screenshot('backend-setup-restored.png');
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, checks, geometry, rendererErrors, run, evidence, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, rendererErrors, error: error.stack }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'backend-failure.png') }).catch(() => {});
  console.error('Backend setup artifacts: ' + evidence); throw error;
} finally { if (app) await app.close(); }
