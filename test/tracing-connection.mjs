import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, 'evidence');
const project = process.env.ORIVO_TRACING_PROJECT;
const offUrl = process.env.ORIVO_TRACING_OFF_URL;
const onUrl = process.env.ORIVO_TRACING_ON_URL;
const selector = process.env.ORIVO_TRACING_SELECTOR || '#auth-title';
const source = process.env.ORIVO_TRACING_SOURCE || 'frontend/src/components/auth/AuthGate.tsx';
const sourceLine = Number(process.env.ORIVO_TRACING_SOURCE_LINE || '89');
const expectedCoverage = process.env.ORIVO_TRACING_EXPECTED_COVERAGE || 'partial';
assert.ok(project && offUrl && onUrl, 'Provide ORIVO_TRACING_PROJECT, ORIVO_TRACING_OFF_URL and ORIVO_TRACING_ON_URL for two existing development servers.');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `connection-${Date.now()}`, ORIVO_START_MODE: 'welcome' };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const rendererErrors = [];
const headerGeometry = {};
let app;
let shell;

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], env, timeout: 30000 });
  shell = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.contentView.children[0].webContents.setBackgroundThrottling(false);
    window.setContentSize(1600, 1000);
    window.hide();
  });
  shell.setDefaultTimeout(20000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#welcome-dialog[open]').waitFor();
  await shell.keyboard.press('Escape');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await shell.evaluate(() => window.traceAtlas.connectRepository());
  await shell.evaluate(() => { window.__connectionGraph = null; window.traceAtlas.onTrace(graph => { window.__connectionGraph = graph; }); });

  async function nativePickCurrent(targetSelector = selector) {
    await shell.waitForFunction(() => !document.querySelector('#inspect-button').disabled);
    const previewId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.id);
    await app.evaluate(async ({ webContents }, { id, selector }) => {
      const contents = webContents.fromId(id);
      await contents.executeJavaScript(`new Promise(resolve => { const check=()=>document.querySelector(${JSON.stringify(selector)}) ? resolve(true) : setTimeout(check, 50); check(); })`);
    }, { id: previewId, selector: targetSelector });
    await shell.evaluate(() => { window.__connectionGraph = null; });
    await shell.locator('#inspect-button').click();
    await shell.locator('#inspect-button.inspecting').waitFor();
    await app.evaluate(async ({ webContents }, { id, selector }) => {
      const contents = webContents.fromId(id);
      const point = await contents.executeJavaScript(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
      contents.sendInputEvent({ type: 'mouseMove', ...point });
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    }, { id: previewId, selector: targetSelector });
    await shell.waitForFunction(() => window.__connectionGraph !== null);
    return shell.evaluate(() => window.__connectionGraph);
  }

  async function nativePick(url) {
    await shell.evaluate(address => window.traceAtlas.openApp(address), url);
    return nativePickCurrent();
  }

  async function nativeVisible() {
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible());
  }

  async function waitNativeVisible(visible) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await nativeVisible() === visible) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await nativeVisible(), visible);
  }

  async function resizeSidebar(width) {
    const bounds = await shell.locator('#sidebar-sash').boundingBox();
    const current = await shell.locator('#app-sidebar').evaluate(node => node.getBoundingClientRect().width);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 100 };
    await shell.mouse.move(point.x, point.y);
    await shell.mouse.down();
    await shell.mouse.move(point.x + width - current, point.y, { steps: 12 });
    await shell.mouse.up();
    await shell.waitForFunction(expected => Math.abs(document.querySelector('#app-sidebar').getBoundingClientRect().width - expected) <= 1, width);
  }

  async function compactHeader({ wide = false } = {}) {
    const measured = await shell.evaluate(() => {
      const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom, centerY: box.y + box.height / 2 }; };
      const sidebar = document.querySelector('#app-sidebar');
      return { sidebar: rect('#app-sidebar'), preview: rect('#preview-surface'), url: rect('#url-form'), inspect: rect('#inspect-button'), reload: rect('#reload-app'), appTab: rect('#explorer-app'), project: rect('#project-name'), expand: rect('#expand-preview'), pageOverflow: document.documentElement.scrollWidth > innerWidth, sidebarOverflow: sidebar.scrollWidth > sidebar.clientWidth + 1 };
    });
    assert.ok(measured.preview.y - measured.sidebar.y <= 95, 'The browser must begin within 95 logical pixels of the Explorer top.');
    assert.ok(Math.abs(measured.url.centerY - measured.inspect.centerY) <= 2 && Math.abs(measured.url.centerY - measured.reload.centerY) <= 2, 'Address, picker and reload must share one browser toolbar row.');
    if (wide) assert.ok(Math.abs(measured.appTab.centerY - measured.project.centerY) <= 4 && Math.abs(measured.appTab.centerY - measured.expand.centerY) <= 4, 'Explorer tabs, project and maximize must share the first header row.');
    assert.equal(measured.pageOverflow, false);
    assert.equal(measured.sidebarOverflow, false);
    for (const name of ['url', 'inspect', 'reload', 'expand']) assert.ok(measured[name].x >= measured.sidebar.x - 1 && measured[name].right <= measured.sidebar.right + 1, `${name} must stay inside the browser panel`);
    assert.ok(measured.inspect.width >= 24 && measured.inspect.height >= 24, 'The picker must remain accessible in a narrow pane.');
    assert.match(await shell.locator('#inspect-button').getAttribute('aria-label'), /select.*element/i);
    return { sidebarWidth: measured.sidebar.width, headerHeight: measured.preview.y - measured.sidebar.y, toolbarHeight: measured.url.height, inspectWidth: measured.inspect.width, overflow: measured.pageOverflow || measured.sidebarOverflow };
  }

  async function screenshot(filename) {
    await shell.evaluate(async () => { await document.fonts.ready; document.querySelectorAll('.toast').forEach(node => node.remove()); });
    const png = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0];
      try {
        window.showInactive();
        await new Promise(resolve => setTimeout(resolve, 200));
        const bounds = window.getBounds();
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width * 2, height: bounds.height * 2 } });
        const own = sources.find(source => source.id === window.getMediaSourceId());
        return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
      } finally {
        window.hide();
      }
    });
    await writeFile(path.join(evidence, filename), Buffer.from(png, 'base64'));
  }

  await resizeSidebar(800);
  headerGeometry.wide = await compactHeader({ wide: true });
  const untraced = await nativePick(offUrl);
  assert.equal(untraced.coverage, 'unavailable');
  assert.equal(untraced.reason, 'not_running');
  assert.equal(untraced.files.length, 0);
  assert.deepEqual(untraced.summary, { requests: 0, queries: 0, tables: 0 });
  await shell.locator('#trace-readiness').waitFor({ state: 'visible' });
  assert.equal(await shell.locator('#trace-readiness-title').textContent(), 'Element selected');
  assert.equal(await shell.locator('#trace-readiness-reason').textContent(), 'Runtime tracing is off');
  assert.equal(await shell.locator('#trace-graph .graph-node[data-kind="gap"]').count(), 0);
  assert.match(await shell.locator('#trace-coverage-reasons').textContent(), /restart.*frontend server/i);
  checks.push('An untraced application reports not_running after a genuine native heading selection.');
  await screenshot('16-tracing-off.png');

  await shell.locator('#trace-coverage-details summary').click();
  await shell.locator('#trace-setup').click();
  await shell.locator('#tracing-setup-dialog[open]').waitFor();
  await shell.waitForFunction(() => !document.querySelector('#tracing-setup-status').textContent.includes('Checking'));
  assert.equal(await nativeVisible(), false, 'Tracing setup must hide the native preview.');
  const setup = await shell.evaluate(() => window.traceAtlas.getTracingSetup());
  assert.ok(setup.frontends.some(row => row.directory === 'frontend' && row.framework === 'React' && row.bundler === 'Vite'));
  assert.ok(setup.existingTracing.some(row => row.configFile === 'frontend/vite.config.ts' && row.flag === 'VITE_STUDIO_TRACE'));
  assert.equal(setup.readOnly, true);
  assert.equal(setup.runtime.status, 'not_running');
  const setupContent = await shell.locator('#tracing-setup-content').textContent();
  assert.match(setupContent, /Activate the existing tracing configuration/);
  assert.match(setupContent, /VITE_STUDIO_TRACE/);
  assert.match(setupContent, /frontend\/vite\.config\.ts/);
  assert.match(setupContent, /additional adapter installation or duplicate plugin is not needed/);
  assert.ok(!/Add development tracing|Install the local adapters\/tracing package/.test(setupContent), 'Existing tracing must not suggest installing a second integration.');
  await screenshot('17-tracing-setup.png');
  await shell.evaluate(() => { window.__connectionGraph = null; });
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    contents.__qaReloadFinished = false;
    contents.once('did-finish-load', () => { contents.__qaReloadFinished = true; });
  });
  await shell.locator('#tracing-setup-reload').click();
  await shell.locator('#tracing-setup-dialog').waitFor({ state: 'hidden' });
  await shell.locator('#graph-empty').waitFor({ state: 'visible' });
  let reloadFinished = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    reloadFinished = await app.evaluate(({ BrowserWindow }) => { const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents; return contents.__qaReloadFinished && !contents.isLoading(); });
    if (reloadFinished) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(reloadFinished, true, 'Wait for the actual reloaded document before beginning another navigation.');
  await shell.waitForFunction(() => window.traceAtlas.getState().then(state => !state.loading));
  assert.equal(await shell.locator('#trace-readiness').isVisible(), false);
  assert.match(await shell.locator('#coverage-badge').textContent(), /Awaiting selection/);
  assert.equal(await shell.evaluate(() => window.__connectionGraph), null, 'Reload must request a fresh selection, without resurrecting stale captured evidence.');
  assert.equal(await nativeVisible(), true);
  checks.push('Setup detects the existing React/Vite activation flag, hides the native preview, and reload returns to a fresh selection prompt.');

  const traced = await nativePick(onUrl);
  assert.equal(traced.coverage, expectedCoverage, JSON.stringify({ reason: traced.reason, mode: traced.mode, gaps: traced.gaps }));
  assert.equal(traced.captured, true);
  assert.equal(traced.reason, null);
  assert.ok(traced.files.includes(source), 'The instrumented heading must resolve to its exact frontend source.');
  assert.deepEqual(traced.summary, { requests: 0, queries: 0, tables: 0 });
  assert.ok(!traced.nodes.some(node => ['api', 'query', 'database', 'backend'].includes(node.kind)), 'A local heading must not inherit API, SQL, or database evidence.');
  const sourceNode = traced.nodes.find(node => node.file === source);
  assert.ok(sourceNode, 'The trace must include a source node backed by the connected repository.');
  assert.equal(sourceNode.line, sourceLine, 'The selected heading must resolve to its original JSX line.');
  const sourceHash = createHash('sha256').update(await readFile(path.join(project, source))).digest('hex');
  assert.equal(sourceNode.meta.sourceHash, sourceHash, 'The captured source hash must match the selected repository bytes.');
  assert.equal(await shell.locator('#trace-readiness-title').textContent(), 'Captured through source');
  assert.equal(await shell.locator('#trace-readiness-reason').textContent(), 'No request captured for this selection.');
  for(const gap of traced.gaps)assert.ok((await shell.locator('#trace-coverage-reasons').textContent()).includes(gap), 'Full diagnostics remain available in coverage details.');
  checks.push('The trace-enabled application captures the same heading and matching frontend source without inventing API, SQL, or database links.');
  await screenshot('18-tracing-heading-source.png');

  // These states use the bundled demo, independently of the external heading result above.
  await shell.evaluate(() => window.traceAtlas.openDemo());
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  const frontend = await nativePickCurrent('[data-trace-id="static-note"]');
  assert.equal(frontend.coverage, 'frontend');
  assert.equal(await shell.locator('#trace-readiness-title').textContent(), 'Frontend source captured');
  assert.equal(await shell.locator('#trace-readiness-reason').textContent(), 'No API or SQL dependency captured.');
  const demoPreview = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.id);
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript(`(() => {const heading=document.createElement('h2');heading.id='qa-unsupported';heading.textContent='Unbound QA heading';heading.style.cssText='position:fixed;left:24px;top:24px;z-index:2147483000;background:#0d1117;color:white;padding:16px';document.body.prepend(heading);})()`), demoPreview);
  const unsupported = await nativePickCurrent('#qa-unsupported');
  assert.equal(unsupported.reason, 'unsupported_element');
  assert.equal(await shell.locator('#trace-readiness-title').textContent(), 'Element selected');
  assert.equal(await shell.locator('#trace-readiness-reason').textContent(), 'No binding captured for this element');
  assert.match(await shell.locator('#trace-coverage-reasons').textContent(), /Tracing is running/);
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript(`(() => {const heading=document.querySelector('[data-trace-id="static-note"]');const map=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1').value;map.get(heading).source.hash='0'.repeat(64);})()`), demoPreview);
  const stale = await nativePickCurrent('[data-trace-id="static-note"]');
  assert.equal(stale.reason, 'source_changed');
  assert.equal(stale.files.length, 0);
  assert.equal(await shell.locator('#trace-readiness-title').textContent(), 'Element selected');
  assert.equal(await shell.locator('#trace-readiness-reason').textContent(), 'Source version changed');
  assert.match(await shell.locator('#trace-coverage-reasons').textContent(), /hash does not match/);
  checks.push('Bundled-demo checks distinguish a frontend-only selection, an unsupported binding, and a stale source claim in the readiness UI.');

  await shell.locator('#sidebar-sash').focus();
  await shell.keyboard.press('Home');
  await shell.waitForFunction(() => Math.abs(document.querySelector('#app-sidebar').getBoundingClientRect().width - 320) <= 1);
  headerGeometry.narrow = await compactHeader();
  await shell.locator('#explorer-sources').click();
  await shell.waitForFunction(() => document.querySelector('#sidebar-preview-area').hidden);
  await waitNativeVisible(false);
  await shell.locator('#explorer-app').click();
  await shell.waitForFunction(() => !document.querySelector('#sidebar-preview-area').hidden);
  await waitNativeVisible(true);
  const height = await shell.locator('#preview-surface').evaluate(node => node.getBoundingClientRect().height);
  await shell.locator('#preview-height-sash').focus();
  await shell.keyboard.press('ArrowUp');
  await shell.waitForFunction(expected => Math.abs(document.querySelector('#preview-surface').getBoundingClientRect().height - expected) <= 1, height - 10);
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => document.body.classList.contains('preview-maximized'));
  assert.equal(await shell.locator('#preview-height-sash').isVisible(), false);
  const maximized = await shell.locator('#preview-surface').boundingBox();
  assert.ok(maximized.width > 1400);
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => !document.body.classList.contains('preview-maximized'));
  assert.equal(await shell.locator('#preview-height-sash').isVisible(), true);
  await shell.locator('#preview-height-sash').focus();
  await shell.keyboard.press('Home');
  checks.push('Compact two-row headers preserve 800px and 320px layouts, source tabs, keyboard browser-height resizing, and maximize/restore.');
  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, checks, untraced: { coverage: untraced.coverage, reason: untraced.reason }, traced: { coverage: traced.coverage, mode: traced.mode, reason: traced.reason, files: traced.files, sourceLine: sourceNode.line, sourceHashMatches: true, summary: traced.summary, gaps: traced.gaps }, headerGeometry, rendererErrors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'tracing-connection-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'tracing-connection-result.json'), JSON.stringify({ passed: false, checks, error: error.stack, rendererErrors }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
}
