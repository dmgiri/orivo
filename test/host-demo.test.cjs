'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const net = require('node:net');
const {inflateSync}=require('node:zlib');
const { startDemo, sourceMetadata } = require('../demo/server.cjs');
const { startBrokenDemo, sourceMetadata: brokenSourceMetadata } = require('../demo-broken/server.cjs');
const decode=header=>JSON.parse((header.startsWith('z1.')?inflateSync(Buffer.from(header.slice(3),'base64'),{maxOutputLength:300000}):Buffer.from(header,'base64')).toString());

test('live demo returns executed SQLite column lineage with matching source hashes', async t => {
  const demo = await startDemo(); t.after(() => demo.close());
  const id = randomUUID();
  const response = await fetch(demo.url + '/api/catalog', { headers: { 'X-Studio-Trace': id } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const trace = decode(response.headers.get('Studio-Trace'));
  assert.equal(body.products[0].price, 129);
  assert.equal(trace.id, id);
  assert.equal(trace.fields['products.0.price'].table, 'products');
  assert.equal(trace.fields['products.0.price'].column, 'price');
  assert.match(trace.queries[0].sql, /^SELECT .* FROM products/);
  assert.equal(trace.route.path, 'server.cjs');
  assert.equal(trace.route.hash, createHash('sha256').update(fs.readFileSync(path.join(demo.root, 'server.cjs'))).digest('hex'));
  const metadata = sourceMetadata();
  assert.equal(metadata.price.hash, createHash('sha256').update(fs.readFileSync(path.join(demo.root, 'app.mjs'))).digest('hex'));
  assert.match(fs.readFileSync(path.join(demo.root, 'app.mjs'), 'utf8').split('\n')[metadata.price.line - 1], /trace:price/);
});
test('broken demo exposes the bad price while preserving its captured column lineage', async t => {
  const demo = await startBrokenDemo(); t.after(() => demo.close());
  const id = randomUUID();
  const response = await fetch(demo.url + '/api/catalog', { headers: { 'X-Studio-Trace': id } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const trace = decode(response.headers.get('Studio-Trace'));
  assert.equal(body.products[0].price, 12900);
  assert.equal(body.products[1].price, 89);
  assert.equal(trace.id, id);
  assert.equal(trace.fields['products.0.price'].table, 'products');
  assert.equal(trace.fields['products.0.price'].column, 'price');
  const metadata = brokenSourceMetadata();
  assert.match(fs.readFileSync(path.join(demo.root, 'app.mjs'), 'utf8').split('\n')[metadata.price.line - 1], /trace:price/);
  const bad = await fetch(demo.url + '/api/catalog', { headers: { 'X-Studio-Trace': '../../secret' } });
  assert.equal(bad.status, 500);
  assert.equal((await fetch(demo.url + '/server.cjs')).status, 404);
});
test('cart action performs a real mutation and preserves parameterized query evidence', async t => {
  const demo = await startDemo(); t.after(() => demo.close());
  for (const quantity of [1, 2]) {
    const response = await fetch(demo.url + '/api/cart', { method: 'POST', headers: { 'X-Studio-Trace': randomUUID(), 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'orbit' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cart.quantity, quantity);
    const trace = decode(response.headers.get('Studio-Trace'));
    assert.equal(trace.fields['cart.quantity'].table, 'cart_items');
    assert.equal(trace.fields['cart.quantity'].column, 'quantity');
    assert.match(trace.queries[0].sql, /^INSERT INTO cart_items/);
    assert.doesNotMatch(trace.queries[0].sql, /orbit/);
  }
});
test('demo serves a bounded static allowlist and blocks malformed trace IDs', async t => {
  const demo = await startDemo(); t.after(() => demo.close());
  assert.equal((await fetch(demo.url + '/trace/browser.mjs')).status, 200);
  assert.equal((await fetch(demo.url + '/server.cjs')).status, 404);
  assert.equal((await fetch(demo.url + '/trace/../server.cjs')).status, 404);
  const bad = await fetch(demo.url + '/api/catalog', { headers: { 'X-Studio-Trace': '../../secret' } });
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /trace ID/);
});
test('demo shutdown closes an unfinished request promptly and is idempotent', async t => {
  const demo = await startDemo();
  const address = new URL(demo.url);
  const socket = net.createConnection({ host: address.hostname, port: Number(address.port) });
  socket.on('error', () => {});
  t.after(() => { socket.destroy(); return demo.close(); });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('POST /api/cart HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: keep-alive\r\n\r\n{"productId":');
  const started = performance.now();
  const closing = demo.close();
  assert.equal(demo.close(), closing);
  let deadline;
  await Promise.race([closing, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Demo shutdown waited for an unfinished client request.')), 1200); })]).finally(() => clearTimeout(deadline));
  assert.ok(performance.now() - started < 1000, 'server shutdown is bounded');
  await assert.rejects(fetch(demo.url));
});
test('desktop exposes a dedicated broken-demo command', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
  assert.match(host, /startBrokenDemo/);
  assert.match(host, /open-broken-demo/);
  assert.match(bridge, /openBrokenDemo: \(\) => invoke\('open-broken-demo'\)/);
});
test('investigation UI and documentation describe the broken price scenario', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DEMO.md'), 'utf8');
  assert.match(html, /Investigate a broken price/);
  assert.match(app, /openBrokenDemo/);
  assert.match(guide, /\$12,900/);
  assert.match(guide, /does not diagnose/i);
});
