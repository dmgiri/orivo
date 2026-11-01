'use strict';
// Discovery reads bounded, ordinary project files. It never imports Python code.
const fs = require('node:fs/promises');
const path = require('node:path');
const omit = /^(?:node_modules|vendor|dist|build|out|target|coverage|logs?|data|databases?|uploads?|storage|archives?|backups?|tmp|temp|cache|__pycache__|venv|env|site-packages|releases?|tests?|migrations?)$/i;
const sensitive = /(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?|service[-_]?accounts?|tokens?|passwords?|sessions?|cookies?)(?:[._-]|$)/i;
const identifiers = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const slash = value => value.split(path.sep).join('/');

// Keep indentation and identifiers while excluding comments, literal contents,
// and docstrings. Thus examples in documentation cannot become app candidates.
function codeOnly(source) {
  return source.replace(/('''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|#[^\r\n]*)/g, text => text.replace(/[^\r\n]/g, ' '));
}
function applications(source) {
  const code = codeOnly(source), constructors = new Map();
  for (const match of code.matchAll(/^\s*from\s+(fastapi|starlette\.applications)\s+import\s+([^\n]+)/gm)) {
    for (const item of match[2].split(',')) {
      const imported = item.trim().match(/^(FastAPI|Starlette)(?:\s+as\s+([A-Za-z_]\w*))?$/);
      if (imported) constructors.set(imported[2] || imported[1], imported[1]);
    }
  }
  for (const match of code.matchAll(/^\s*import\s+(fastapi|starlette\.applications)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/gm)) {
    constructors.set((match[2] || match[1]) + (match[1] === 'fastapi' ? '.FastAPI' : '.Starlette'), match[1] === 'fastapi' ? 'FastAPI' : 'Starlette');
  }
  const output = [], lines = code.split(/\r?\n/);
  for (const [constructor, framework] of constructors) {
    const escaped = constructor.replaceAll('.', '\\.');
    const assignment = new RegExp('^([A-Za-z_]\\w*)\\s*(?::[^=]+)?=\\s*' + escaped + '\\s*\\(');
    for (const line of lines) { const match = line.match(assignment); if (match) output.push({ member: match[1], factory: false, framework }); }
    for (let i = 0; i < lines.length; i++) {
      const signature = lines[i].match(/^def\s+([A-Za-z_]\w*)\s*\((.*)$/);
      if (!signature || !/^(?:create_app|make_app|build_app|app_factory)$/.test(signature[1])) continue;
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
      const body = lines.slice(i + 1, end).join('\n');
      if (new RegExp('\\b' + escaped + '\\s*\\(').test(body)) output.push({ member: signature[1], factory: true, framework });
    }
  }
  // A module that exposes an already-created app should not also appear as the
  // factory which created that exact app. Independent apps remain separate.
  for (const row of [...output].filter(item => item.factory)) {
    const assignment = new RegExp('^([A-Za-z_]\\w*)\\s*(?::[^=]+)?=\\s*' + row.member + '\\s*\\(', 'm').exec(code);
    if (assignment) {
      const at = output.indexOf(row); output.splice(at, 1);
      if (!output.some(item => item.member === assignment[1])) output.push({ ...row, member: assignment[1], factory: false });
    }
  }
  return output;
}
async function detectPython(folder, description = []) {
  const root = await fs.realpath(folder), files = [], manifests = [], directories = new Set(['.']);
  const backends = Array.isArray(description) ? description : description?.backends || [];
  for (const row of backends) if (row && ['FastAPI', 'Starlette'].includes(row.framework) && typeof row.directory === 'string') directories.add(row.directory);
  let entries = 0, bytes = 0;
  async function read(file) {
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || bytes + stat.size > 20 * 1024 * 1024) return null; bytes += stat.size; return await fs.readFile(file, 'utf8'); } catch { return null; }
  }
  async function walk(directory, depth = 0) {
    if (depth > 12 || entries >= 20000 || files.length >= 3000) return;
    let iterator; try { iterator = await fs.opendir(directory); } catch { return; }
    for await (const entry of iterator) {
      if (++entries > 20000 || files.length >= 3000) break;
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || sensitive.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!omit.test(entry.name)) await walk(absolute, depth + 1); }
      else if (entry.isFile() && (entry.name.endsWith('.py') || /^(?:pyproject\.toml|requirements[^/]*\.txt|Procfile|Makefile|Dockerfile|package\.json)$/.test(entry.name))) {
        const source = await read(absolute); if (source === null) continue;
        if (entry.name.endsWith('.py')) files.push({ absolute, source });
        else {
          manifests.push({ absolute, source });
          if (/fastapi|starlette/i.test(source) && /^(?:pyproject\.toml|requirements[^/]*\.txt)$/.test(entry.name)) directories.add(slash(path.relative(root, directory)) || '.');
        }
      }
    }
  }
  await walk(root);
  const rows = [];
  for (const file of files) {
    const apps = applications(file.source); if (!apps.length) continue;
    const relative = slash(path.relative(root, file.absolute));
    const ancestors = [...directories].filter(name => name === '.' || relative.startsWith(name.replaceAll('\\', '/') + '/')).sort((a, b) => b.length - a.length);
    let directory = ancestors[0] || '.';
    // Common backend/src layouts do not always have a Python manifest.
    if (directory === '.' && /^(?:backend|server|api)\//.test(relative)) directory = relative.split('/')[0];
    const backend = path.join(root, directory), local = path.relative(backend, file.absolute).split(path.sep);
    const sourceRoot = local[0] === 'src' ? path.join(backend, 'src') : backend;
    let moduleParts = path.relative(sourceRoot, file.absolute).slice(0, -3).split(path.sep);
    if (moduleParts.at(-1) === '__init__') moduleParts.pop();
    if (!moduleParts.length || !moduleParts.every(part => /^[A-Za-z_]\w*$/.test(part))) continue;
    const module = moduleParts.join('.'), sourcePaths = [...new Set([sourceRoot, backend])];
    let python = null;
    for (const environment of [...new Set([path.join(backend, '.venv'), path.join(root, '.venv'), path.join(backend, 'venv'), path.join(root, 'venv')])]) {
      for (const executable of [path.join(environment, 'Scripts', 'python.exe'), path.join(environment, 'bin', 'python')]) {
        try { if ((await fs.stat(executable)).isFile()) { python = executable; break; } } catch {}
      }
      if (python) break;
    }
    for (const app of apps) rows.push({ id: 'python:' + directory + ':' + module + ':' + app.member, type: 'python', directory: slash(directory), framework: app.framework, app: module + ':' + app.member, factory: app.factory, python, sourcePaths, issue: python ? null : 'No existing .venv Python interpreter found for this backend. Create or select its development environment first.' });
  }
  // Executable startup hints identify the intended entry among incidental apps.
  // No command is run; imported module references must match discovered apps.
  const hinted = new Set();
  for (const { source } of [...manifests, ...files]) for (const match of source.matchAll(/\buvicorn(?:\s+|["']\s*,\s*["'])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*)/g)) {
    const [module, member] = match[1].split(':'); if (identifiers.test(module) && identifiers.test(member)) hinted.add(match[1]);
  }
  for (const { source } of files) for (const match of source.matchAll(/\buvicorn\s*\.\s*run\s*\(\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*)["']/g)) hinted.add(match[1]);
  const byDirectory = new Map();
  for (const row of rows) { const group = byDirectory.get(row.directory) || []; group.push(row); byDirectory.set(row.directory, group); }
  const selected = [];
  for (const group of byDirectory.values()) { const matches = group.filter(row => hinted.has(row.app)); selected.push(...(matches.length ? matches : group)); }
  return [...new Map(selected.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
module.exports = { detectPython };
