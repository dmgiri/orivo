import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, 'evidence', 'graph-zoom');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `graph-zoom-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ORIVO_START_MODE;
const checks = [];
const rendererErrors = [];
let app;
let shell;

async function geometry() {
  return shell.evaluate(() => {
    const rect = element => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const graph = document.querySelector('#trace-graph');
    const canvas = document.querySelector('#graph-canvas');
    const controls = [...document.querySelectorAll('#zoom-in,#zoom-out,#zoom-fit,#zoom-value')];
    return {
      canvas: rect(canvas),
      graph: rect(graph),
      cards: [...graph.querySelectorAll('.node-card')].map(rect),
      controls: controls.map(element => ({ id: element.id, tag: element.tagName, inside: canvas.contains(element), rect: rect(element), visible: element.checkVisibility() })),
      selected: document.querySelector('.graph-node.selected')?.dataset.node,
      zoom: document.querySelector('#zoom-value').textContent,
      viewBox: graph.getAttribute('viewBox'),
      overflow: document.documentElement.scrollWidth > innerWidth,
      viewport: { width: innerWidth, height: innerHeight }
    };
  });
}

async function controlsVisible() {
  const state = await geometry();
  assert.equal(state.overflow, false, 'Graph navigation must not create desktop page overflow');
  for (const control of state.controls) {
    assert.equal(control.inside, true, `${control.id} must be inside the canvas`);
    assert.equal(control.visible, true, `${control.id} must be visible`);
    assert.ok(control.rect.width >= 26 && control.rect.height >= 26, `${control.id} must be a usable desktop target`);
    assert.ok(control.rect.x >= state.canvas.x - 1 && control.rect.right <= state.canvas.right + 1, `${control.id} must stay within the canvas horizontally`);
    assert.ok(control.rect.y >= state.canvas.y - 1 && control.rect.bottom <= state.canvas.bottom + 1, `${control.id} must stay within the canvas vertically`);
    assert.ok(control.rect.x >= 0 && control.rect.y >= 0 && control.rect.right <= state.viewport.width && control.rect.bottom <= state.viewport.height, `${control.id} must be reachable without scrolling`);
  }
  assert.equal(state.controls.find(control => control.id === 'zoom-value').tag, 'BUTTON', 'The percentage must reset to 100% when clicked');
  return state;
}

async function fitAllNodes() {
  await shell.locator('#zoom-fit').click();
  await shell.waitForFunction(() => document.querySelector('#zoom-value').textContent.trim() === '100%');
  const state = await geometry();
  for (const card of state.cards) {
    assert.ok(card.x >= state.canvas.x - 1 && card.right <= state.canvas.right + 1, 'Fit must bring every node inside the canvas horizontally');
    assert.ok(card.y >= state.canvas.y - 1 && card.bottom <= state.canvas.bottom + 1, 'Fit must bring every node inside the canvas vertically');
  }
  return state;
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
  shell = await app.firstWindow();
  shell.setDefaultTimeout(15000);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.locator('#coverage-badge').filter({ hasText: 'Element to column captured' }).waitFor();
  await shell.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMaximized()) window.unmaximize();
    window.setSize(1580, 980);
  });
  await shell.waitForFunction(() => innerWidth > 1300);
  const initial = await fitAllNodes();
  await controlsVisible();
  assert.ok(initial.cards.length >= 6, 'The test must use an actual full stack trace');
  await shell.locator('#zoom-in').click();
  let state = await geometry();
  assert.ok(state.cards[0].width > initial.cards[0].width, 'Zoom in must enlarge actual node graphics');
  assert.equal(state.graph.width, initial.graph.width, 'Zoom must keep the SVG viewport width fixed');
  assert.equal(state.graph.height, initial.graph.height, 'Zoom must keep the SVG viewport height fixed');
  await shell.locator('#zoom-out').click();
  const zoomedOut = await geometry();
  assert.ok(zoomedOut.cards[0].width < state.cards[0].width, 'Zoom out must shrink actual node graphics');
  await shell.locator('#zoom-in').click();
  await shell.locator('#zoom-value').click();
  assert.equal((await geometry()).zoom.trim(), '100%');
  checks.push('Visible canvas controls enlarge and shrink nodes, preserve a fixed viewport, and reset with the percentage button');

  for (let step = 0; step < 11; step++) await shell.locator('#zoom-in').click();
  const maximum = await controlsVisible();
  assert.equal(maximum.zoom.trim(), '1000%', 'Zoom in must reach the 1000% maximum');
  assert.ok(Math.abs(maximum.cards[0].width / initial.cards[0].width - 10) < .02, 'The maximum must enlarge actual graph graphics tenfold');
  assert.equal(await shell.locator('#zoom-in').isDisabled(), true, 'Zoom in must disable at 1000%');
  await shell.locator('#graph-canvas').focus();
  await shell.keyboard.press('Shift+Equal');
  await shell.mouse.move(maximum.canvas.x + maximum.canvas.width / 2, maximum.canvas.y + maximum.canvas.height / 2);
  await shell.mouse.wheel(0, -600);
  await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await geometry()).zoom.trim(), '1000%', 'Keyboard and wheel input must respect the maximum');
  await shell.locator('#zoom-out').click();
  assert.equal((await geometry()).zoom.trim(), '800%');
  assert.equal(await shell.locator('#zoom-in').isEnabled(), true);
  await fitAllNodes();
  checks.push('The graph reaches 1000%, keeps controls reachable, clamps keyboard and wheel input, and zooms out or resets normally');

  const anchor = await shell.evaluate(() => {
    const graph = document.querySelector('#trace-graph');
    const rect = document.querySelector('#graph-canvas').getBoundingClientRect();
    const screen = { x: rect.x + rect.width * .68, y: rect.y + rect.height * .31 };
    const world = new DOMPoint(screen.x, screen.y).matrixTransform(graph.getScreenCTM().inverse());
    return { screen, world: { x: world.x, y: world.y } };
  });
  await shell.mouse.move(anchor.screen.x, anchor.screen.y);
  await shell.mouse.wheel(0, -180);
  await shell.waitForFunction(width => document.querySelector('.node-card').getBoundingClientRect().width > width, initial.cards[0].width);
  const anchored = await shell.evaluate(world => {
    const point = new DOMPoint(world.x, world.y).matrixTransform(document.querySelector('#trace-graph').getScreenCTM());
    return { x: point.x, y: point.y };
  }, anchor.world);
  assert.ok(Math.abs(anchored.x - anchor.screen.x) <= 2 && Math.abs(anchored.y - anchor.screen.y) <= 2, 'Wheel zoom must keep the graph point under the cursor');
  checks.push('Ordinary mouse wheel zoom preserves the graph point under the cursor');

  await fitAllNodes();
  const beforePan = await geometry();
  const first = beforePan.cards[0];
  const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  await shell.mouse.move(start.x, start.y);
  await shell.mouse.down();
  await shell.mouse.move(start.x + 73, start.y + 37, { steps: 5 });
  await shell.mouse.up();
  state = await geometry();
  assert.ok(Math.abs(state.cards[0].x - first.x - 73) <= 2 && Math.abs(state.cards[0].y - first.y - 37) <= 2, 'Dragging must pan by the pointer distance');
  assert.equal(state.selected, beforePan.selected, 'A drag beginning on a node must not select that node');
  const fitted = await fitAllNodes();
  assert.ok(Math.abs(fitted.cards[0].x - first.x) <= 1 && Math.abs(fitted.cards[0].y - first.y) <= 1, 'Fit must reset panning');
  await shell.locator('.graph-node[data-node^="query-"]').click();
  assert.match(await shell.locator('#code-content').textContent(), /SELECT/i, 'A normal click must still open the executed query');
  assert.equal(await shell.locator('#code-language').textContent(), 'SQL');
  checks.push('Dragging on a node pans without accidental selection; Fit resets the camera and a normal click still opens real SQL');

  await shell.locator('#graph-canvas').focus();
  await shell.keyboard.press('Shift+Equal');
  assert.ok((await geometry()).cards[0].width > fitted.cards[0].width, 'The focused canvas must support +');
  await shell.keyboard.press('-');
  await shell.keyboard.press('=');
  await shell.keyboard.press('0');
  assert.equal((await geometry()).zoom.trim(), '100%', '0 must fit the graph');
  await shell.locator('#zoom-in').focus();
  await shell.keyboard.press('Shift+Equal');
  assert.ok((await geometry()).cards[0].width > fitted.cards[0].width, 'Canvas controls must support zoom keyboard shortcuts too');
  await shell.keyboard.press('0');
  checks.push('Canvas and control keyboard focus support +, =, − and 0 without using app-wide zoom');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
  await shell.waitForFunction(() => innerWidth < 1200);
  await fitAllNodes();
  await controlsVisible();
  await shell.locator('#sidebar-sash').press('End');
  await fitAllNodes();
  await controlsVisible();
  await shell.locator('#zoom-in').click();
  await controlsVisible();
  await shell.screenshot({ path: path.join(evidence, 'minimum-desktop-zoom.png') });
  checks.push('At the 1100 × 700 desktop minimum and maximum explorer width, controls stay inside the visible canvas without page overflow');

  await shell.locator('#sidebar-sash').press('Home');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1580, 980));
  await shell.waitForFunction(() => innerWidth > 1300);
  await fitAllNodes();
  await shell.locator('#zoom-in').click();
  await shell.screenshot({ path: path.join(evidence, 'wide-desktop-zoom.png') });
  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, checks, rendererErrors, runAt: new Date().toISOString() };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, error: error.stack, checks, rendererErrors }, null, 2));
  if (shell) await shell.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
