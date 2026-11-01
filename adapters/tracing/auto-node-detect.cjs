'use strict';
// Static discovery only: package scripts and application code are never executed.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const ignored = /^(?:node_modules|dist|build|out|coverage|target|vendor|venv|__pycache__|archives?)$/i;
function inside(root, file) {const rel = path.relative(root, file); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);}
async function detectNode(folder, _description, options = {}) {
  const root = await fs.realpath(folder), directories = [''], candidates = [];
  async function read(file, limit = 262144) {
    try {const real = await fs.realpath(file), stat = await fs.stat(real); if (!inside(root, real) || !stat.isFile() || stat.size > limit) return null; return await fs.readFile(real, 'utf8');} catch {return null;}
  }
  async function discover(directory) {
    try {for (const entry of (await fs.readdir(path.join(root, directory), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (directories.length >= 64) break;
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !ignored.test(entry.name)) directories.push(path.join(directory, entry.name));
    }} catch {}
  }
  await discover('');
  for (const directory of [...directories].filter(name => /^(?:apps|packages)$/.test(name))) await discover(directory);
  for (const directory of directories) {
    const raw = await read(path.join(root, directory, 'package.json'), 65536); if (!raw) continue;
    let manifest; try {manifest = JSON.parse(raw);} catch {continue;}
    const dependencies = {...manifest.dependencies, ...manifest.devDependencies};
    const scripts = [manifest.scripts?.dev, manifest.scripts?.start].filter(value => typeof value === 'string');
    const entries = [];
    for (const script of scripts) {
      // Shell operators, npm commands, lifecycle hooks and arbitrary Node flags
      // are deliberately excluded from the managed launch recipe.
      const match = script.match(/^\s*node\s+(?:--enable-source-maps\s+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>`$]+))\s*$/);
      if (match) entries.push(match[1] || match[2] || match[3]);
    }
    if (typeof manifest.main === 'string') entries.push(manifest.main);
    if (!entries.length && !scripts.length && (dependencies.express || dependencies.fastify || !dependencies.vite && !dependencies.next)) entries.push('server.js', 'server.cjs', 'index.js', 'index.cjs', 'app.js');
    const seen = new Set();
    for (const name of entries) {
      if (typeof name !== 'string' || !/\.(?:cjs|mjs|js)$/.test(name) || path.isAbsolute(name)) continue;
      const filename = path.resolve(root, directory, name); if (!inside(root, filename) || seen.has(filename)) continue;
      seen.add(filename);
      const source = await read(filename); if (!source) continue;
      const listenCount = [...source.matchAll(/\.listen\s*\(/g)].length;
      if (listenCount !== 1 || !/(?:node:http|['"]http['"]|['"]express['"]|['"]fastify['"])/.test(source) || /(?:node:https|['"]https['"])/.test(source)) continue;
      const portMatch = source.match(/\.listen\s*\(\s*(\d{2,5})(?:\s*[,)]|\s*$)/), originalPort = portMatch ? Number(portMatch[1]) : null;
      const actual = await fs.realpath(filename), relative = path.relative(root, actual).replaceAll('\\','/');
      candidates.push({id:'node-' + createHash('sha256').update(relative).digest('hex').slice(0,16), directory:directory.replaceAll('\\','/') || '.', framework:'Node.js', entry:actual, arguments:[], minimumNode:'24.13.0', ...(options.node ? {node:options.node,runtime:options.node}:{}), originalPort:originalPort > 0 && originalPort <= 65535 ? originalPort : null, adapter:'Automatic Node HTTP request and SQL capture; direct built-in SQLite result rows retain field origins.', limitations:['Copied or computed row fields do not retain automatic column provenance.','Custom server launchers, multiple listeners and TLS listeners require an explicit launch configuration.']});
      break;
    }
  }
  return candidates;
}
module.exports = {detectNode};
