'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createTraceStore, validateGraph, importEvidence, compareGraphs, MAX_TRACE_BYTES, MAX_SNAPSHOTS } = require('../trace-store.cjs');
const { verifiedEditorTarget } = require('../editor-source.cjs');
const { traceHealth, restartManagedSession } = require('../trace-health.cjs');
function graph() {
  return { id: 'trace-original', title: 'Invoice total', url: 'http://127.0.0.1:5000/invoices', selector: '#total', capturedAt: '2026-01-01T00:00:00.000Z', captured: true, mode: 'data', coverage: 'complete', gaps: [], files: ['src/Invoice.tsx'], summary: { requests: 1, queries: 3, tables: 1 }, nodes: [{ id: 'element-1', kind: 'element', label: 'Invoice total', subtitle: '#total', detail: 'DOM selection', status: 'captured', meta: { selector: '#total' } }, { id: 'source-2', kind: 'source', label: 'Invoice.tsx', subtitle: 'src/Invoice.tsx:2', detail: 'Frontend', file: 'src/Invoice.tsx', line: 2, code: 'total', meta: { sourceRole: 'frontend', sourceHash: 'a'.repeat(64) } }, { id: 'query-3', kind: 'query', label: 'SQL execution', subtitle: 'SQL', detail: 'Executed', code: 'SELECT total FROM invoices', meta: { executionCount: 3, requestId: 'r1', queryIds: ['q1', 'q2', 'q3'] } }], edges: [{ id: 'edge-1', from: 'element-1', to: 'source-2', label: 'rendered by' }, { id: 'edge-2', from: 'source-2', to: 'query-3', label: 'executes' }] };
}
async function fixture(t) {
  const parent = path.resolve(__dirname, '..', '.tmp'); await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'trace-product-'));
  t.after(async () => { if (path.dirname(folder) === parent && path.basename(folder).startsWith('trace-product-')) await fs.rm(folder, { recursive: true, force: true }); });
  return fs.realpath(folder);
}
test('pinned traces persist as independent read-only copies and serialized writes retain both captures', async t => {
  const directory = await fixture(t), store = createTraceStore(directory), capture = graph();
  const [one, two] = await Promise.all([store.save(capture, { name: 'Before', repositoryName: 'clinic' }), store.save(capture, { name: 'After', repositoryName: 'clinic' })]);
  capture.nodes[0].label = 'changed outside store';
  const reopened = createTraceStore(directory);
  assert.equal((await reopened.list()).snapshots.length, 2);
  const saved = await reopened.open(one.id); assert.equal(saved.nodes[0].label, 'Invoice total'); assert.equal(saved.snapshot.readOnly, true);
  saved.nodes[0].label = 'changed returned object'; assert.equal((await reopened.open(one.id)).nodes[0].label, 'Invoice total');
  assert.equal((await reopened.compare(one.id, two.id)).unchanged, true);
  assert.equal((await reopened.remove(one.id)).snapshots.length, 1); await assert.rejects(reopened.open(one.id), /no longer saved/);
  await assert.rejects(reopened.open('../../any-file'), /Choose a saved trace/);
});
test('imports accept only bounded inert evidence exports and never write source paths', async t => {
  const directory = await fixture(t), file = path.join(directory, 'export.json'), capture = graph();
  await fs.writeFile(file, JSON.stringify({ format: 'trace-atlas-evidence', version: 1, graph: capture }));
  assert.deepEqual(await importEvidence(file), capture);
  assert.deepEqual(await fs.readdir(directory), ['export.json']);
  await fs.writeFile(file, JSON.stringify({ format: 'unknown', version: 1, graph: capture })); await assert.rejects(importEvidence(file), /Orivo evidence/);
  await fs.writeFile(file, ' '.repeat(MAX_TRACE_BYTES + 10001)); await assert.rejects(importEvidence(file), /size limit/);
  await fs.writeFile(file, '{"format":"trace-atlas-evidence","version":1,"graph":{"__proto__":{"polluted":true}}}'); await assert.rejects(importEvidence(file), /Unsafe/);
  assert.equal({}.polluted, undefined);
});
test('malformed graph paths, broken connections, duplicate blocks and executable data are rejected', () => {
  for (const change of [g => { g.nodes[1].file = '../outside.py'; }, g => { g.nodes[1].file = 'C:\\outside.py'; }, g => { g.edges[0].to = 'not-present'; }, g => { g.nodes[1].id = g.nodes[0].id; }, g => { g.nodes[0].meta = { fn: () => {} }; }, g => { g.url = 'javascript:run()'; }, g => { g.nodes[1].line = -1; }, g => { Object.defineProperty(g.nodes[0], 'label', { enumerable: true, get() { throw Error('getter executed'); } }); }]) { const capture = graph(); change(capture); assert.throws(() => validateGraph(capture)); }
});
test('corrupt storage is preserved before a successful new save', async t => {
  const directory = await fixture(t), file = path.join(directory, 'trace-snapshots.json'); await fs.writeFile(file, 'corrupted capture');
  const store = createTraceStore(directory); assert.match((await store.list()).warning, /backed up/); await store.save(graph());
  const backup = (await fs.readdir(directory)).find(name => name.startsWith('trace-snapshots.recovered-'));
  assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), 'corrupted capture'); assert.equal((await store.list()).warning, null);
});
test('snapshot capacity is explicit and does not silently evict pinned traces', async t => {
  const store = createTraceStore(await fixture(t));
  for (let i = 0; i < MAX_SNAPSHOTS; i++) await store.save(graph());
  await assert.rejects(store.save(graph()), /up to 24/); assert.equal((await store.list()).snapshots.length, MAX_SNAPSHOTS);
});
test('matching folder names do not misidentify snapshots from different repositories', async t => {
  const directory = await fixture(t), store = createTraceStore(directory);
  const first = await store.save(graph(), { repositoryName: 'clinic', repositoryPath: path.join(directory, 'one', 'clinic') });
  const same = await store.save(graph(), { repositoryName: 'clinic', repositoryPath: path.join(directory, 'one', 'clinic') });
  const other = await store.save(graph(), { repositoryName: 'clinic', repositoryPath: path.join(directory, 'two', 'clinic') });
  assert.equal((await store.compare(first.id, same.id)).sameProject, true); assert.equal((await store.compare(first.id, other.id)).sameProject, false);
  assert.equal((await store.list()).snapshots[0].repositoryPath, undefined);
});
test('stable comparison ignores volatile IDs and detects measured query counts and source changes', () => {
  const before = graph(), after = structuredClone(before); after.id = 'trace-new'; after.capturedAt = '2026-02-02T00:00:00.000Z'; after.url = 'http://127.0.0.1:6000/invoices';
  const names = new Map(after.nodes.map((node, index) => [node.id, `new-${index}`])); after.nodes.forEach(node => { node.id = names.get(node.id); if (node.meta) { node.meta.requestId = 'new-request'; node.meta.queryIds = ['new-query']; } }); after.edges.forEach((edge, index) => { edge.id = `new-edge-${index}`; edge.from = names.get(edge.from); edge.to = names.get(edge.to); });
  assert.equal(compareGraphs(before, after).unchanged, true);
  after.nodes[2].meta.executionCount = 4; after.summary.queries = 4; after.nodes[1].meta.sourceHash = 'b'.repeat(64);
  const diff = compareGraphs(before, after); assert.equal(diff.changedNodes.length, 2); assert.equal(diff.addedNodes.length, 0); assert.equal(diff.before.queries, 3); assert.equal(diff.after.queries, 4); assert.equal(diff.sameSelection, true);
  before.summary.timing = { queryDurationMs: 0, browserDurationMs: 20 }; after.summary.timing = { queryDurationMs: 4, browserDurationMs: 15 };
  assert.deepEqual(compareGraphs(before, after).timingDelta, { queryDurationMs: 4, browserDurationMs: -5, backendDurationMs: null });
});
test('editor target verifies fresh bytes, bounded line, containment and encodes URL punctuation', async t => {
  const directory = await fixture(t), name = 'invoice %#?.py', file = path.join(directory, process.platform === 'win32' ? 'invoice %#.py' : name), text = 'first\nsecond\n'; await fs.writeFile(file, text);
  const node = { file: path.basename(file), line: 2, meta: { sourceHash: createHash('sha256').update(text).digest('hex') } };
  const target = await verifiedEditorTarget(directory, node); assert.match(target.url, /^vscode:\/\/file\//); assert.match(target.url, /%25%23/); assert.match(target.url, /:2:1$/);
  await fs.writeFile(file, 'modified\n'); await assert.rejects(verifiedEditorTarget(directory, node), /changed after capture/);
  await assert.rejects(verifiedEditorTarget(directory, { ...node, file: '../outside.py' })); await assert.rejects(verifiedEditorTarget(directory, { ...node, meta: {} }), /no verified/);
  await fs.writeFile(file, text); await assert.rejects(verifiedEditorTarget(directory, { ...node, line: 99 }), /no longer exists/);
});
test('editor source rejects linked paths outside the connected repository', async t => {
  const directory = await fixture(t), outside = await fixture(t), text = 'secret\n'; await fs.writeFile(path.join(outside, 'source.py'), text);
  try { await fs.symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('Creating test links is unavailable.'); throw error; }
  await assert.rejects(verifiedEditorTarget(directory, { file: 'linked/source.py', line: 1, meta: { sourceHash: createHash('sha256').update(text).digest('hex') } }), /outside/);
});
test('health never reports observed tracing merely because processes are running', () => {
  const state = { repository: { name: 'clinic', fileCount: 20 }, url: 'http://127.0.0.1:5000/', loading: false, demo: false }, managed = { status: 'running', active: true, frontend: 'vite:frontend', backend: 'python:api' };
  const health = traceHealth({ state, managed }); assert.equal(health.canRestart, true); assert.equal(health.observed.coverage, 'not-captured'); assert(health.observed.stages.every(stage => stage.status === 'not-captured'));
  const captured = traceHealth({ state, managed, graph: graph(), hasSelection: true }); assert.equal(captured.observed.stages.find(stage => stage.id === 'sql').status, 'observed'); assert.equal(captured.observed.stages.find(stage => stage.id === 'backend').status, 'not-observed'); assert.equal(captured.canRecapture, true);
});
test('restart stops owned processes before fresh source scan, startup readiness and preview', async () => {
  const events = [], attachment = { status: 'running', url: 'http://127.0.0.1:5001/' };
  await restartManagedSession({ repository: 'repo', options: { frontend: 'vite:frontend', backend: null }, url: 'http://127.0.0.1:5000/ideas', check() {}, async stop() { events.push('stop'); }, async rescan() { events.push('rescan'); return { root: 'repo' }; }, async start(folder, options) { events.push('ready'); assert.deepEqual(options, { frontend: 'vite:frontend', backend: null, url: 'http://127.0.0.1:5000/ideas' }); return attachment; }, async open(url) { events.push('open'); assert.equal(url, attachment.url); } });
  assert.deepEqual(events, ['stop', 'rescan', 'ready', 'open']);
});
test('restart cancellation after stop cannot scan/start another project; failure never opens preview', async () => {
  let cancelled = false, started = false;
  await assert.rejects(restartManagedSession({ repository: 'repo', options: {}, check() { if (cancelled) throw Error('Changed workspace'); }, async stop() { cancelled = true; }, async rescan() { throw Error('must not scan'); }, async start() { started = true; }, async open() { throw Error('must not open'); } }), /Changed workspace/); assert.equal(started, false);
  await assert.rejects(restartManagedSession({ repository: 'repo', options: {}, check() {}, async stop() {}, async rescan() { return {}; }, async start() { return { status: 'failed', notice: 'Backend unavailable' }; }, async open() { throw Error('must not open'); } }), /Backend unavailable/);
});
