import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `maximize-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const rendererErrors = [];
let app;
let shell;

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  shell = await app.firstWindow();
  shell.setDefaultTimeout(15000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  const initial = await shell.evaluate(() => window.traceAtlas.getState());
  const previewId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))?.id, initial.url);
  assert.ok(previewId, 'A real application WebContentsView must be present');

  async function waitMode(maximized) {
    await shell.waitForFunction(async expected => {
      const state = await window.traceAtlas.getState();
      return state.previewMaximized === expected && document.body.classList.contains('preview-maximized') === expected;
    }, maximized);
  }

  async function nativePreview() {
    return app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children[0];
      return { visible: view.getVisible(), bounds: view.getBounds() };
    });
  }

  async function verifyExpandedGeometry() {
    // The renderer reports DOM bounds after its animation frame; sample the actual native view too.
    await shell.waitForFunction(() => {
      const rect = document.querySelector('#preview-surface').getBoundingClientRect();
      return rect.width > innerWidth * 0.7 && rect.height > innerHeight * 0.55;
    });
    let geometry;
    let native;
    for (let attempt = 0; attempt < 40; attempt++) {
      geometry = await shell.evaluate(() => {
        const { x, y, width, height } = document.querySelector('#preview-surface').getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
      });
      native = await nativePreview();
      if (native.visible && ['x', 'y', 'width', 'height'].every(key => Math.abs(native.bounds[key] - geometry[key]) <= 1)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(native.visible, true, 'Expanded native application must remain visible');
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(native.bounds[key] - geometry[key]) <= 1, `Native ${key} must follow the expanded preview surface: ${JSON.stringify({ geometry, native })}`);
    assert.ok(geometry.width > geometry.viewport.width * 0.7, 'Expanded app should use the workspace width');
    assert.ok(geometry.height > geometry.viewport.height * 0.55, 'Expanded app should use the workspace height');
    assert.equal(geometry.overflow, false, 'Expanded desktop must not overflow the application window');
    assert.equal(await shell.locator('.main-content').isVisible(), false);
    assert.equal(await shell.locator('#sidebar-sash').isVisible(), false);
    assert.equal(await shell.locator('.explorer-tabs').isVisible(), false);
    assert.equal(await shell.locator('.selected-section').isVisible(), false);
    assert.equal(await shell.locator('.history-section').isVisible(), false);
    assert.equal(await shell.locator('#inspect-button').isVisible(), true);
    assert.equal(await shell.locator('#expand-preview').getAttribute('aria-pressed'), 'true');
    assert.match(await shell.locator('#expand-preview').getAttribute('title'), /restore/i);
    return geometry;
  }

  async function nativeEscape() {
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, previewId);
  }

  async function maximize() {
    await shell.locator('#expand-preview').click();
    await waitMode(true);
    return verifyExpandedGeometry();
  }

  async function normalWorkspace() {
    await waitMode(false);
    assert.equal(await shell.locator('.main-content').isVisible(), true);
    assert.equal(await shell.locator('#sidebar-sash').isVisible(), true);
    assert.equal(await shell.locator('#expand-preview').getAttribute('aria-pressed'), 'false');
    assert.match(await shell.locator('#expand-preview').getAttribute('title'), /maximize/i);
  }

  await shell.locator('#sidebar-sash').focus();
  await shell.keyboard.press('ArrowRight');
  await shell.keyboard.press('ArrowRight');
  const savedWidth = await shell.evaluate(() => ({ css: document.body.style.getPropertyValue('--sidebar'), saved: localStorage.getItem('trace-atlas-sidebar') }));
  await shell.locator('#explorer-sources').click();
  const expanded = await maximize();
  assert.equal(await shell.locator('#sidebar-preview-area').isVisible(), true, 'Maximizing from Sources should show the live application');
  checks.push(`Maximize fills the desktop workspace and native view (${expanded.width} × ${expanded.height}) when Sources is selected`);

  await shell.locator('#nav-connections').click();
  await shell.locator('#connections-dialog[open]').waitFor();
  assert.equal((await nativePreview()).visible, false, 'The native preview must not cover an open modal');
  await shell.keyboard.press('Escape');
  await shell.locator('#connections-dialog').waitFor({ state: 'hidden' });
  await verifyExpandedGeometry();
  checks.push('Opening a modal hides the maximized native preview and closing it restores the correct bounds');

  const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width * 2, height: bounds.height * 2 } });
    const own = sources.find(source => source.id === window.getMediaSourceId());
    return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(evidence, '10-preview-maximized.png'), Buffer.from(capture, 'base64'));

  await nativeEscape();
  await normalWorkspace();
  assert.deepEqual(await shell.evaluate(() => ({ css: document.body.style.getPropertyValue('--sidebar'), saved: localStorage.getItem('trace-atlas-sidebar') })), savedWidth, 'Restoring must preserve the resized sidebar preference');
  checks.push('Escape while the application has native keyboard focus restores the workspace and preserves the saved sidebar width');

  await maximize();
  await shell.locator('#app-url').focus();
  await shell.keyboard.press('Escape');
  await normalWorkspace();
  checks.push('Escape also restores the preview when the address input has keyboard focus');

  await maximize();
  await shell.locator('#expand-preview').click();
  await normalWorkspace();
  checks.push('The visible Restore control returns to the normal trace workspace');

  await maximize();
  await shell.locator('#inspect-button').click();
  await shell.locator('#inspect-button.inspecting').waitFor();
  await nativeEscape();
  await shell.waitForFunction(async () => !(await window.traceAtlas.getState()).inspectMode);
  await waitMode(true);
  assert.equal(await shell.locator('#inspect-button').getAttribute('class').then(value => value.includes('inspecting')), false);
  await nativeEscape();
  await normalWorkspace();
  checks.push('The first native Escape cancels element selection; the next Escape restores the workspace');

  await maximize();
  await shell.locator('#inspect-button').click();
  await shell.locator('#inspect-button.inspecting').waitFor();
  await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    const point = await contents.executeJavaScript(`(() => { const element = document.querySelector('[data-trace-id="name-orbit"]'); element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }, previewId);
  await shell.locator('#trace-graph').filter({ hasText: 'products.name' }).waitFor();
  await normalWorkspace();
  assert.equal(await shell.locator('#map-view').isVisible(), true);
  assert.match(await shell.locator('#coverage-badge').textContent(), /Element to column captured/);
  assert.doesNotMatch(await shell.locator('#trace-graph').textContent(), /products\.price/);
  checks.push('Selecting a real product name while maximized restores the trace map with its actual source-to-SQL column path');

  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(...window.getMinimumSize()); });
  await shell.waitForFunction(() => innerWidth <= 1100);
  const minimum = await maximize();
  await shell.keyboard.press('Control+k');
  await shell.locator('#command-dialog[open]').waitFor();
  await shell.locator('#command-input').fill('Layout: reset panel sizes');
  await shell.locator('#command-input').press('Enter');
  await shell.locator('#command-dialog').waitFor({ state: 'hidden' });
  await normalWorkspace();
  assert.equal(await shell.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks.push(`Maximize works at the 1100 × 700 desktop minimum (${minimum.width} × ${minimum.height} preview); reset layout restores the normal desktop`);

  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, checks, rendererErrors, screenshot: '10-preview-maximized.png', runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'preview-maximize-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'preview-maximize-result.json'), JSON.stringify({ passed: false, checks, error: error.stack, rendererErrors }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'preview-maximize-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
