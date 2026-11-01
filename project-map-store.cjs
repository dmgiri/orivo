'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const MAX_MAP_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTS = 12;
const hashPattern = /^[a-f0-9]{64}$/;
const relativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validMap(value, expectedKey) {
  if (!exactKeys(value, ['version', 'fingerprint', 'projectName', 'generatedAt', 'files', 'languages', 'frameworks', 'symbols', 'references', 'summary', 'limits']) || value.version !== 1 || value.rootKey !== undefined) return false;
  if (!hashPattern.test(value.fingerprint || '') || typeof value.projectName !== 'string' || value.projectName.length > 240 || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (!Array.isArray(value.files) || value.files.length > 5000 || !Array.isArray(value.languages) || value.languages.length > 80 || !Array.isArray(value.frameworks) || value.frameworks.length > 100 || !Array.isArray(value.symbols) || value.symbols.length > 20000 || !Array.isArray(value.references) || value.references.length > 25000) return false;
  if (!exactKeys(value.summary, ['sourceFiles', 'analyzedFiles', 'analyzedBytes', 'symbols', 'references', 'parseFailures', 'skippedByLimit', 'skippedBySourceIndex', 'sourceIndexTruncated', 'analysisLimited']) || !exactKeys(value.limits, ['analysisBytes', 'symbols', 'references', 'mapBytes'])) return false;
  for (const file of value.files) if (!exactKeys(file, ['path', 'hash', 'bytes', 'lineCount', 'language', 'analyzed']) || !relativePath(file.path) || !hashPattern.test(file.hash || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.lineCount) || file.lineCount < 1 || typeof file.language !== 'string' || typeof file.analyzed !== 'boolean') return false;
  for (const symbol of value.symbols) if (!exactKeys(symbol, ['id', 'kind', 'name', 'path', 'line', 'endLine', 'language', 'hash', 'status']) || !/^[a-f0-9]{24}$/.test(symbol.id || '') || typeof symbol.kind !== 'string' || typeof symbol.name !== 'string' || !relativePath(symbol.path) || !Number.isSafeInteger(symbol.line) || symbol.line < 1 || !Number.isSafeInteger(symbol.endLine) || symbol.endLine < symbol.line || !hashPattern.test(symbol.hash || '') || symbol.status !== 'found-in-source') return false;
  for (const ref of value.references) if (!exactKeys(ref, ['id', 'kind', 'from', 'target', 'status']) || !/^[a-f0-9]{24}$/.test(ref.id || '') || !exactKeys(ref.from, ['path', 'line', 'hash']) || !relativePath(ref.from.path) || !Number.isSafeInteger(ref.from.line) || ref.from.line < 1 || !hashPattern.test(ref.from.hash || '') || !exactKeys(ref.target, ['name', 'path', 'hash']) && !exactKeys(ref.target, ['name']) || typeof ref.target.name !== 'string' || ref.target.path !== undefined && (!relativePath(ref.target.path) || !hashPattern.test(ref.target.hash || '')) || ref.status !== 'candidate') return false;
  return value.fingerprint === expectedKey;
}

function createProjectMapStore(directory) {
  const base = path.resolve(directory);
  function fileFor(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096 || root.includes('\0')) throw Error('Invalid project root for the local source map.');
    const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 32);
    return path.join(base, `project-map-${key}.json`);
  }
  async function load(root, fingerprint) {
    if (!hashPattern.test(fingerprint || '')) throw Error('Invalid project source fingerprint.');
    const file = fileFor(root);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_MAP_BYTES) return null;
      const bytes = await handle.readFile();
      const value = JSON.parse(bytes.toString('utf8'));
      if (!validMap(value, fingerprint)) return null;
      return value;
    } catch (error) {if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return null; throw error;}
    finally {await handle?.close();}
  }
  async function save(root, value) {
    if (!value || !validMap(value, value.fingerprint)) throw Error('The local source map is invalid and was not saved.');
    const file = fileFor(root), data = Buffer.from(JSON.stringify(value));
    if (data.length > MAX_MAP_BYTES) throw Error('The local source map is too large to cache. The current scan is still available.');
    await fs.mkdir(base, {recursive: true});
    const temporary = path.join(base, `.project-map-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, data, {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, file);
      const entries = (await fs.readdir(base)).filter(name => /^project-map-[a-f0-9]{32}\.json$/.test(name));
      const stats = await Promise.all(entries.map(async name => ({name, stat: await fs.stat(path.join(base, name)).catch(() => null)})));
      let total = stats.reduce((sum, item) => sum + (item.stat?.size || 0), 0);
      const evictable = stats.filter(item => item.name !== path.basename(file) && item.stat).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let count = stats.length;
      while ((total > MAX_TOTAL_BYTES || count > MAX_PROJECTS) && evictable.length) {
        const item = evictable.shift();
        await fs.rm(path.join(base, item.name), {force: true});
        count--;
        total -= item.stat.size;
      }
      return {saved: true, bytes: data.length};
    } finally {await fs.rm(temporary, {force: true}).catch(() => {});}
  }
  async function clear(root) {
    await fs.rm(fileFor(root), {force: true});
    return {cleared: true};
  }
  return Object.freeze({load, save, clear, limits: Object.freeze({mapBytes: MAX_MAP_BYTES, totalBytes: MAX_TOTAL_BYTES, projects: MAX_PROJECTS})});
}

module.exports = {createProjectMapStore, MAX_MAP_BYTES, MAX_TOTAL_BYTES, MAX_PROJECTS};
