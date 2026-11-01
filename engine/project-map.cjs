'use strict';

const path = require('node:path');
const {createHash} = require('node:crypto');

const MAP_VERSION = 1;
const LIMITS = Object.freeze({analysisBytes: 16 * 1024 * 1024, symbols: 20000, references: 25000, mapBytes: 6 * 1024 * 1024});
let parserPromise;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function extension(name) { return path.posix.extname(name).toLowerCase(); }
function languageOf(name) {
  const ext = extension(name);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.py') return 'python';
  if (ext === '.sql') return 'sql';
  if (ext === '.prisma') return 'prisma';
  if (['.vue', '.svelte'].includes(ext)) return 'component-template';
  return ext.slice(1) || 'text';
}
function sourceFingerprint(index) {
  if (!index || !Array.isArray(index.files)) throw Error('A source index is required.');
  const rows = index.files.map(file => `${file.path}\0${file.hash}`).sort();
  return digest(rows.join('\n'));
}
function lineAt(text, offset) { return text.slice(0, Math.max(0, offset)).split('\n').length; }
function identifier(value) { return /^[A-Za-z_$][\w$]*$/.test(value || ''); }

function astWalk(root, visit) {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) pending.push(node[i]); continue; }
    if (typeof node.type !== 'string') continue;
    if (++count > 200000) return false;
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'extra'].includes(key)) continue;
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return true;
}

