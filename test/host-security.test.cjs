'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { appUrl, relativePath, within, rescanRepository, previewBounds, selection } = require('../host-security.cjs');

test('application URLs accept loopback development and remote HTTPS', () => {
  assert.equal(appUrl(' http://localhost:5173/shop '), 'http://localhost:5173/shop');
  assert.equal(appUrl('http://127.1:8000'), 'http://127.0.0.1:8000/');
  assert.equal(appUrl('http://[::1]:8000'), 'http://[::1]:8000/');
  assert.equal(appUrl('https://example.com/app'), 'https://example.com/app');
});
test('application URLs reject local files, executable protocols, credentials and remote HTTP', () => {
  for (const value of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com', 'https://name:password@example.com', 'http://example.com', 'example.com', {}, null]) assert.throws(() => appUrl(value));
});
test('source path validation rejects traversal and Windows absolute paths', () => {
  assert.equal(relativePath('src\\components\\Price.tsx'), 'src/components/Price.tsx');
  for (const value of ['../secret', 'src/../../secret', 'src/./file', '/etc/passwd', 'C:\\secret.txt', 'C:secret.txt', '\\\\server\\share', 'src//file', 'x\0y']) assert.throws(() => relativePath(value));
  const root = path.resolve('fixture-root');
  assert.equal(within(root, path.join(root, 'src', 'app.js')), true);
  assert.equal(within(root, path.resolve('fixture-root-sibling', 'app.js')), false);
  assert.equal(within(root, root), false);
});
test('native preview bounds clamp to viewport and cannot overflow trusted interface', () => {
  assert.deepEqual(previewBounds({ x: -50, y: -10, width: 100, height: 30, visible: true }, { width: 400, height: 300 }), { x: 0, y: 0, width: 50, height: 20, visible: true });
  assert.deepEqual(previewBounds({ x: 390, y: 290, width: 200, height: 200, visible: true }, { width: 400, height: 300 }), { x: 390, y: 290, width: 10, height: 10, visible: true });
  for (const number of [NaN, Infinity, 100000]) assert.throws(() => previewBounds({ x: number, y: 0, width: 20, height: 20 }, { width: 400, height: 300 }));
});
test('picker messages are bounded and retain only inert selection properties', () => {
  assert.deepEqual(selection({ selector: '#price', label: '129', tag: 'span', arbitrary: 'discard' }), { selector: '#price', label: '129', tag: 'span' });
  assert.deepEqual(selection({ cancelled: true }), { cancelled: true });
  assert.throws(() => selection({ selector: 'x'.repeat(2001) }));
  assert.throws(() => selection({ selector: '' }));
});
test('source refresh reindexes the authorized root and rejects a different resulting root', async t => {
  const parent = path.resolve(__dirname, '..', '.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, 'rescan-test-'));
  t.after(() => { if (path.dirname(fixture) === parent && path.basename(fixture).startsWith('rescan-test-')) fs.rmSync(fixture, { recursive: true, force: true }); });
  const authorizedRoot = fs.realpathSync(fixture);
  const { indexRepository } = require('../engine/index.cjs');
  fs.writeFileSync(path.join(authorizedRoot, 'price.js'), 'export const price = 129;\n');
  const before = await rescanRepository(authorizedRoot, indexRepository);
  fs.writeFileSync(path.join(authorizedRoot, 'price.js'), 'export const price = 149;\n');
  const after = await rescanRepository(authorizedRoot, indexRepository);
  assert.equal(after.root, authorizedRoot);
  assert.notEqual(before.files[0].hash, after.files[0].hash);
  assert.match(after.files[0].text, /149/);
  await assert.rejects(rescanRepository(authorizedRoot, async () => ({ root: path.dirname(authorizedRoot), files: [] })), /changed during refresh/);
  await assert.rejects(rescanRepository('../another-root', indexRepository), /Connect a source folder/);
});
