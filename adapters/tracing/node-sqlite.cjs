'use strict';
// Opt-in development adapter for Node's built-in SQLite. Never records SQL values.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { deflateSync } = require('node:zlib');

const registrations = new Map();
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.cts', '.mts']);
const excludedDirectories = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'archive', 'archives', 'evidence']);
const sdkDirectory = fs.realpathSync(__dirname);
const maxSourceBytes = 262144;
const maxFields = 200;

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function sourceBytes(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxSourceBytes) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxSourceBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > stat.size || length > maxSourceBytes) return null;
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Call at development server startup, before serving requests. A root keeps its
// first snapshot for this process; restart the server after editing its source.
function registerRoot(root) {
  root = fs.realpathSync(root);
  if (registrations.has(root)) return registrations.get(root).info;
  if (registrations.size >= 16) throw Error('Development tracing reached its source-root limit; restart the server to register another project');
  if (!fs.statSync(root).isDirectory()) throw Error('Tracing source root must be a directory');
  const files = new Map();
  let visited = 0, totalBytes = 0, truncated = false;
  function visit(directory, depth) {
    if (depth > 16) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const entry of entries) {
      if (++visited > 30000 || files.size >= 5000 || totalBytes >= 33554432) { truncated = true; return; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase()) && filename !== sdkDirectory) visit(filename, depth + 1);
        continue;
      }
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase()) || /(?:^|[._-])(?:secrets?|credentials)(?:[._-]|$)/i.test(entry.name)) continue;
      if (filename === sdkDirectory || inside(sdkDirectory, filename)) continue;
      const bytes = sourceBytes(filename);
      if (!bytes) continue;
      if (totalBytes + bytes.length > 33554432) { truncated = true; continue; }
      totalBytes += bytes.length;
      files.set(filename, { path: path.relative(root, filename).replaceAll('\\', '/'), hash: createHash('sha256').update(bytes).digest('hex'), lines: bytes.toString('utf8').split('\n').length });
    }
  }
  visit(root, 0);
  const info = Object.freeze({ root, files: files.size, truncated });
  registrations.set(root, { files, info });
  return info;
}

function verifiedSite(registration, filename, line, name, freshness) {
  try {
    filename = fs.realpathSync(filename);
    const expected = registration.files.get(filename);
    if (!expected || !Number.isInteger(line) || line < 1 || line > expected.lines) return null;
    let fresh = freshness?.get(filename);
    if (fresh === undefined) {
      const bytes = sourceBytes(filename);
      fresh = !!bytes && createHash('sha256').update(bytes).digest('hex') === expected.hash;
      freshness?.set(filename, fresh);
    }
    if (!fresh) return null;
    return { path: expected.path, line, name: String(name || '').slice(0, 100), hash: expected.hash };
  } catch { return null; }
}

