'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { begin } = require('../adapters/tracing/node-sqlite.cjs');
const demoRoot = __dirname;
const catalogQuery = 'SELECT id, name, subtitle, price, rating, finish FROM products ORDER BY rowid';
function sourceMetadata() {
  const code = fs.readFileSync(path.join(demoRoot, 'app.mjs'), 'utf8');
  const hash = createHash('sha256').update(code).digest('hex');
  const sources = {};
  for (const key of ['name', 'price']) { const line = code.split('\n').findIndex(text => text.includes(`// trace:${key}`)) + 1; sources[key] = { path: 'app.mjs', line, hash, expression: key === 'price' ? 'formatMoney(product.price)' : 'product.name', kind: 'render' }; }
  return sources;
}
async function startBrokenDemo() {
  const database = new DatabaseSync(':memory:'), sockets = new Set(); let closePromise;
  database.exec(fs.readFileSync(path.join(__dirname, '..', 'demo', 'catalog.sql'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const respond = (code, type, body, headers = {}) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(body); } };
    try {
      if (url.pathname === '/api/catalog' && req.method === 'GET') {
        const trace = begin(demoRoot, req.headers['x-studio-trace']); const result = trace.read(database, catalogQuery);
        const products = result.rows.map((row, index) => { const price = result.field(index, 'price', `products.${index}.price`); return { id: result.field(index, 'id', `products.${index}.id`), name: result.field(index, 'name', `products.${index}.name`), subtitle: result.field(index, 'subtitle', `products.${index}.subtitle`), price: row.id === 'orbit' ? price * 100 : price, rating: result.field(index, 'rating', `products.${index}.rating`), finish: result.field(index, 'finish', `products.${index}.finish`) }; });
        return respond(200, 'application/json', JSON.stringify({ products }), { 'Studio-Trace': trace.header() });
      }
      if (url.pathname === '/trace/sources.json') return respond(200, 'application/json', JSON.stringify(sourceMetadata()));
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.mjs': ['app.mjs', 'text/javascript'], '/style.css': ['../demo/style.css', 'text/css'], '/trace/browser.mjs': ['../adapters/tracing/browser.mjs', 'text/javascript'], '/trace/trace-codec.mjs': ['../adapters/tracing/trace-codec.mjs', 'text/javascript'] };
      const file = files[url.pathname]; if (!file || req.method !== 'GET') return respond(404, 'text/plain', 'Not found');
      return respond(200, file[1], fs.readFileSync(path.join(demoRoot, file[0])), url.pathname === '/' ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } : {});
    } catch (error) { respond(500, 'application/json', JSON.stringify({ error: error.message })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = () => closePromise ||= new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; clearTimeout(deadline); database.close(); resolve(); } }; const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); finish(); }, 500); server.close(finish); server.closeIdleConnections(); server.closeAllConnections(); for (const socket of sockets) socket.destroy(); });
  return { url: `http://127.0.0.1:${server.address().port}`, root: demoRoot, close };
}
module.exports = { startBrokenDemo, sourceMetadata };
