import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release builder currently supports Linux x64 only.');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.productName !== 'Orivo') throw new Error('Expected a semver Orivo package.');
const runtime = path.dirname(require('electron'));
const runtimeVersion = (await readFile(path.join(runtime, 'version'), 'utf8')).trim();
if (runtimeVersion !== pkg.devDependencies.electron) throw new Error(`Electron runtime ${runtimeVersion} differs from the locked dependency.`);

const releases = path.join(root, 'dist', 'releases');
const name = `Orivo-${pkg.version}-beta-linux-x64`;
const destination = path.join(releases, name);
const scratch = path.join(root, '.tmp', `release-build-${process.pid}-${Date.now()}`);
const staging = path.join(scratch, name);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-4000)}`)));
  });
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function removeRelease(file) {
  const relative = path.relative(releases, path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to replace a path outside the release directory.');
  await rm(file, { recursive: true, force: true });
}

async function safeCopy(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Release inputs must not be symlinks: ${source}`);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry.startsWith('.') || ['node_modules', '__pycache__', 'evidence', 'test', 'package-lock.json'].includes(entry)) continue;
      await safeCopy(path.join(source, entry), path.join(target, entry));
    }
  } else if (info.isFile()) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(file, relative + '/'));
    else files.push({ path: relative, ...await hashFile(file) });
  }
  return files;
}

await mkdir(staging, { recursive: true });
await mkdir(releases, { recursive: true });
for (const entry of await readdir(runtime)) {
  if (entry === 'resources' || entry.startsWith('.')) continue;
  await safeCopy(path.join(runtime, entry), path.join(staging, entry));
}
if (!await exists(path.join(staging, 'electron'))) throw new Error('The Linux Electron runtime executable is missing.');
await rename(path.join(staging, 'electron'), path.join(staging, 'Orivo'));

const application = path.join(staging, 'resources', 'app');
await mkdir(application, { recursive: true });
for (const entry of ['main.cjs', 'host-security.cjs', 'product-store.cjs', 'product-diagnostics.cjs', 'trace-store.cjs', 'editor-source.cjs', 'trace-health.cjs', 'project-map-store.cjs', 'page-runtime.cjs', 'session-navigation.cjs', 'diagram-studio.cjs', 'trace-to-diagram.cjs', 'preload.cjs', 'renderer', 'engine', 'adapters', 'demo', 'vendor', 'THIRD_PARTY_NOTICES.md']) await safeCopy(path.join(root, entry), path.join(application, entry));
await writeFile(path.join(application, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, license: pkg.license, releaseChannel: 'beta' }, null, 2) + '\n');
for (const entry of await readdir(path.join(root, 'resources'))) if (entry !== 'ai') await safeCopy(path.join(root, 'resources', entry), path.join(application, 'resources', entry));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'));
await cp(path.join(root, 'docs', 'RELEASE.md'), path.join(staging, 'RELEASE.md'));
await writeFile(path.join(staging, 'START-HERE.txt'), `ORIVO ${pkg.version} BETA — LINUX x64\n\nExtract this entire folder, then run ./Orivo from the extracted folder.\nKeep the bundled files together. No separate Node.js or npm installation is needed.\n\nUse Orivo only with local development projects.\nThis beta is unsigned and has no automatic update service.\n`);

const files = await inventory(staging);
const manifest = { schemaVersion: 1, product: 'Orivo', version: pkg.version, releaseChannel: 'beta', platform: 'linux', architecture: 'x64', electron: runtimeVersion, builtAt: new Date().toISOString(), distribution: 'portable-tar-gz', requiresNode: false, codeSigning: { signed: false, publisher: null }, automaticUpdates: false, files };
await writeFile(path.join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (await exists(destination)) await removeRelease(destination);
await rename(staging, destination);
const archive = path.join(releases, name + '.tar.gz');
if (await exists(archive)) await removeRelease(archive);
await run('tar', ['-C', releases, '-czf', archive, name]);
const archiveDigest = await hashFile(archive);
const releaseManifest = { ...manifest, files: undefined, fileCount: files.length, uncompressedBytes: files.reduce((total, file) => total + file.bytes, 0), archive: { file: path.basename(archive), ...archiveDigest } };
const manifestFile = path.join(releases, name + '.manifest.json');
await writeFile(manifestFile, JSON.stringify(releaseManifest, null, 2) + '\n');
const manifestDigest = await hashFile(manifestFile);
await writeFile(path.join(releases, 'SHA256SUMS.txt'), `${archiveDigest.sha256}  ${path.basename(archive)}\n${manifestDigest.sha256}  ${path.basename(manifestFile)}\n`);
console.log(JSON.stringify({ built: true, executable: path.join(destination, 'Orivo'), archive, archiveBytes: archiveDigest.bytes, fileCount: files.length, sha256: archiveDigest.sha256, signed: false, channel: 'beta' }, null, 2));
