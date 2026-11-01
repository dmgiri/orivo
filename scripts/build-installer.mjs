import { mkdir, readFile, readdir, rm, rename, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Orivo installer builder currently supports Windows x64 only.');
}

const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseName = `Orivo-${packageInfo.version}-beta-win32-x64`;
const releaseDirectory = path.join(root, 'dist', 'releases', releaseName);
const releasesDirectory = path.dirname(releaseDirectory);
const setupName = `${releaseName}-Setup.exe`;
const setupPath = path.join(releasesDirectory, setupName);
const manifestPath = path.join(releaseDirectory, 'release-manifest.json');
const releaseManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (releaseManifest.product !== 'Orivo' || releaseManifest.version !== packageInfo.version) {
  throw new Error('Build the matching Orivo Windows release before building its installer.');
}

const sevenZip = path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
const windowsDirectory = process.env.WINDIR || 'C:\\Windows';
const compiler = path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
for (const required of [sevenZip, compiler, path.join(root, 'resources', 'orivo.ico')]) {
  if (!(await exists(required))) throw new Error(`Required Windows installer build tool is missing: ${required}`);
}

const scratch = path.join(root, '.tmp', `installer-build-${process.pid}-${Date.now()}`);
const payloadZip = path.join(scratch, 'Orivo-payload.zip');
const sourceTemplate = path.join(root, 'scripts', 'installer', 'OrivoSetup.cs');
const uninstallerSource = path.join(root, 'scripts', 'installer', 'Uninstall-Orivo.ps1');
const securityManifest = path.join(scratch, 'as-invoker.manifest');
const compiledSource = path.join(scratch, 'OrivoSetup.cs');
const compiledSetup = path.join(scratch, setupName);
const smokeDirectory = path.join(scratch, 'payload-verification');

await mkdir(scratch, { recursive: true });
try {
  await run(sevenZip, ['a', '-tzip', '-mx=1', '-mmt=on', payloadZip, '*'], { cwd: releaseDirectory });

  const template = await readFile(sourceTemplate, 'utf8');
  if (!template.includes('__PACKAGE_VERSION__')) throw new Error('The installer source is missing its version marker.');
  await writeFile(compiledSource, template
    .replaceAll('__PACKAGE_VERSION__', packageInfo.version)
    .replaceAll('__ASSEMBLY_VERSION__', `${packageInfo.version}.0`));
  await writeFile(securityManifest, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n' +
    '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
    '<requestedExecutionLevel level="asInvoker" uiAccess="false" />' +
    '</requestedPrivileges></security></trustInfo>\n' +
    '</assembly>\n');

  await run(compiler, [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    `/out:${compiledSetup}`,
    `/win32icon:${path.join(root, 'resources', 'orivo.ico')}`,
    `/win32manifest:${securityManifest}`,
    `/resource:${payloadZip},OrivoPayload.zip`,
    `/resource:${uninstallerSource},OrivoUninstaller.ps1`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:System.Runtime.Serialization.dll',
    '/reference:System.Security.dll',
    compiledSource,
  ], { cwd: root });

  await mkdir(smokeDirectory, { recursive: true });
  await run(compiledSetup, ['--verify-payload', smokeDirectory], { cwd: root, timeoutMs: 300000 });
  const expectedFiles = releaseManifest.files;
  for (const file of expectedFiles) {
    const actualPath = safeReleasePath(smokeDirectory, file.path);
    const actualInfo = await stat(actualPath);
    if (actualInfo.size !== file.bytes || await sha256File(actualPath) !== file.sha256) {
      throw new Error(`Installer payload verification failed for ${file.path}`);
    }
  }
  if (!(await exists(path.join(smokeDirectory, 'Uninstall-Orivo.ps1')))) {
    throw new Error('Installer payload verification did not include the uninstaller.');
  }

  await mkdir(releasesDirectory, { recursive: true });
  await rm(setupPath, { force: true });
  await rename(compiledSetup, setupPath);
  const setupInfo = await stat(setupPath);
  const setupHash = await sha256File(setupPath);
  const setupManifestName = `${releaseName}-Setup.manifest.json`;
  const setupManifest = {
    schemaVersion: 1,
    product: 'Orivo',
    version: packageInfo.version,
    releaseChannel: 'beta',
    platform: 'win32',
    architecture: 'x64',
    artifact: setupName,
    bytes: setupInfo.size,
    sha256: setupHash,
    signed: false,
    installer: {
      scope: 'per-user',
      administratorRequired: false,
      startMenuShortcut: true,
      desktopShortcut: 'optional',
      uninstaller: true,
      preservesUserSettings: true,
      validatesPayloadChecksums: true,
    },
    builtAt: new Date().toISOString(),
  };
  await writeFile(path.join(releasesDirectory, setupManifestName), JSON.stringify(setupManifest, null, 2) + '\n');

  const sumsFile = path.join(releasesDirectory, 'SHA256SUMS.txt');
  const sums = (await exists(sumsFile) ? await readFile(sumsFile, 'utf8') : '')
    .split(/\r?\n/)
    .filter((line) => line && !line.endsWith(`  ${setupName}`) && !line.endsWith(`  ${setupManifestName}`));
  sums.push(`${setupHash}  ${setupName}`);
  sums.push(`${sha256(await readFile(path.join(releasesDirectory, setupManifestName)))}  ${setupManifestName}`);
  await writeFile(sumsFile, sums.join('\n') + '\n');

  console.log(JSON.stringify({
    built: true,
    installer: setupPath,
    bytes: setupInfo.size,
    sha256: setupHash,
    payloadFiles: expectedFiles.length,
    signed: false,
    channel: 'beta',
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeReleasePath(directory, relativePath) {
  const destination = path.resolve(directory, relativePath);
  const prefix = path.resolve(directory) + path.sep;
  if (!destination.startsWith(prefix)) throw new Error(`Unsafe release manifest path: ${relativePath}`);
  return destination;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    const timeout = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { if (timeout) clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} exited ${code}: ${output.slice(-5000)}`));
    });
  });
}
