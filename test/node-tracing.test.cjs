'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { createTracing } = require('../adapters/tracing/node-http.cjs');
const { registerRoot } = require('../adapters/tracing/node-sqlite.cjs');

const temporaryRoot = path.resolve(__dirname, '../.tmp');
const sqliteAdapter = require.resolve('../adapters/tracing/node-sqlite.cjs');
const httpAdapter = require.resolve('../adapters/tracing/node-http.cjs');

function fixture(t, extra = []) {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'test-node-sdk-'));
  const filename = path.join(root, 'application.cjs');
  const code = `const http = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const {createTracing} = require(${JSON.stringify(httpAdapter)});
const {begin} = require(${JSON.stringify(sqliteAdapter)});
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER, label TEXT, bytes BLOB); INSERT INTO ledger VALUES (1, 1250, 'PRIVATE-ONE', X'010203'), (2, 2350, 'PRIVATE-TWO', X'040506')");
  return db;
}
exports.manual = function manual(requestId, sql = 'SELECT id, amount, label, bytes FROM ledger ORDER BY id') {
  const db = database();
  const trace = begin(__dirname, requestId);
  const result = trace.read(db, sql);
  return {db, trace, result};
};
exports.start = async function start(options = {}) {
  const db = database();
  const tracing = createTracing({repositoryRoot: __dirname, development: options.development !== false});
  const failures = [];
  async function actualRoute(request, response) {
    Object.defineProperty(request, 'body', {get() {throw Error('The tracing adapter inspected the request body');}});
    const address = new URL(request.url, 'http://localhost');
    const id = Number(address.searchParams.get('id') || 1);
    const early = address.pathname === '/early';
    if (early) response.writeHead(202, 'Accepted by application', {'Content-Type':'application/json', 'X-App-Value':'kept'});
    await new Promise(resolve => setTimeout(resolve, id === 1 ? 12 : 2));
    const helper = {'/helper':'./repository.cjs', '/bridge':'./bridge.cjs', '/hidden':'./.hidden/read.cjs', '/generated':'./dist/read.cjs'}[address.pathname];
    const result = helper
      ? require(helper).read(tracing, db, id)
      : tracing.read(db, 'SELECT amount, label FROM ledger WHERE id = ?', [id]);
    options.afterRead?.();
    await new Promise(resolve => setTimeout(resolve, id === 2 ? 12 : 2));
    if (address.pathname === '/mutated') result.rows[0].amount += 7;
    const payload = {entry:{amount:result.field(0, 'amount', 'entry.amount'), label:result.field(0, 'label', 'entry.label')}};
    if (['/large', '/oversized'].includes(address.pathname)) {
      payload.values = {};
      for (const name of options.fieldNames || Array.from({length:120}, (_, index) => 'field' + index)) payload.values[name] = result.field(0, 'amount', 'values.' + name);
    }
    if (!early) {response.statusCode = 201; response.setHeader('Content-Type','application/json'); response.setHeader('X-App-Value', 'kept');}
    if (['/large', '/oversized'].includes(address.pathname)) response.statusCode = 200;
    response.end(JSON.stringify(payload));
  }
  const invoke = options.middleware
    ? (request, response) => tracing.middleware(request, response, () => actualRoute(request, response))
    : tracing.handler(actualRoute);
  const server = http.createServer((request, response) => Promise.resolve(invoke(request, response)).catch(error => {failures.push(error); if (!response.headersSent) response.writeHead(500); response.end('application error');}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url:'http://127.0.0.1:' + server.address().port, failures, close:async() => {await new Promise(resolve => server.close(resolve));db.close();}};
};
`;
  fs.writeFileSync(filename, code);
  fs.writeFileSync(path.join(root, 'repository.cjs'), "exports.read = function read(tracing, db, id) {return tracing.read(db, 'SELECT amount, label FROM ledger WHERE id = ?', [id]);};\n");
  fs.writeFileSync(path.join(root, 'bridge.cjs'), "exports.read = function bridge(tracing, db, id) {return require('./repository.cjs').read(tracing, db, id);};\n");
  for (const [name, value] of extra) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  }
  const application = require(filename);
  t.after(() => {
    delete require.cache[filename];
    assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, filename, code, application };
}

