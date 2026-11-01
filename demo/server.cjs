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
  for (const key of ['name', 'price', 'rating', 'cart', 'static']) {
    const line = code.split('\n').findIndex(text => text.includes(`// trace:${key}`)) + 1;
    sources[key] = { path: 'app.mjs', line, hash, expression: { name: 'product.name', price: 'formatMoney(product.price)', rating: 'product.rating', cart: 'addToCart(product.id)', static: 'Storefront footer text' }[key], kind: key === 'cart' ? 'event-handler' : 'render' };
  }
  return sources;
}

async function startDemo() {
  const database = new DatabaseSync(':memory:');
  const sockets = new Set();
  let closePromise;
  database.exec(fs.readFileSync(path.join(demoRoot, 'catalog.sql'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const respond = (code, type, body, headers = {}) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(body);
    };
    try {
      if (url.pathname === '/api/catalog' && req.method === 'GET') {
        const trace = begin(demoRoot, req.headers['x-studio-trace']);
        const result = trace.read(database, catalogQuery);
        const products = result.rows.map((row, index) => ({
          id: result.field(index, 'id', `products.${index}.id`),
          name: result.field(index, 'name', `products.${index}.name`),
          subtitle: result.field(index, 'subtitle', `products.${index}.subtitle`),
          price: result.field(index, 'price', `products.${index}.price`),
          rating: result.field(index, 'rating', `products.${index}.rating`),
          finish: result.field(index, 'finish', `products.${index}.finish`),
        }));
        return respond(200, 'application/json', JSON.stringify({ products }), { 'Studio-Trace': trace.header() });
      }
      if (url.pathname === '/api/cart' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) return respond(413, 'application/json', '{}'); }
        const { productId } = JSON.parse(body);
        if (!['orbit', 'arc', 'halo'].includes(productId)) return respond(400, 'application/json', '{"error":"Unknown product"}');
        const trace = begin(demoRoot, req.headers['x-studio-trace']);
        const result = trace.read(database, 'INSERT INTO cart_items(product_id, quantity) VALUES (?, 1) ON CONFLICT(product_id) DO UPDATE SET quantity = quantity + 1 RETURNING product_id, quantity', [productId]);
        const cart = { productId: result.field(0, 'product_id', 'cart.productId'), quantity: result.field(0, 'quantity', 'cart.quantity') };
        return respond(200, 'application/json', JSON.stringify({ cart }), { 'Studio-Trace': trace.header() });
      }
      if (url.pathname === '/trace/sources.json') return respond(200, 'application/json', JSON.stringify(sourceMetadata()));
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.mjs': ['app.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/trace/browser.mjs': ['../adapters/tracing/browser.mjs', 'text/javascript'], '/trace/trace-codec.mjs': ['../adapters/tracing/trace-codec.mjs', 'text/javascript'] };
      const file = files[url.pathname];
      if (!file || req.method !== 'GET') return respond(404, 'text/plain', 'Not found');
      return respond(200, file[1], fs.readFileSync(path.join(demoRoot, file[0])), url.pathname === '/' ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } : {});
    } catch (error) { respond(500, 'application/json', JSON.stringify({ error: error.message })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(deadline); database.close(); resolve(); };
      const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); finish(); }, 500);
      server.close(finish);
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
  return { url: `http://127.0.0.1:${server.address().port}`, root: demoRoot, close };
}
module.exports = { startDemo, sourceMetadata };
if (require.main === module) startDemo().then(({ url }) => console.log(url));