function begin(root, requestId, { routeFromRead = false } = {}) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId || '')) throw Error('Missing development trace ID');
  root = fs.realpathSync(root);
  // Compatibility for existing manual integrations. Startup registration is
  // recommended so changes before the first request are also detected.
  if (!registrations.has(root)) registerRoot(root);
  const registration = registrations.get(root);
  function stack() {
    const previousLimit = Error.stackTraceLimit;
    let lines;
    try { Error.stackTraceLimit = 40; lines = new Error().stack.split('\n').slice(2); }
    finally { Error.stackTraceLimit = previousLimit; }
    let invalid = false, applicationCaller = false;
    const frames = lines.flatMap(line => {
      let value = line.trim().replace(/^at\s+/, ''), name = '';
      if (value.endsWith(')') && value.includes(' (')) {
        const separator = value.lastIndexOf(' (');
        name = value.slice(0, separator); value = value.slice(separator + 2, -1);
      }
      const match = value.match(/^(.+):(\d+):(\d+)$/);
      if (!match) return [];
      let filename = match[1];
      try { if (filename.startsWith('file:')) filename = fileURLToPath(filename); }
      catch { return []; }
      if (!path.isAbsolute(filename)) return [];
      const absolute = path.resolve(filename), relative = path.relative(root, absolute);
      if (!inside(root, absolute) || absolute === sdkDirectory || inside(sdkDirectory, absolute)) return [];
      const parts = relative.split(path.sep);
      // Framework callers above the actual application query are not source
      // evidence. A dependency beneath that caller cannot become its query site.
      if (parts.some(part => part.toLowerCase() === 'node_modules')) {
        if (!applicationCaller) invalid = true;
        return [];
      }
      if (!sourceExtensions.has(path.extname(absolute).toLowerCase()) || parts.some(part => part.startsWith('.') || excludedDirectories.has(part.toLowerCase()))) {
        invalid = true; return [];
      }
      const site = verifiedSite(registration, filename, Number(match[2]), name);
      // A stale/missing helper must not disappear and promote a fresh caller to
      // the executed query site. The whole application chain is unverified.
      if (!site) invalid = true;
      else applicationCaller = true;
      return site ? [site] : [];
    });
    return invalid ? [] : frames.reverse().slice(-12);
  }
  function current(site, freshness) {
    if (!site) return null;
    const verified = verifiedSite(registration, path.join(root, site.path), site.line, site.name, freshness);
    return verified?.hash === site.hash ? verified : null;
  }
  const trace = { id: requestId, route: routeFromRead ? null : stack().at(-1) || null, queries: [], truncated: registration.info.truncated };
  const started = performance.now();
  const claims = new Map();
  let closed = false;

  function sameValue(original, value) {
    if (original.bytes) return ArrayBuffer.isView(value) && original.bytes.equals(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return Object.is(original.value, value);
  }
  function validClaim(claim) {
    const row = claim.rows[claim.index], descriptor = row && Object.getOwnPropertyDescriptor(row, claim.column);
    return row === claim.original.row && descriptor && Object.hasOwn(descriptor, 'value') && sameValue(claim.original.value, descriptor.value);
  }
  function validPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) && value.split('.').every(part => part && !['__proto__', 'constructor', 'prototype'].includes(part));
  }
  function record(query, sql) {
    if (trace.queries.length >= 20 || typeof sql !== 'string' || sql.length > 6000) { trace.truncated = true; return false; }
    trace.queries.push(query); return true;
  }
  return {
    read(database, sql, parameters = []) {
      if (closed) throw Error('Trace closed');
      const frames = stack();
      if (!trace.route && frames.length) trace.route = frames.at(-1);
      const query = { id: randomUUID(), sql: typeof sql === 'string' ? sql.replace(/'(?:''|[^'])*'/g, "'?'").replace(/\b\d+(?:\.\d+)?\b/g, '?') : '', site: frames.at(-1) || null, frames, tables: [] };
      let rows, columns, queryStarted;
      try {
        const statement = database.prepare(sql);
        queryStarted = performance.now(); query.startOffsetMs = queryStarted - started;
        rows = statement.all(...parameters); query.durationMs = performance.now() - queryStarted; columns = statement.columns();
        query.tables = [...new Set(columns.map(column => column.table).filter(Boolean))];
      } catch (error) { if (queryStarted !== undefined) query.durationMs = performance.now() - queryStarted; query.failed = true; record(query, sql); throw error; }
      const recorded = record(query, sql);
      const candidates = new Map();
      for (const column of columns) if (column.table && column.column) {
        const matches = columns.filter(candidate => candidate.name === column.name);
        if (matches.length === 1) candidates.set(column.name, column);
      }
      const originals = rows.map(row => {
        const values = new Map();
        for (const column of candidates.keys()) {
          const descriptor = Object.getOwnPropertyDescriptor(row, column);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
          const value = descriptor.value;
          if (ArrayBuffer.isView(value)) values.set(column, { bytes: Buffer.from(Buffer.from(value.buffer, value.byteOffset, value.byteLength)) });
          else if (value === null || ['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value)) values.set(column, { value });
        }
        return { row, values };
      });
      return {
        rows,
        field(index, column, responsePath) {
          if (closed || !Number.isInteger(index) || !rows[index] || !Object.hasOwn(rows[index], column)) throw Error('Invalid result field');
          const value = rows[index][column], origin = candidates.get(column), original = originals[index];
          if (validPath(responsePath)) {
            const claim = { rows, index, column, original: original && { row: original.row, value: original.values.get(column) } };
            if (!recorded || !trace.route || !query.site || !origin || !claim.original?.value || !validClaim(claim)) claims.delete(responsePath);
            else if (claims.has(responsePath) || claims.size < maxFields) claims.set(responsePath, { ...claim, origin: { table: origin.table, column: origin.column, model: null, queries: [query.id] } });
            else trace.truncated = true;
          }
          return value;
        }
      };
    },
    // An early writeHead needs a snapshot without closing the request's reads.
    header(close = true) {
      if (close) closed = true;
      const freshness = new Map(), route = current(trace.route, freshness);
      const queries = trace.queries.map(query => {
        const frames = query.frames.map(frame => current(frame, freshness)), intact = frames.every(Boolean);
        return { ...query, site: intact ? current(query.site, freshness) : null, frames: intact ? frames : [] };
      });
      const fields = Object.create(null);
      for (const [responsePath, claim] of claims) if (route && validClaim(claim) && claim.origin.queries.every(id => queries.some(query => query.id === id && !query.failed && query.site))) fields[responsePath] = claim.origin;
      const snapshot = { ...trace, durationMs:performance.now()-started, route, queries, fields };
      function encode(value) {
        const raw = Buffer.from(JSON.stringify(value));
        if (raw.length > 300000) return null;
        const plain = raw.toString('base64');
        return plain.length > 3072 ? 'z1.' + deflateSync(raw).toString('base64') : plain;
      }
      const encoded = encode(snapshot);
      if (encoded && encoded.length <= 6144) return encoded;
      const minimal = { id: trace.id, route, queries: [], fields: {}, truncated: true };
      const fallback = encode(minimal);
      return fallback && fallback.length <= 6144 ? fallback : encode({ ...minimal, route: null });
    }
  };
}

module.exports = { begin, registerRoot };