function decode(value) { return JSON.parse((value.startsWith('z1.') ? inflateSync(Buffer.from(value.slice(3), 'base64')) : Buffer.from(value, 'base64')).toString('utf8')); }

async function proxy(t, target) {
  const server = http.createServer((incoming, outgoing) => {
    // Keep Node's default HTTP header limit: increasing it would conceal the bug.
    const upstream = http.request(new URL(incoming.url, target), { method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', error => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(error.code || error.message); });
    incoming.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function request(url, id, body = 'PRIVATE-REQUEST-BODY') {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method: 'POST', headers: { ...(id === undefined ? {} : { 'X-Studio-Trace': id }), 'Content-Type': 'text/plain' } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, message: incoming.statusMessage, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
}

test('Node HTTP captures a real request, SQLite field origin, and application source without reading bodies', async t => {
  const project = fixture(t);
  const server = await project.application.start(); t.after(() => server.close());
  const id = randomUUID(), response = await request(server.url + '/entry?id=2', id);
  assert.equal(response.status, 201); assert.equal(response.headers['x-app-value'], 'kept');
  assert.deepEqual(JSON.parse(response.body), { entry: { amount: 2350, label: 'PRIVATE-TWO' } });
  const trace = decode(response.headers['studio-trace']);
  assert.ok(Number.isFinite(trace.durationMs)&&trace.durationMs>=0);
  assert.ok(Number.isFinite(trace.queries[0].durationMs)&&trace.queries[0].durationMs>=0);
  assert.ok(trace.queries[0].startOffsetMs>=0&&trace.queries[0].startOffsetMs+trace.queries[0].durationMs<=trace.durationMs);
  assert.equal(trace.id, id); assert.equal(trace.route.path, 'application.cjs');
  assert.equal(trace.route.hash, createHash('sha256').update(project.code).digest('hex'));
  assert.equal(trace.queries.length, 1); assert.equal(trace.queries[0].site.path, 'application.cjs');
  assert.match(project.code.split('\n')[trace.queries[0].site.line - 1], /tracing\.read\(db/);
  assert.equal(trace.route.line, trace.queries[0].site.line);
  assert.deepEqual(trace.fields['entry.amount'], { table: 'ledger', column: 'amount', model: null, queries: [trace.queries[0].id] });
  assert.ok(!JSON.stringify(trace).includes('PRIVATE-'));
  assert.ok(trace.queries[0].frames.every(frame => frame.path === 'application.cjs'));
  assert.deepEqual(server.failures, []);
});

test('Express-compatible middleware isolates concurrent traced and untraced SQLite requests', async t => {
  const project = fixture(t);
  const server = await project.application.start({ middleware: true }); t.after(() => server.close());
  const ids = [randomUUID(), randomUUID()];
  const responses = await Promise.all([request(server.url + '/entry?id=1', ids[0]), request(server.url + '/entry?id=2', ids[1]), request(server.url + '/entry?id=1')]);
  for (let index = 0; index < 2; index++) {
    const trace = decode(responses[index].headers['studio-trace']);
    assert.equal(trace.id, ids[index]); assert.equal(trace.queries.length, 1);
    assert.equal(trace.fields['entry.amount'].queries[0], trace.queries[0].id);
    assert.equal(JSON.parse(responses[index].body).entry.amount, index === 0 ? 1250 : 2350);
  }
  assert.notEqual(decode(responses[0].headers['studio-trace']).queries[0].id, decode(responses[1].headers['studio-trace']).queries[0].id);
  assert.equal(responses[2].headers['studio-trace'], undefined);
  assert.equal(JSON.parse(responses[2].body).entry.amount, 1250);
  assert.deepEqual(server.failures, []);
});

test('disabled development and invalid trace IDs preserve read/field behavior and emit no trace header', async t => {
  const project = fixture(t);
  const development = await project.application.start(); t.after(() => development.close());
  const production = await project.application.start({ development: false }); t.after(() => production.close());
  for (const [url, id] of [[production.url, randomUUID()], [development.url, 'short'], [development.url, '../../secret'], [development.url, ['valid-id-one', 'valid-id-two']]]) {
    const response = await request(url, id);
    assert.equal(response.status, 201); assert.equal(response.headers['studio-trace'], undefined);
    assert.equal(JSON.parse(response.body).entry.amount, 1250);
  }
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const disabled = createTracing({ repositoryRoot: path.join(project.root, 'does-not-exist'), development: false });
  assert.equal(disabled.read(db, 'SELECT 17 AS value').field(0, 'value', 'value'), 17);
  assert.deepEqual(development.failures, []); assert.deepEqual(production.failures, []);
});

test('an early writeHead snapshot preserves status/headers and does not close later query capture', async t => {
  const project = fixture(t);
  const server = await project.application.start(); t.after(() => server.close());
  const response = await request(server.url + '/early', randomUUID());
  assert.equal(response.status, 202); assert.equal(response.message, 'Accepted by application');
  assert.equal(response.headers['x-app-value'], 'kept'); assert.equal(JSON.parse(response.body).entry.amount, 1250);
  const trace = decode(response.headers['studio-trace']);
  assert.equal(trace.route, null); assert.deepEqual(trace.queries, []); assert.deepEqual(trace.fields, {});
  assert.deepEqual(server.failures, []);
  const manual = project.application.manual(randomUUID()); t.after(() => manual.db.close());
  const snapshot = decode(manual.trace.header(false)); assert.equal(snapshot.queries.length, 1);
  assert.equal(manual.trace.read(manual.db, 'SELECT amount FROM ledger').field(0, 'amount', 'later.amount'), 1250);
  assert.equal(decode(manual.trace.header()).queries.length, 2);
  assert.throws(() => manual.trace.read(manual.db, 'SELECT 1'), /Trace closed/);
});

test('mutated, replaced, swapped, accessor, and duplicate-column result fields never publish false origins', t => {
  const project = fixture(t); registerRoot(project.root);
  for (const mutation of ['before', 'after', 'replace', 'swap', 'accessor', 'blob']) {
    const { db, trace, result } = project.application.manual(randomUUID()); t.after(() => db.close());
    if (mutation === 'after') assert.equal(result.field(0, 'amount', 'entry.amount'), 1250);
    if (mutation === 'before' || mutation === 'after') result.rows[0].amount += 7;
    if (mutation === 'replace') result.rows[0] = { ...result.rows[0] };
    if (mutation === 'swap') result.rows.reverse();
    if (mutation === 'accessor') Object.defineProperty(result.rows[0], 'amount', { get: () => 1250 });
    if (mutation === 'blob') { result.field(0, 'bytes', 'entry.bytes'); result.rows[0].bytes[0] = 99; }
    else result.field(0, 'amount', 'entry.amount');
    const traceData = decode(trace.header());
    assert.equal(traceData.fields['entry.amount'], undefined, mutation);
    assert.equal(traceData.fields['entry.bytes'], undefined, mutation);
  }
  const duplicate = project.application.manual(randomUUID(), 'SELECT amount AS same, id AS same FROM ledger'); t.after(() => duplicate.db.close());
  duplicate.result.field(0, 'same', 'entry.same');
  assert.deepEqual(decode(duplicate.trace.header()).fields, {});
});

test('field metadata is capped, unsafe paths excluded, and query failures retain the original SQLite error', t => {
  const project = fixture(t); registerRoot(project.root);
  const { db, trace, result } = project.application.manual(randomUUID()); t.after(() => db.close());
  for (let index = 0; index < 201; index++) result.field(0, 'amount', 'entry.value' + index);
  for (const unsafe of ['__proto__', 'entry.constructor.value', 'entry..amount', '', 'x'.repeat(201)]) result.field(0, 'amount', unsafe);
  const snapshot = decode(trace.header(false));
  assert.equal(Object.keys(snapshot.fields).length, 200); assert.equal(snapshot.truncated, true);
  assert.equal(Object.hasOwn(snapshot.fields, '__proto__'), false);
  assert.throws(() => trace.read(db, 'SELECT missing_column FROM ledger'), /no such column/);
  const failed = decode(trace.header());
  assert.equal(failed.queries.at(-1).failed, true);
});

test('startup source hashes exclude dependency/generated/hidden files and invalidate stale cached code', t => {
  const project = fixture(t, [['node_modules/dependency/index.js', 'module.exports = 1;'], ['dist/generated.js', 'module.exports = 1;'], ['.hidden/private.cjs', 'module.exports = 1;'], ['secrets.cjs', 'module.exports = 1;'], ['oversized.js', ' '.repeat(262145)]]);
  assert.equal(registerRoot(project.root).files, 3);
  const original = project.application.manual(randomUUID()); t.after(() => original.db.close());
  original.result.field(0, 'amount', 'entry.amount');
  fs.appendFileSync(project.filename, '\n// Changed on disk after startup; the running module still holds old code.\n');
  const emitted = decode(original.trace.header());
  assert.equal(emitted.route, null); assert.equal(emitted.queries[0].site, null); assert.deepEqual(emitted.queries[0].frames, []); assert.deepEqual(emitted.fields, {});
  const later = project.application.manual(randomUUID()); t.after(() => later.db.close());
  later.result.field(0, 'amount', 'entry.amount');
  const stale = decode(later.trace.header());
  assert.equal(stale.route, null); assert.equal(stale.queries[0].site, null); assert.deepEqual(stale.fields, {});
  assert.equal(registerRoot(project.root).files, 3, 'Registration must not silently refresh hashes in a running process');
});

test('a stale loaded helper cannot be replaced by its fresh HTTP route as query evidence', async t => {
  const project = fixture(t);
  const server = await project.application.start(); t.after(() => server.close());
  const first = await request(server.url + '/helper', randomUUID());
  const before = decode(first.headers['studio-trace']);
  assert.equal(before.queries[0].site.path, 'repository.cjs');
  assert.equal(before.fields['entry.amount'].column, 'amount');
  fs.appendFileSync(path.join(project.root, 'repository.cjs'), '// File changed while its original module remains cached.\n');
  const second = await request(server.url + '/helper', randomUUID());
  assert.equal(second.status, 201); assert.equal(JSON.parse(second.body).entry.amount, 1250);
  const after = decode(second.headers['studio-trace']);
  assert.equal(after.route, null); assert.equal(after.queries[0].site, null); assert.deepEqual(after.queries[0].frames, []); assert.deepEqual(after.fields, {});
  assert.deepEqual(server.failures, []);
});

test('source-root registrations have a fixed process budget', t => {
  const project = fixture(t);
  const roots = [];
  for (let index = 0; index < 17; index++) { const root = path.join(project.root, 'root-' + index); fs.mkdirSync(root); roots.push(root); }
  const { spawnSync } = require('node:child_process');
  const script = `const assert=require('node:assert/strict');const {registerRoot}=require(${JSON.stringify(sqliteAdapter)});const roots=${JSON.stringify(roots)};for(const root of roots.slice(0,16))registerRoot(root);assert.throws(()=>registerRoot(roots[16]),/source-root limit/);assert.equal(registerRoot(roots[0]).files,0);`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('changing an intermediate helper after execution invalidates the serialized query chain', async t => {
  const project = fixture(t);
  const server = await project.application.start({ afterRead() { fs.appendFileSync(path.join(project.root, 'bridge.cjs'), '// Edited after SQL execution.\n'); } });
  t.after(() => server.close());
  const response = await request(server.url + '/bridge', randomUUID());
  assert.equal(response.status, 201); assert.equal(JSON.parse(response.body).entry.amount, 1250);
  const trace = decode(response.headers['studio-trace']);
  assert.equal(trace.queries[0].site, null); assert.deepEqual(trace.queries[0].frames, []); assert.deepEqual(trace.fields, {});
  assert.deepEqual(server.failures, []);
});

test('hidden and generated query helpers cannot promote their fresh outer route into query evidence', async t => {
  const helper = "exports.read = function hiddenRead(tracing, db, id) {return tracing.read(db, 'SELECT amount, label FROM ledger WHERE id = ?', [id]);};\n";
  const project = fixture(t, [['.hidden/read.cjs', helper], ['dist/read.cjs', helper]]);
  require(path.join(project.root, '.hidden/read.cjs')); require(path.join(project.root, 'dist/read.cjs'));
  const server = await project.application.start(); t.after(() => server.close());
  for (const pathname of ['/hidden', '/generated']) {
    const response = await request(server.url + pathname, randomUUID());
    assert.equal(response.status, 201); assert.equal(JSON.parse(response.body).entry.amount, 1250);
    const trace = decode(response.headers['studio-trace']);
    assert.equal(trace.route, null, pathname); assert.equal(trace.queries[0].site, null, pathname);
    assert.deepEqual(trace.queries[0].frames, [], pathname); assert.deepEqual(trace.fields, {}, pathname);
  }
  assert.deepEqual(server.failures, []);
});

test('compressed large traces survive a default Node HTTP proxy with full field origins and unchanged body', async t => {
  const project = fixture(t);
  const traced = await project.application.start(); t.after(() => traced.close());
  const ordinary = await project.application.start({ development: false }); t.after(() => ordinary.close());
  const viaProxy = await proxy(t, traced.url), id = randomUUID();
  const [captured, baseline] = await Promise.all([request(viaProxy + '/large', id), request(ordinary.url + '/large', id)]);
  assert.equal(captured.status, 200, captured.body); assert.equal(captured.body, baseline.body);
  const header = captured.headers['studio-trace'];
  assert.ok(header.startsWith('z1.')); assert.ok(Buffer.byteLength(header) <= 6144);
  const trace = decode(header);
  assert.ok(Buffer.byteLength(Buffer.from(JSON.stringify(trace)).toString('base64')) > http.maxHeaderSize, 'The old uncompressed trace must exceed Node default response-header capacity');
  assert.equal(trace.id, id); assert.equal(trace.truncated, false); assert.equal(trace.queries.length, 1);
  assert.equal(Object.keys(trace.fields).length, 122);
  assert.equal(trace.fields['values.field119'].column, 'amount');
  assert.equal(JSON.parse(captured.body).values.field119, 1250);
  assert.deepEqual(traced.failures, []);
});

test('incompressible trace metadata falls back below proxy limits without changing the application response', async t => {
  const project = fixture(t), fieldNames = Array.from({ length: 190 }, () => randomBytes(90).toString('hex'));
  const traced = await project.application.start({ fieldNames }); t.after(() => traced.close());
  const ordinary = await project.application.start({ fieldNames, development: false }); t.after(() => ordinary.close());
  const viaProxy = await proxy(t, traced.url), id = randomUUID();
  const [captured, baseline] = await Promise.all([request(viaProxy + '/oversized', id), request(ordinary.url + '/oversized', id)]);
  assert.equal(captured.status, 200, captured.body); assert.equal(captured.body, baseline.body);
  const header = captured.headers['studio-trace']; assert.ok(Buffer.byteLength(header) <= 6144);
  const trace = decode(header); assert.equal(trace.id, id); assert.equal(trace.truncated, true);
  assert.deepEqual(trace.queries, []); assert.deepEqual(trace.fields, {}); assert.equal(trace.route.path, 'application.cjs');
  assert.deepEqual(traced.failures, []);
});
