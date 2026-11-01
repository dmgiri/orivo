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
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `height-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const rendererErrors = [];
let app;
let shell;

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  shell = await app.firstWindow();
  // The hidden isolated test cannot receive the user's physical mouse input.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
  });
  shell.setDefaultTimeout(15000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  await shell.evaluate(() => document.fonts.ready);

  async function sizeWindow(width, height) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setContentSize(size.width, size.height);
    }, { width, height });
    await shell.waitForFunction(size => Math.abs(innerWidth - size.width) <= 1 && Math.abs(innerHeight - size.height) <= 1, { width, height });
    await settledGeometry();
    await nativeFollowsSurface();
  }

  async function geometry() {
    return shell.evaluate(() => {
      const rect = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      };
      const sash = document.querySelector('#preview-height-sash');
      return {
        preview: rect('#preview-surface'),
        sidebar: rect('#app-sidebar'),
        workbench: rect('.workbench'),
        sash: rect('#preview-height-sash'),
        min: Number(sash.getAttribute('aria-valuemin')),
        max: Number(sash.getAttribute('aria-valuemax')),
        now: Number(sash.getAttribute('aria-valuenow')),
        saved: localStorage.getItem('trace-atlas-preview-height'),
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
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

  async function settledGeometry() {
    let previous;
    let stable = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = await geometry();
      const signature = JSON.stringify({ preview: current.preview, sash: current.sash, max: current.max });
      stable = signature === previous ? stable + 1 : 0;
      if (stable >= 4) return current;
      previous = signature;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail('Browser layout did not settle');
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

  async function expectHeight(height, { saved = height } = {}) {
    await shell.waitForFunction(expected => Math.abs(document.querySelector('#preview-surface').getBoundingClientRect().height - expected) <= 1, height);
    const measured = await nativeFollowsSurface();
    assert.ok(Math.abs(measured.now - measured.preview.height) <= 1, 'The horizontal separator must report the actual browser height');
    assert.equal(measured.saved, saved === null ? null : String(Math.round(saved)), 'The preferred browser height must remain in local storage');
    assert.equal(measured.overflow, false, 'Resizing the browser must not overflow the desktop window');
    return measured;
  }

  async function dragHeight(height) {
    await shell.locator('#app-url').focus();
    await settledGeometry();
    const box = await shell.locator('#preview-height-sash').boundingBox();
    assert.ok(box && box.height > 0, 'The browser bottom edge must be available to resize');
    const current = (await geometry()).preview.height;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await shell.mouse.move(point.x, point.y);
    await shell.mouse.down();
    await shell.waitForFunction(() => document.querySelector('#preview-height-sash').classList.contains('dragging'));
    await shell.waitForFunction(() => {
      const frame = document.querySelector('#preview-resize-frame');
      return document.body.classList.contains('preview-resizing') && !frame.hidden && frame.complete && frame.naturalWidth > 0;
    });
    // Hiding the native child can move the hidden test window's input focus.
    // Explicitly route CDP input back to its trusted renderer without showing it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.focus());
    await shell.mouse.move(point.x, point.y + (height - current) / 2, { steps: 12 });
    const during = await nativeFollowsSurface({ visible: false });
    assert.equal(during.dragging, true, 'The native browser must follow before the bottom edge is released');
    const frame = await shell.locator('#preview-resize-frame').boundingBox();
    assert.ok(Math.abs(frame.height - during.preview.height) <= 1 && Math.abs(frame.width - during.preview.width) <= 1, 'The temporary frame must fill the browser during resizing');
    const dragScreenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'));
    await writeFile(path.join(evidence, '12-preview-height-drag.png'), Buffer.from(dragScreenshot, 'base64'));
    await shell.mouse.move(point.x, point.y + height - current, { steps: 12 });
    await shell.mouse.up();
    await shell.waitForFunction(() => !document.querySelector('#preview-height-sash').classList.contains('dragging'));
    await expectHeight(height);
  }

  await sizeWindow(1600, 900);
  const initial = await nativeFollowsSurface();
  assert.ok(initial.preview.height > 400, 'The default browser should use the available explorer height instead of the old fixed 265px surface');
  assert.equal(initial.saved, null, 'A new workspace must start with automatic browser height');
  assert.equal(await shell.locator('#preview-height-sash').getAttribute('aria-orientation'), 'horizontal');
  assert.match(await shell.locator('#preview-height-sash').getAttribute('aria-label'), /resize.*(browser|preview)/i);
  const toolbar = await shell.locator('.preview-caption').boundingBox();
  const inspect = await shell.locator('#inspect-button').boundingBox();
  assert.ok(toolbar && inspect && inspect.y >= toolbar.y && inspect.y + inspect.height <= toolbar.y + toolbar.height + 1, 'Element selection must share the compact browser toolbar');
  assert.equal(await shell.locator('.selected-section').isVisible(), false, 'Browser metadata should start collapsed so it does not consume the browser area');
  checks.push(`The compact toolbar and collapsed details give the browser ${initial.preview.height}px of available height`);

  await shell.evaluate(() => {
    window.__heightPointerEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      document.querySelector('#preview-height-sash').addEventListener(type, event => window.__heightPointerEvents.push({ type, trusted: event.isTrusted, capture: event.currentTarget.hasPointerCapture(event.pointerId), y: event.clientY }));
    }
  });
  const smallerHeight = initial.preview.height - 150;
  await dragHeight(smallerHeight);
  const largerHeight = initial.preview.height - 70;
  await dragHeight(largerHeight);
  const events = await shell.evaluate(() => window.__heightPointerEvents);
  assert.ok(events.some(event => event.type === 'pointerdown' && event.trusted));
  assert.ok(events.some(event => event.type === 'pointermove' && event.trusted && event.capture));
  assert.ok(events.some(event => event.type === 'pointerup' && event.trusted));
  checks.push('Trusted bottom-edge drags shrink and grow the live browser; native geometry and temporary frames stay aligned');

  const sash = shell.locator('#preview-height-sash');
  await sash.focus();
  await shell.keyboard.press('ArrowDown');
  await expectHeight(largerHeight + 10);
  await shell.keyboard.press('ArrowUp');
  await expectHeight(largerHeight);
  checks.push('Keyboard arrows resize the browser by 10px using the accessible horizontal separator');

  await shell.reload();
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  await expectHeight(largerHeight);
  checks.push('The chosen browser height survives renderer reload');

  await sizeWindow(1100, 720);
  const small = await geometry();
  const clamped = await expectHeight(Math.min(largerHeight, small.max), { saved: largerHeight });
  assert.ok(clamped.preview.height < largerHeight, 'Shrinking the desktop window should clamp the browser to available height');
  await sizeWindow(1600, 900);
  await expectHeight(largerHeight);
  checks.push('Desktop window shrinking clamps the browser without losing its preferred height; growing restores the preference');

  const details = shell.locator('#preview-details-toggle');
  assert.equal(await shell.locator('#preview-details').getAttribute('open'), null);
  assert.equal(await details.evaluate(element => element.tagName), 'SUMMARY', 'Native details must provide its accessible disclosure semantics');
  await details.focus();
  await shell.keyboard.press('Enter');
  await shell.waitForFunction(() => document.querySelector('#preview-details').open);
  assert.equal(await shell.locator('.selected-section').isVisible(), true);
  assert.equal(await shell.locator('#connect-repo').isVisible(), true);
  assert.equal(await shell.locator('#trace-history').isVisible(), true);
  await shell.locator('#explorer-sources').click();
  await shell.waitForFunction(() => document.querySelector('#sidebar-preview-area').hidden);
  assert.ok(await shell.locator('.preview-details-content').evaluate(element => element.getBoundingClientRect().height) > 0, 'Source navigation must retain a usable details disclosure');
  await shell.locator('#explorer-app').click();
  await shell.waitForFunction(() => !document.querySelector('#sidebar-preview-area').hidden);
  await settledGeometry();
  assert.ok(await shell.locator('.preview-details-content').evaluate(element => element.getBoundingClientRect().height) > 0, 'Returning to the browser must preserve expanded details');
  const disclosed = await nativeFollowsSurface();
  assert.equal(disclosed.overflow, false);
  await details.click();
  await shell.waitForFunction(() => !document.querySelector('#preview-details').open);
  await expectHeight(largerHeight);
  checks.push('Keyboard-accessible details reveal metadata, remain usable across Sources/Application navigation, then return the area to the browser');

  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => document.body.classList.contains('preview-maximized'));
  assert.equal(await sash.isVisible(), false, 'Maximize should hide the bottom resize edge');
  const maximized = await nativeFollowsSurface();
  assert.ok(maximized.preview.height > largerHeight, 'Maximize should fill the remaining workspace height');
  assert.ok(maximized.preview.width > 1400, 'Maximize must retain full workspace width');
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => !document.body.classList.contains('preview-maximized'));
  await expectHeight(largerHeight);
  checks.push('Maximize still fills the workspace, hides the resize edge, and Restore preserves the chosen browser height');

  const state = await shell.evaluate(() => window.traceAtlas.getState());
  const previewId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))?.id, state.url);
  assert.ok(previewId);
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
  assert.match(await shell.locator('#coverage-badge').textContent(), /Element to column captured/);
  await expectHeight(largerHeight);
  checks.push('Selecting a real element in the resized native browser still captures its actual source-to-SQL column path');

  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(() => document.body.classList.contains('preview-maximized'));
  await shell.locator('#nav-history').click();
  await shell.waitForFunction(() => !document.body.classList.contains('preview-maximized') && document.querySelector('#preview-details').open);
  await settledGeometry();
  await nativeFollowsSurface();
  const revealedHistory = await shell.evaluate(() => {
    const content = document.querySelector('.preview-details-content');
    const history = document.querySelector('#trace-history .history-item');
    const contentBounds = content.getBoundingClientRect();
    const historyBounds = history.getBoundingClientRect();
    return { top: historyBounds.top, bottom: historyBounds.bottom, contentTop: contentBounds.top, contentBottom: contentBounds.bottom, sidebarScroll: document.querySelector('#app-sidebar').scrollTop, workbenchScroll: document.querySelector('.workbench').scrollTop, contentScroll: content.scrollTop };
  });
  assert.ok(revealedHistory.top >= revealedHistory.contentTop - 1 && revealedHistory.bottom <= revealedHistory.contentBottom + 1, 'History navigation must reveal a complete trace row inside the details viewport');
  assert.equal(revealedHistory.sidebarScroll, 0, 'History navigation must not scroll the entire browser sidebar');
  assert.equal(revealedHistory.workbenchScroll, 0, 'History navigation must not scroll the entire workbench');
  assert.ok(revealedHistory.contentScroll > 0, 'Only the details content should scroll to history');
  await details.click();
  await shell.waitForFunction(() => !document.querySelector('#preview-details').open);
  await settledGeometry();
  await expectHeight(largerHeight);
  checks.push('History navigation restores a maximized browser and reveals captured traces by scrolling only the details content');

  const minimumWindow = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.unmaximize();
    window.setSize(1100, 700);
    return { outer: window.getSize(), content: window.getContentSize() };
  });
  assert.ok(Math.abs(minimumWindow.outer[0] - 1100) <= 2 && Math.abs(minimumWindow.outer[1] - 700) <= 2, 'The regression must use the true native minimum outer size, allowing Windows DPI rounding');
  await shell.waitForFunction(size => Math.abs(innerWidth - size[0]) <= 1 && Math.abs(innerHeight - size[1]) <= 1, minimumWindow.content);
  await details.click();
  await shell.waitForFunction(() => document.querySelector('#preview-details').open);
  await settledGeometry();
  const minimum = await nativeFollowsSurface();
  const contained = await shell.evaluate(() => {
    const rect = selector => {
      const { top, bottom, left, right } = document.querySelector(selector).getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const sidebar = document.querySelector('#app-sidebar');
    return { viewport: { width: innerWidth, height: innerHeight }, sidebar: rect('#app-sidebar'), footer: rect('.sidebar-footer'), browser: rect('#preview-surface'), edge: rect('#preview-height-sash'), details: rect('#preview-details'), sidebarScroll: sidebar.scrollTop, sidebarOverflow: sidebar.scrollHeight > sidebar.clientHeight + 1 };
  });
  for (const name of ['footer', 'browser', 'edge', 'details']) {
    const box = contained[name];
    assert.ok(box.top >= contained.sidebar.top - 1 && box.bottom <= contained.viewport.height + 1 && box.left >= contained.sidebar.left - 1 && box.right <= contained.sidebar.right + 1, `${name} must remain fully inside the actual native desktop content area: ${JSON.stringify(contained)}`);
  }
  assert.ok(minimum.preview.height >= 160, 'Expanded details must preserve a usable browser at the native desktop minimum');
  assert.equal(minimum.overflow, false);
  assert.equal(contained.sidebarOverflow, false, 'The minimum-height sidebar must not clip or require scrolling to reach its footer');
  assert.equal(contained.sidebarScroll, 0);
  await shell.screenshot({ path: path.join(evidence, '12-preview-height-minimum.png') });
  await details.click();
  await shell.waitForFunction(() => !document.querySelector('#preview-details').open);
  await sizeWindow(1600, 900);
  await expectHeight(largerHeight);
  checks.push('At the true 1100 × 700 native window minimum, expanded details preserve the browser, resize edge and complete footer without clipping');

  await sash.focus();
  await shell.keyboard.press('Home');
  const automatic = await nativeFollowsSurface();
  assert.equal(automatic.saved, null);
  assert.equal(automatic.preview.height, initial.preview.height);
  checks.push('Home resets the browser to automatic available height and clears the preference');

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
  await writeFile(path.join(evidence, '12-preview-height.png'), Buffer.from(screenshot, 'base64'));
  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, checks, rendererErrors, initial, smallerHeight, largerHeight, minimumWindow, minimumContainment: contained, screenshot: '12-preview-height.png', runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'preview-height-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const pointerEvents = shell && await shell.evaluate(() => window.__heightPointerEvents).catch(() => null);
  await writeFile(path.join(evidence, 'preview-height-result.json'), JSON.stringify({ passed: false, checks, error: error.stack, rendererErrors, pointerEvents }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'preview-height-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
