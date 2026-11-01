'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { appUrl } = require('./host-security.cjs');
const MAX_WORKSPACES = 12;
const MAX_BYTES = 128 * 1024;
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

function workspace(value) {
  if (!value || typeof value !== 'object' || !validId(value.id)) throw Error('Invalid saved workspace.');
  if (typeof value.repositoryPath !== 'string' || !path.isAbsolute(value.repositoryPath) || value.repositoryPath.length > 4096 || value.repositoryPath.includes('\0')) throw Error('Invalid workspace source folder.');
  const name = String(value.name || path.basename(value.repositoryPath)).trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
  if (!name || typeof value.lastOpenedAt !== 'string' || !Number.isFinite(Date.parse(value.lastOpenedAt))) throw Error('Invalid saved workspace details.');
  const record = { id: value.id, name, url: appUrl(value.url), repositoryPath: value.repositoryPath, lastOpenedAt: new Date(value.lastOpenedAt).toISOString() };
  if (value.attachment !== undefined) {
    const options = value.attachment;
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['frontend', 'backend'].includes(key)) || typeof options.frontend !== 'string' || !options.frontend || options.frontend.length > 500 || options.frontend.includes('\0') || (options.backend !== null && (typeof options.backend !== 'string' || !options.backend || options.backend.length > 500 || options.backend.includes('\0')))) throw Error('Invalid saved attachment selection.');
    record.attachment = { frontend: options.frontend, backend: options.backend };
  }
  return record;
}

function createWorkspaceStore(directory) {
  const file = path.join(directory, 'workspaces.json');
  let records = [], warning = null, initialized, writes = Promise.resolve();
  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      let handle;
      try {
        handle = await fs.open(file, 'r');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw Error('Saved workspace metadata is too large.');
        const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (parsed.version !== 1 || !Array.isArray(parsed.workspaces) || parsed.workspaces.length > MAX_WORKSPACES) throw Error('Unsupported saved workspace metadata.');
        records = parsed.workspaces.map(workspace);
        if (new Set(records.map(record => record.id)).size !== records.length) throw Error('Duplicate saved workspace identifiers.');
      } catch (error) {
        if (error.code !== 'ENOENT') warning = 'Saved workspaces could not be read. Reconnect your project; the existing metadata will be preserved as a backup before saving.';
        records = [];
      } finally { await handle?.close(); }
    })();
    return initialized;
  }
  const copy = record => ({ ...record, ...(record.attachment ? { attachment: { ...record.attachment } } : {}) });
  const copies = () => records.slice().sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).map(copy);
  async function persist(next) {
    await fs.mkdir(directory, { recursive: true });
    if (warning) {
      try { await fs.rename(file, path.join(directory, `workspaces.recovered-${randomUUID()}.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const temporary = path.join(directory, `.workspaces-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, workspaces: next }, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
      records = next;
      warning = null;
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function mutate(operation) {
    const pending = writes.then(async () => { await initialize(); return operation(); });
    writes = pending.catch(() => {});
    return pending;
  }
  return Object.freeze({
    async list() { await initialize(); await writes; return copies(); },
    async get(id) { if (!validId(id)) throw Error('Choose a saved workspace.'); await initialize(); await writes; const found = records.find(record => record.id === id); if (!found) throw Error('This workspace is no longer saved.'); return copy(found); },
    async warning() { await initialize(); return warning; },
    save(value) { return mutate(async () => {
      const existing = records.find(record => record.repositoryPath === value?.repositoryPath && (record.url === value?.url || record.attachment && value?.attachment && record.attachment.frontend === value.attachment.frontend && record.attachment.backend === value.attachment.backend));
      const record = workspace({ ...value, id: existing?.id || randomUUID(), lastOpenedAt: new Date().toISOString() });
      await persist([record, ...records.filter(item => item.id !== record.id)].slice(0, MAX_WORKSPACES));
      return copy(record);
    }); },
    touch(id) { return mutate(async () => {
      if (!validId(id)) throw Error('Choose a saved workspace.');
      const found = records.find(record => record.id === id);
      if (!found) throw Error('This workspace is no longer saved.');
      const updated = { ...found, lastOpenedAt: new Date().toISOString() };
      await persist([updated, ...records.filter(record => record.id !== id)]);
      return copy(updated);
    }); },
    remove(id) { return mutate(async () => { if (!validId(id)) throw Error('Choose a saved workspace.'); await persist(records.filter(record => record.id !== id)); return copies(); }); },
  });
}
module.exports = { createWorkspaceStore, MAX_WORKSPACES };
