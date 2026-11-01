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
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `resize-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const rendererErrors = [];
let app;
let shell;

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  shell = await app.firstWindow();
  // Keep this isolated test from receiving the user's physical mouse input.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
  });
  shell.setDefaultTimeout(15000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();

  async function sizeWindow(width, height = 850) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setContentSize(size.width, size.height);
    }, { width, height });
    await shell.waitForFunction(expected => {
      const workbench = document.querySelector('.workbench');
      const maximum = Number(document.querySelector('#sidebar-sash').getAttribute('aria-valuemax'));
      const divider=getComputedStyle(document.querySelector('#sidebar-sash')).position==='absolute'?0:document.querySelector('#sidebar-sash').getBoundingClientRect().width;
      return Math.abs(innerWidth - expected) <= 1 && Math.abs(maximum - Math.max(250, workbench.clientWidth - 400 - divider)) <= 1;
    }, width);
  }

  async function geometry() {
    return shell.evaluate(() => {
      const rect = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      };
      const sash = document.querySelector('#sidebar-sash');
      return {
        sidebar: rect('#app-sidebar'),
        preview: rect('#preview-surface'),
        main: rect('.main-content'),
        workbench: rect('.workbench'),
        sash: rect('#sidebar-sash'),
        min: Number(sash.getAttribute('aria-valuemin')),
        max: Number(sash.getAttribute('aria-valuemax')),
        now: Number(sash.getAttribute('aria-valuenow')),
        saved: Number(localStorage.getItem('trace-atlas-sidebar')),
        overflow: document.documentElement.scrollWidth > innerWidth,
        dragging: sash.classList.contains('dragging')
      };
    });
  }

  async function nativePreview() {
    return app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children[0];
      return { visible: view.getVisible(), bounds: view.getBounds() };
    });
  }

  async function nativeFollowsSurface({ visible = true } = {}) {
    let measured;
    let native;
    for (let attempt = 0; attempt < 60; attempt++) {
      measured = await geometry();
      native = await nativePreview();
      if (native.visible === visible && ['x', 'y', 'width', 'height'].every(key => Math.abs(native.bounds[key] - measured.preview[key]) <= 1)) return measured;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`Native application must follow the resized surface: ${JSON.stringify({ measured, native })}`);
  }

  async function expectWidth(width, { saved = width } = {}) {
    await shell.waitForFunction(expected => Math.abs(document.querySelector('#app-sidebar').getBoundingClientRect().width - expected) <= 1, width);
    const measured = await nativeFollowsSurface();
    assert.ok(Math.abs(measured.now - measured.sidebar.width) <= 1, 'Separator value must reflect the rendered width');
    assert.equal(measured.min, 250);
    assert.ok(Math.abs(measured.max - Math.max(250, measured.workbench.width - 400)) <= 1, 'The limit must adapt to the workspace and reserve a usable trace pane');
    assert.equal(measured.saved, saved, 'The preferred width must remain in local storage');
    assert.equal(measured.overflow, false, 'Resizing must not create page overflow');
    assert.ok(measured.main.width >= 400, 'The trace pane must retain its reserved width');
    return measured;
  }

  async function dragTo(width) {
    const box = await shell.locator('#sidebar-sash').boundingBox();
    assert.ok(box);
    const current = (await geometry()).sidebar.width;
    // Trusted mouse input and real pointer capture exercise the drag handlers, rather than assigning CSS.
    const point = { x: box.x + box.width / 2, y: Math.max(30, Math.min(box.y + box.height / 2, 400)) };
    await shell.mouse.move(point.x, point.y);
    await shell.mouse.down();
    await shell.waitForFunction(() => document.querySelector('#sidebar-sash').classList.contains('dragging'));
    await shell.mouse.move(point.x + (width - current) / 2, point.y, { steps: 12 });
    await shell.waitForFunction(() => {
      const frame = document.querySelector('#preview-resize-frame');
      return document.body.classList.contains('preview-resizing') && !frame.hidden && frame.complete && frame.naturalWidth > 0;
    });
    const duringDrag = await nativeFollowsSurface({ visible: false });
    assert.equal(duringDrag.dragging, true, 'The native preview must follow before the divider is released');
    const frame = await shell.locator('#preview-resize-frame').boundingBox();
    assert.ok(Math.abs(frame.width - duringDrag.preview.width) <= 1 && Math.abs(frame.height - duringDrag.preview.height) <= 1, 'The temporary frame must fill the resized surface');
    if (width === 800 && current === 320) await shell.screenshot({ path: path.join(evidence, '11-preview-resizing-frame.png') });
    await shell.mouse.move(point.x + width - current, point.y, { steps: 12 });
    await shell.mouse.up();
    await shell.waitForFunction(() => !document.querySelector('#sidebar-sash').classList.contains('dragging'));
  }

  async function resetLayout() {
    await shell.keyboard.press('Control+k');
    await shell.locator('#command-dialog[open]').waitFor();
    await shell.locator('#command-input').fill('Layout: reset panel sizes');
    await shell.locator('#command-input').press('Enter');
    await shell.locator('#command-dialog').waitFor({ state: 'hidden' });
    await shell.waitForFunction(() => !document.body.classList.contains('preview-maximized'));
  }

  await sizeWindow(1600);
  await shell.evaluate(() => {
    window.__resizePointerEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.querySelector('#sidebar-sash').addEventListener(type, event => {
        window.__resizePointerEvents.push({ type, trusted: event.isTrusted, capture: event.currentTarget.hasPointerCapture(event.pointerId), x: event.clientX, buttons: event.buttons, pointerId: event.pointerId, width: document.querySelector('#app-sidebar').getBoundingClientRect().width });
      });
    }
  });
  await dragTo(800);
  const wide = await expectWidth(800);
  assert.ok(wide.sidebar.width > 480, 'The application panel must grow beyond the previous fixed limit');
  const pointerEvents = await shell.evaluate(() => window.__resizePointerEvents);
  assert.ok(pointerEvents.some(event => event.type === 'pointerdown' && event.trusted));
  assert.ok(pointerEvents.some(event => event.type === 'pointermove' && event.trusted && event.capture));
  assert.ok(pointerEvents.some(event => event.type === 'pointerup' && event.trusted));
  checks.push(`Trusted divider drag widens the application to ${wide.sidebar.width}px; its native view follows to ${wide.preview.width}px`);

  await shell.evaluate(() => document.querySelectorAll('.toast').forEach(toast => toast.remove()));
  const screenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const window = BrowserWindow.getAllWindows()[0];
    try {
      window.showInactive();
      await new Promise(resolve => setTimeout(resolve, 150));
      const bounds = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width * 2, height: bounds.height * 2 } });
      const own = sources.find(source => source.id === window.getMediaSourceId());
      return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : (await window.capturePage()).toPNG().toString('base64');
    } finally {
      window.hide();
    }
  });
  await writeFile(path.join(evidence, '11-preview-resized.png'), Buffer.from(screenshot, 'base64'));

  await dragTo(560);
  await expectWidth(560);
  checks.push('Dragging back over the live application keeps pointer capture and resizes the native preview correctly');

  const sash = shell.locator('#sidebar-sash');
  await sash.focus();
  await shell.keyboard.press('ArrowRight');
  await expectWidth(570);
  await shell.keyboard.press('ArrowLeft');
  await expectWidth(560);
  await shell.keyboard.press('End');
  const limit = (await geometry()).max;
  await expectWidth(limit);
  await shell.keyboard.press('Home');
  const defaultWidth=320;
  await expectWidth(defaultWidth, { saved: 0 });
  checks.push('Keyboard arrows resize by 10px, End reaches the adaptive limit, and Home restores the default width');

  // The native child has a hidden parent during this test; use keyboard sizing
  // for subsequent preference checks after both actual drag directions passed.
  for (let step = 0; step < Math.floor((800-defaultWidth)/50); step++) await shell.keyboard.press('Shift+ArrowRight');
  for (let step = 0; step < ((800-defaultWidth)%50)/10; step++) await shell.keyboard.press('ArrowRight');
  await expectWidth(800);
  await shell.reload();
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  await expectWidth(800);
  checks.push('The preferred application width survives renderer reload');

  await sizeWindow(1100, 720);
  const small = await geometry();
  const clamped = await expectWidth(small.max, { saved: 800 });
  assert.ok(clamped.sidebar.width < 800, 'The effective width must shrink with the window');
  await sizeWindow(1600);
  await expectWidth(800);
  checks.push('Shrinking to the desktop minimum preserves the trace pane and saved preference; enlarging restores the preferred 800px width');

  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => document.body.classList.contains('preview-maximized'));
  const maximized = await nativeFollowsSurface();
  assert.ok(maximized.preview.width > 1400, 'Maximize should continue to fill the workspace');
  assert.equal(await shell.locator('#sidebar-sash').isVisible(), false);
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => !document.body.classList.contains('preview-maximized'));
  await expectWidth(800);
  checks.push('Maximize and Restore retain the chosen divider width');

  await resetLayout();
  await shell.waitForFunction(expected => Math.abs(document.querySelector('#app-sidebar').getBoundingClientRect().width - expected) <= 1,defaultWidth);
  const reset = await nativeFollowsSurface();
  assert.equal(reset.now, defaultWidth);
  assert.equal(await shell.evaluate(() => localStorage.getItem('trace-atlas-sidebar')), null);
  assert.equal(reset.overflow, false);
  checks.push('Reset panel sizes restores the responsive default, updates the accessible separator, and clears the stored preference');

  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, checks, rendererErrors, screenshot: '11-preview-resized.png', runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'preview-resize-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const pointerEvents = shell && await shell.evaluate(() => window.__resizePointerEvents).catch(() => null);
  await writeFile(path.join(evidence, 'preview-resize-result.json'), JSON.stringify({ passed: false, checks, error: error.stack, rendererErrors, pointerEvents }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'preview-resize-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
