'use strict';
// Explicit development middleware for Node HTTP and Express-compatible servers.
// Request/response bodies and SQL parameter values are never inspected.
const { AsyncLocalStorage } = require('node:async_hooks');
const { begin, registerRoot } = require('./node-sqlite.cjs');

function plainRead(database, sql, parameters = []) {
  const rows = database.prepare(sql).all(...parameters);
  return { rows, field(index, column) {
    if (!Number.isInteger(index) || !rows[index] || !Object.hasOwn(rows[index], column)) throw Error('Invalid result field');
    return rows[index][column];
  } };
}

function createTracing({ repositoryRoot, development = false } = {}) {
  const enabled = development === true;
  const root = enabled ? registerRoot(repositoryRoot).root : null;
  const storage = new AsyncLocalStorage();
  const responses = new WeakMap();

  function middleware(request, response, next) {
    if (typeof next !== 'function') throw TypeError('Tracing middleware needs a next function');
    const id = request?.headers?.['x-studio-trace'];
    if (!enabled || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) return next();
    const previous = responses.get(response);
    if (previous && previous.request === request) return storage.run(previous, next);
    let trace;
    try { trace = begin(root, id, { routeFromRead: true }); }
    catch { return next(); }
    const context = { request, trace, closed: false };
    responses.set(response, context);
    function publish(close) {
      if (context.closed) return;
      try {
        const header = context.trace.header(close);
        if (!response.headersSent && typeof response.setHeader === 'function') response.setHeader('Studio-Trace', header);
      } catch { /* Tracing must not prevent the application from responding. */ }
      if (close) context.closed = true;
    }
    const writeHead = response.writeHead, end = response.end;
    if (typeof writeHead === 'function') response.writeHead = function (...args) { publish(false); return writeHead.apply(this, args); };
    if (typeof end === 'function') response.end = function (...args) { publish(true); return end.apply(this, args); };
    if (typeof response.once === 'function') {
      response.once('finish', () => { context.closed = true; });
      response.once('close', () => { context.closed = true; });
    }
    return storage.run(context, next);
  }

  function handler(fn) {
    if (typeof fn !== 'function') throw TypeError('Tracing handler must be a function');
    return function (...args) {
      const receiver = this;
      return middleware(args[0], args[1], () => fn.apply(receiver, args));
    };
  }

  function read(database, sql, parameters = []) {
    const context = storage.getStore();
    return context && !context.closed ? context.trace.read(database, sql, parameters) : plainRead(database, sql, parameters);
  }

  return { middleware, handler, read };
}

module.exports = { createTracing };
