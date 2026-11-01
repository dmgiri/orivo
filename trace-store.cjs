'use strict';
// Captures are inert, bounded JSON. Import never connects a repository, executes
// code, or writes into the project whose paths happen to appear in a capture.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { relativePath, appUrl } = require('./host-security.cjs');
const MAX_TRACE_BYTES = 2 * 1024 * 1024, MAX_STORE_BYTES = 20 * 1024 * 1024, MAX_SNAPSHOTS = 24;
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inertCopy(value, state = { remaining: 60000 }, depth = 0) {
  if (--state.remaining < 0 || depth > 18) throw Error('Trace exceeds the supported data limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('Trace numbers must be finite.'); return value; }
  if (typeof value === 'string') { if (value.length > 250000) throw Error('Trace text is too long.'); return value; }
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Trace must contain plain JSON data.');
  if (Array.isArray(value) && value.length > 10000) throw Error('Trace list is too long.');
  const out = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Unsafe trace data key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Trace accessors are unsupported.');
    out[key] = inertCopy(descriptor.value, state, depth + 1);
  }
  return out;
}
function validateGraph(value) {
  const graph = inertCopy(value);
  if (!graph || typeof graph.id !== 'string' || graph.id.length > 200 || typeof graph.title !== 'string' || graph.title.length > 1000 || typeof graph.selector !== 'string' || graph.selector.length > 2000 || !Array.isArray(graph.nodes) || graph.nodes.length > 1000 || !Array.isArray(graph.edges) || graph.edges.length > 3000 || !Array.isArray(graph.gaps) || graph.gaps.some(gap => typeof gap !== 'string') || !Array.isArray(graph.files) || !['unavailable', 'frontend', 'partial', 'complete'].includes(graph.coverage)) throw Error('This file does not contain a supported Orivo trace graph.');
  appUrl(graph.url);
  if (typeof graph.capturedAt !== 'string' || !Number.isFinite(Date.parse(graph.capturedAt))) throw Error('Trace capture time is invalid.');
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 200 || ids.has(node.id) || typeof node.kind !== 'string' || node.kind.length > 50 || typeof node.label !== 'string' || typeof node.subtitle !== 'string' || typeof node.detail !== 'string' || node.code !== undefined && typeof node.code !== 'string' || node.meta !== undefined && (!node.meta || typeof node.meta !== 'object' || Array.isArray(node.meta))) throw Error('Invalid trace block.');
    ids.add(node.id);
    if (node.file !== undefined) node.file = relativePath(node.file);
    if (node.line !== undefined && (!Number.isInteger(node.line) || node.line < 1 || node.line > 1000000)) throw Error('Invalid trace source line.');
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) || typeof edge.label !== 'string') throw Error('Invalid trace connection.');
    edgeIds.add(edge.id);
  }
  graph.files = graph.files.map(relativePath);
  // Host-only annotations cannot turn an imported capture into live evidence.
  delete graph.snapshot;
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_TRACE_BYTES) throw Error('Trace exceeds the 2 MiB capture limit.');
  return graph;
}
async function readBounded(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw Error('Choose a JSON file.');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > limit) throw Error('The selected trace file exceeds the supported size limit.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
async function importEvidence(file) {
  const data = JSON.parse(await readBounded(file, MAX_TRACE_BYTES + 10000));
  if (data?.format !== 'trace-atlas-evidence' || data.version !== 1) throw Error('Choose an Orivo evidence export (version 1).');
  return validateGraph(data.graph);
}
const normalizedUrl = value => { try { return new URL(value).pathname; } catch { return ''; } };
function nodeIdentity(node) {
  const meta = node.meta || {};
  return digest([node.kind, node.file || '', node.line || 0, meta.sourceRole || '', meta.responseField || '', meta.table || '', meta.column || '', node.kind === 'query' ? node.code || '' : node.kind === 'element' ? meta.selector || node.subtitle : node.kind === 'source' || node.kind === 'backend' ? '' : node.label, node.kind === 'api' ? normalizedUrl(meta.url) : '']);
}
function stableNode(node) {
  const meta = node.meta || {};
  return { kind: node.kind, label: node.label, file: node.file || null, line: node.line || null, code: node.code || null, sourceHash: meta.sourceHash || null, status: node.status || null, executions: meta.executionCount || 0, durationMs: meta.durationMs ?? meta.totalDurationMs ?? null, failed: meta.failed || false };
}
function compareGraphs(leftInput, rightInput) {
  const left = validateGraph(leftInput), right = validateGraph(rightInput);
  function collect(graph) {
    const nodes = new Map(), keys = new Map();
    for (const node of graph.nodes) { const key = nodeIdentity(node); keys.set(node.id, key); const rows = nodes.get(key) || []; rows.push(stableNode(node)); nodes.set(key, rows); }
    for (const rows of nodes.values()) rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const edges = new Set(graph.edges.map(edge => JSON.stringify([keys.get(edge.from), keys.get(edge.to), edge.label])));
    return { nodes, edges };
  }
  const a = collect(left), b = collect(right), addedNodes = [], removedNodes = [], changedNodes = [];
  for (const [key, rows] of b.nodes) if (!a.nodes.has(key)) addedNodes.push({ key, ...rows[0], occurrences: rows.length }); else if (JSON.stringify(rows) !== JSON.stringify(a.nodes.get(key))) changedNodes.push({ key, before: a.nodes.get(key), after: rows });
  for (const [key, rows] of a.nodes) if (!b.nodes.has(key)) removedNodes.push({ key, ...rows[0], occurrences: rows.length });
  const addedEdges = [...b.edges].filter(key => !a.edges.has(key)).map(JSON.parse), removedEdges = [...a.edges].filter(key => !b.edges.has(key)).map(JSON.parse);
  const timing = graph => Object.fromEntries(['queryDurationMs', 'browserDurationMs', 'backendDurationMs'].map(key => [key, typeof graph.summary?.timing?.[key] === 'number' && Number.isFinite(graph.summary.timing[key]) && graph.summary.timing[key] >= 0 ? graph.summary.timing[key] : null]));
  const counts = graph => ({ nodes: graph.nodes.length, requests: Number(graph.summary?.requests) || 0, queries: Number(graph.summary?.queries) || 0, gaps: graph.gaps.length, coverage: graph.coverage, timing: timing(graph) });
  const before = counts(left), after = counts(right), timingDelta = Object.fromEntries(Object.keys(before.timing).map(key => [key, before.timing[key] !== null && after.timing[key] !== null ? after.timing[key] - before.timing[key] : null]));
  return { sameSelection: left.selector === right.selector && normalizedUrl(left.url) === normalizedUrl(right.url), before, after, timingDelta, addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, unchanged: !addedNodes.length && !removedNodes.length && !changedNodes.length && !addedEdges.length && !removedEdges.length && JSON.stringify(before) === JSON.stringify(after), note: 'Comparison uses source locations, SQL, field paths and graph connections. Capture IDs, request IDs, query IDs and timestamps are ignored. Duration differences are measured-only and are not a controlled benchmark.' };
}
function createTraceStore(directory) {
  const file = path.join(directory, 'trace-snapshots.json');
  let records = [], initialized, warning = null, writes = Promise.resolve();
  const metadata = row => ({ id: row.id, name: row.name, savedAt: row.savedAt, imported: row.imported, title: row.graph.title, capturedAt: row.graph.capturedAt, coverage: row.graph.coverage, summary: inertCopy(row.graph.summary || {}), repositoryName: row.repositoryName });
  function record(input) {
    if (!input || !validId(input.id) || typeof input.name !== 'string' || !input.name || input.name.length > 100 || typeof input.imported !== 'boolean' || !Number.isFinite(Date.parse(input.savedAt))) throw Error('Invalid saved trace snapshot.');
    return { id: input.id, name: input.name, savedAt: new Date(input.savedAt).toISOString(), imported: input.imported, repositoryName: typeof input.repositoryName === 'string' ? input.repositoryName.slice(0, 100) : '', repositoryKey: /^[a-f0-9]{64}$/.test(input.repositoryKey || '') ? input.repositoryKey : '', graph: validateGraph(input.graph) };
  }
  async function initialize() {
    return initialized ||= (async () => { try { const data = JSON.parse(await readBounded(file, MAX_STORE_BYTES)); if (data.version !== 1 || !Array.isArray(data.snapshots) || data.snapshots.length > MAX_SNAPSHOTS) throw Error('Unsupported snapshot file.'); records = data.snapshots.map(record); if (new Set(records.map(row => row.id)).size !== records.length) throw Error('Duplicate snapshot identifiers.'); } catch (error) { records = []; if (error.code !== 'ENOENT') warning = 'Saved traces could not be read. Their file will be backed up before the next save.'; } })();
  }
  async function persist(next) {
    const content = JSON.stringify({ version: 1, snapshots: next });
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw Error('Local trace storage is full. Remove an older snapshot before saving.');
    await fs.mkdir(directory, { recursive: true });
    if (warning) { try { await fs.rename(file, path.join(directory, `trace-snapshots.recovered-${randomUUID()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const temporary = path.join(directory, `.trace-snapshots-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); records = next; warning = null; } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  const mutate = fn => { const pending = writes.then(async () => { await initialize(); return fn(); }); writes = pending.catch(() => {}); return pending; };
  async function get(id) { if (!validId(id)) throw Error('Choose a saved trace.'); await initialize(); await writes; const found = records.find(row => row.id === id); if (!found) throw Error('This trace snapshot is no longer saved.'); return found; }
  return Object.freeze({
    async list() { await initialize(); await writes; return { snapshots: records.map(metadata), warning }; },
    save(graph, options = {}) { const captured = validateGraph(graph); return mutate(async () => { if (records.length >= MAX_SNAPSHOTS) throw Error('You can save up to 24 traces. Remove an older snapshot first.'); const name = String(options.name || captured.title || 'Captured trace').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100); const repositoryKey = !options.imported && typeof options.repositoryPath === 'string' && path.isAbsolute(options.repositoryPath) ? digest(process.platform === 'win32' ? options.repositoryPath.toLowerCase() : options.repositoryPath) : ''; const row = record({ id: randomUUID(), name: name || 'Captured trace', savedAt: new Date().toISOString(), imported: !!options.imported, repositoryName: options.repositoryName || '', repositoryKey, graph: captured }); await persist([row, ...records]); return metadata(row); }); },
    async open(id) { const row = await get(id); return { ...inertCopy(row.graph), snapshot: { ...metadata(row), readOnly: true } }; },
    remove(id) { return mutate(async () => { if (!validId(id)) throw Error('Choose a saved trace.'); await persist(records.filter(row => row.id !== id)); return { snapshots: records.map(metadata), warning }; }); },
    async compare(leftId, rightId) { const [left, right] = await Promise.all([get(leftId), get(rightId)]); return { ...compareGraphs(left.graph, right.graph), left: metadata(left), right: metadata(right), sameProject: !left.imported && !right.imported && !!left.repositoryKey && left.repositoryKey === right.repositoryKey }; },
  });
}
module.exports = { createTraceStore, validateGraph, importEvidence, compareGraphs, MAX_TRACE_BYTES, MAX_STORE_BYTES, MAX_SNAPSHOTS };