function resolveLocalImport(source, fromPath, fileSet) {
  if (typeof source !== 'string' || !source.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), source));
  if (!base || base.startsWith('../') || base === '..' || base.startsWith('/')) return null;
  for (const candidate of [base, ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py'].map(ext => base + ext), ...['index.js', 'index.jsx', 'index.ts', 'index.tsx', 'index.py'].map(file => `${base}/${file}`)]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function sqlFacts(text, file, addSymbol, addReference) {
  const patterns = [
    {kind: 'SELECT', re: /\bSELECT\s+([\s\S]{1,500}?)\s+FROM\s+([`"\w.]+)/ig},
    {kind: 'INSERT', re: /\bINSERT\s+INTO\s+([`"\w.]+)(?:\s*\(([^)]{1,400})\))?/ig},
    {kind: 'UPDATE', re: /\bUPDATE\s+([`"\w.]+)\s+SET\s+([\s\S]{1,400}?)(?:\bWHERE\b|$)/ig},
    {kind: 'DELETE', re: /\bDELETE\s+FROM\s+([`"\w.]+)/ig},
    {kind: 'CREATE TABLE', re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)/ig},
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const table = (pattern.kind === 'SELECT' ? match[2] : match[1])?.replace(/^[`"]|[`"]$/g, '') || '';
      if (!/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(table)) continue;
      const line = lineAt(text, match.index), key = `${line}:${pattern.kind}:${table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const query = addSymbol(pattern.kind === 'CREATE TABLE' ? 'sql-ddl' : 'sql-query', `${pattern.kind}${pattern.kind === 'CREATE TABLE' ? '' : ` ${table}`}`, file, line);
      const tableSymbol = addSymbol('sql-table', table, file, line);
      if (pattern.kind !== 'CREATE TABLE' && query && tableSymbol) addReference('query-table', query, tableSymbol, 'candidate');
      let columns = [];
      if (pattern.kind === 'SELECT') columns = (match[1] || '').split(',').map(item => item.trim()).filter(item => /^(?:[`"]?[A-Za-z_][\w$]*[`"]?\.)?[`"]?[A-Za-z_][\w$]*[`"]?$/.test(item)).map(item => item.split('.').at(-1).replace(/[`"\s]/g, ''));
      else if (pattern.kind === 'INSERT') columns = (match[2] || '').split(',').map(item => item.trim().replace(/[`"\s]/g, '')).filter(item => /^[A-Za-z_][\w$]*$/.test(item));
      else if (pattern.kind === 'UPDATE') columns = [...(match[2] || '').matchAll(/(?:^|,)\s*[`"]?([A-Za-z_][\w$]*)[`"]?\s*=/g)].map(item => item[1]);
      for (const column of [...new Set(columns)].slice(0, 40)) {
        const columnSymbol = addSymbol('sql-column', `${table}.${column}`, file, line);
        if (query && columnSymbol) addReference('query-column', query, columnSymbol, 'candidate');
      }
    }
  }
}

function pythonFacts(text, file, addSymbol, addReference) {
  const lines = text.split('\n');
  const imports = /^(?:\s*)(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+([\w., ]+))/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], number = i + 1;
    if (/^\s*#/.test(line)) continue;
    let match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (match) addSymbol('function', match[1], file, number);
    match = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
    if (match) {
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
      const body = lines.slice(i + 1, end).join('\n');
      const isModel = /\b(?:DeclarativeBase|SQLModel|Base)\b/.test(match[2] || '') || /__tablename__\s*=|\b(?:mapped_column|Column)\s*\(/.test(body);
      const model = addSymbol(isModel ? 'orm-model' : 'class', match[1], file, number);
      if (isModel) {
        const fieldPattern = /^\s*([A-Za-z_]\w*)\s*(?::\s*[^=\n]+)?=\s*(?:mapped_column|Column|relationship)\s*\(/gm;
        for (const field of body.matchAll(fieldPattern)) {
          const fieldLine = number + lineAt(body, field.index) - 1;
          const symbol = addSymbol('orm-field', `${match[1]}.${field[1]}`, file, fieldLine);
          if (model && symbol) addReference('model-field', model, symbol, 'candidate');
        }
      }
    }
    match = line.match(/^\s*@(?:[A-Za-z_]\w*\.)?(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/i);
    if (match) addSymbol('route', `${match[1].toUpperCase()} ${match[3]}`, file, number);
    match = line.match(imports);
    if (match) {
      const target = match[1] || (match[3] || '').split(',')[0].trim();
      if (target) addReference('import', {path: file.path, line: number, hash: file.hash}, {name: target, path: null}, 'candidate');
    }
  }
  sqlFacts(text, file, addSymbol, addReference);
}

function prismaFacts(text, file, addSymbol, addReference) {
  const lines = text.split('\n');
  let model = null, modelIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], number = i + 1;
    const start = line.match(/^\s*model\s+([A-Za-z_]\w*)\s*\{/);
    if (start) {model = addSymbol('orm-model', start[1], file, number); modelIndent = line.match(/^\s*/)[0].length; continue;}
    if (model && line.trim() === '}') {model = null; modelIndent = -1; continue;}
    if (!model || !line.trim() || /^\s*\/\//.test(line)) continue;
    const field = line.match(/^\s*([A-Za-z_]\w*)\s+([\w\[\]?]+)/);
    if (field && !field[1].startsWith('@')) {
      const symbol = addSymbol('orm-field', `${model.name}.${field[1]}`, file, number);
      if (symbol) addReference('model-field', model, symbol, 'candidate');
    }
  }
}

function findFrameworks(index, symbols) {
  const found = new Map();
  const add = (name, source) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(source);
  };
  for (const file of index.files) {
    const text = file.text || '';
    const ext = extension(file.path);
    if (ext === '.jsx' || ext === '.tsx' || /from\s+['"]react['"]/.test(text)) add('React', file.path);
    if (/vite\.config\.[cm]?[jt]s$/.test(file.path) || /["']vite["']\s*:/.test(text)) add('Vite', file.path);
    if (/next\.config\.[cm]?[jt]s$/.test(file.path) || /["']next["']\s*:/.test(text) || /from\s+['"]next\//.test(text)) add('Next.js', file.path);
    if (/\bfrom\s+fastapi\b|\bimport\s+fastapi\b/.test(text)) add('FastAPI', file.path);
    if (/\bfrom\s+starlette\b|\bimport\s+starlette\b/.test(text)) add('Starlette', file.path);
    if (/\b(?:sqlalchemy|mapped_column|DeclarativeBase)\b/i.test(text)) add('SQLAlchemy', file.path);
    if (/\b(?:psycopg|asyncpg|postgresql)\b/i.test(text)) add('PostgreSQL client or schema', file.path);
    if (/\b(?:from\s+['"]pg['"]|require\s*\(\s*['"]pg['"])/.test(text)) add('Node pg', file.path);
    if (ext === '.prisma' || /@prisma\/client/.test(text)) add('Prisma', file.path);
    if (/\bCREATE\s+TABLE\b/i.test(text)) add('SQL schema', file.path);
  }
  if (symbols.some(symbol => symbol.kind === 'component')) add('React component syntax', symbols.find(symbol => symbol.kind === 'component').path);
  return [...found].map(([name, sources]) => ({name, sourceFiles: [...sources].sort().slice(0, 20), status: 'found-in-source'})).sort((a, b) => a.name.localeCompare(b.name));
}

async function buildProjectMap(index) {
  if (!index || typeof index.root !== 'string' || !Array.isArray(index.files)) throw Error('Connect and index a repository first.');
  const files = [], symbols = [], references = [], symbolKeys = new Map(), referenceKeys = new Map();
  const fileSet = new Set(index.files.map(file => file.path));
  let analyzedBytes = 0, analyzedFiles = 0, skippedByLimit = 0, parseFailures = 0, limited = false;
  const addSymbol = (kind, name, file, line, endLine = line) => {
    if (symbols.length >= LIMITS.symbols || typeof name !== 'string' || !name.trim() || !Number.isInteger(line) || line < 1) return null;
    const key = `${file.path}\0${line}\0${kind}\0${name}`;
    if (symbolKeys.has(key)) return symbolKeys.get(key);
    const id = digest(key).slice(0, 24);
    const row = {id, kind, name: name.trim().slice(0, 240), path: file.path, line, endLine: Math.max(line, endLine), language: file.language, hash: file.hash, status: 'found-in-source', _key: key};
    symbols.push(row);
    symbolKeys.set(key, row);
    return row;
  };
  const addReference = (kind, from, to, status) => {
    if (references.length >= LIMITS.references) {limited = true; return null;}
    const source = from?.path ? from : null, targetPath = typeof to?.path === 'string' ? to.path : null;
    if (!source || !Number.isInteger(source.line) || !source.hash || !to || typeof to.name !== 'string') return null;
    const key = `${kind}\0${source.path}\0${source.line}\0${targetPath || ''}\0${to.name}\0${status}`;
    if (referenceKeys.has(key)) return referenceKeys.get(key);
    const id = digest(key).slice(0, 24);
    const row = {id, kind, from: {path: source.path, line: source.line, hash: source.hash}, target: {name: String(to.name || '').slice(0, 240), ...(targetPath ? {path: targetPath, hash: to.hash} : {})}, status, _key: key};
    references.push(row);
    referenceKeys.set(key, row);
    return row;
  };
  const addFileReference = (kind, file, line, name, targetPath = null) => addReference(kind, {path: file.path, line, hash: file.hash}, {name, path: targetPath, ...(targetPath ? {hash: index.files.find(row => row.path === targetPath)?.hash} : {})}, 'candidate');

  for (const source of index.files) {
    const language = languageOf(source.path), file = {path: source.path, hash: source.hash, bytes: source.bytes, lineCount: (source.text || '').split('\n').length, language, analyzed: false};
    files.push(file);
    if (analyzedBytes + (source.bytes || 0) > LIMITS.analysisBytes || symbols.length >= LIMITS.symbols) {skippedByLimit++; limited = true; continue;}
    analyzedBytes += source.bytes || 0;
    const text = source.text || '';
    if (['javascript', 'typescript'].includes(language)) {
      try {
        parserPromise ||= import('../adapters/tracing/parser.mjs').then(module => module.parseSync);
        const parseSync = await parserPromise;
        const parsed = parseSync(source.path, text);
        if (!parsed.program) {parseFailures++; continue;}
        for (const issue of parsed.errors || []) {if (issue) {parseFailures++; break;}}
        const jsxRanges = [];
        const nodes = [];
        const complete = astWalk(parsed.program, node => {nodes.push(node); if (node.type === 'JSXElement' || node.type === 'JSXFragment') jsxRanges.push([node.start, node.end]);});
        if (!complete) {limited = true; skippedByLimit++; continue;}
        const declarations = new Map();
        for (const node of nodes) {
          const loc = node.loc?.start?.line || lineAt(text, node.start);
          const endLine = node.loc?.end?.line || loc;
          if (node.type === 'FunctionDeclaration' && node.id?.name) declarations.set(node.id.name, {node, line: loc, endLine});
          if (node.type === 'ClassDeclaration' && node.id?.name) addSymbol('class', node.id.name, file, loc, endLine);
          if (node.type === 'VariableDeclarator' && identifier(node.id?.name) && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) declarations.set(node.id.name, {node: node.init, line: loc, endLine: node.init.loc?.end?.line || endLine});
          if (node.type === 'ImportDeclaration' && typeof node.source?.value === 'string') {
            const target = resolveLocalImport(node.source.value, file.path, fileSet);
            addFileReference('import', file, loc, node.source.value, target);
          }
          if (node.type === 'CallExpression') {
            const callee = node.callee, prop = callee?.property?.name || (callee?.computed && callee.property?.value);
            const first = node.arguments?.[0];
            const literal = ['StringLiteral', 'Literal'].includes(first?.type) && typeof first.value === 'string' ? first.value : first?.type === 'TemplateLiteral' && first.expressions?.length === 0 ? first.quasis?.[0]?.value?.cooked : null;
            if (literal && (callee?.name === 'fetch' || (['get', 'post', 'put', 'patch', 'delete'].includes(prop) && ['axios', 'api', 'client', 'http'].includes(callee?.object?.name)))) {
              addSymbol('api-call', `${callee?.name === 'fetch' ? 'FETCH' : String(prop).toUpperCase()} ${literal}`, file, loc, endLine);
            }
            if (literal && ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(prop) && ['app', 'router', 'server', 'api'].includes(callee?.object?.name)) {
              addSymbol('route', `${String(prop).toUpperCase()} ${literal}`, file, loc, endLine);
            }
          }
        }
        for (const [name, declaration] of declarations) {
          const hasJsx = jsxRanges.some(([start, end]) => start >= declaration.node.start && end <= declaration.node.end);
          const kind = hasJsx && /^[A-Z]/.test(name) ? 'component' : 'function';
          addSymbol(kind, name, file, declaration.line, declaration.endLine);
        }
        file.analyzed = true;
      } catch {parseFailures++;}
    } else if (language === 'python') {
      pythonFacts(text, file, addSymbol, addReference);
      for (const match of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+/gm)) addFileReference('import', file, lineAt(text, match.index), match[1]);
      file.analyzed = true;
    } else if (language === 'prisma') {
      prismaFacts(text, file, addSymbol, addReference);
      file.analyzed = true;
    } else if (language === 'sql') {
      sqlFacts(text, file, addSymbol, addReference);
      file.analyzed = true;
    } else if (['json', 'toml', 'yaml', 'yml'].includes(language)) {
      file.analyzed = true;
    }
    if (file.analyzed) analyzedFiles++;
  }

  for (const symbol of symbols) delete symbol._key;
  for (const reference of references) delete reference._key;
  const languages = [...files.reduce((counts, file) => counts.set(file.language, (counts.get(file.language) || 0) + 1), new Map())].map(([name, count]) => ({name, files: count})).sort((a, b) => a.name.localeCompare(b.name));
  const normalized = {version: MAP_VERSION, fingerprint: sourceFingerprint(index), projectName: path.basename(index.root), generatedAt: new Date().toISOString(), files, languages, frameworks: findFrameworks(index, symbols), symbols, references, summary: {sourceFiles: files.length, analyzedFiles, analyzedBytes, symbols: symbols.length, references: references.length, parseFailures, skippedByLimit, skippedBySourceIndex: index.skipped, sourceIndexTruncated: index.truncated, analysisLimited: limited}, limits: LIMITS};
  let serialized = JSON.stringify(normalized);
  while (Buffer.byteLength(serialized) > LIMITS.mapBytes && (references.length || symbols.length)) {
    if (references.length) {
      const previous = references.length;
      references.splice(Math.max(0, Math.floor(references.length * 0.8)));
      skippedByLimit += previous - references.length;
    } else {
      const previous = symbols.length;
      symbols.splice(Math.max(0, Math.floor(symbols.length * 0.8)));
      skippedByLimit += previous - symbols.length;
    }
    limited = true;
    normalized.summary.references = references.length;
    normalized.summary.symbols = symbols.length;
    normalized.summary.skippedByLimit = skippedByLimit;
    normalized.summary.analysisLimited = true;
    serialized = JSON.stringify(normalized);
  }
  if (Buffer.byteLength(serialized) > LIMITS.mapBytes) throw Error('The bounded local project map exceeds its output limit. Reduce the indexed source scope and try again.');
  return normalized;
}

module.exports = {buildProjectMap, sourceFingerprint, MAP_VERSION, LIMITS};
