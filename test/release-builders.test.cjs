const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('v0.1 release builders are model-free for Windows and Linux', () => {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const windowsBuilder = fs.readFileSync(path.join(root, 'scripts', 'build-win.mjs'), 'utf8');
  const linuxBuilder = fs.readFileSync(path.join(root, 'scripts', 'build-linux.mjs'), 'utf8');

  assert.equal(packageInfo.scripts['build:win'], 'node scripts/build-win.mjs');
  assert.equal(packageInfo.scripts['build:linux'], 'node scripts/build-linux.mjs');
  assert.doesNotMatch(windowsBuilder, /verifyPreparedAssets|MODEL_ASSET|RUNTIME_ASSET|offlineAi/i);
  assert.doesNotMatch(linuxBuilder, /verifyPreparedAssets|MODEL_ASSET|RUNTIME_ASSET|offlineAi/i);
  assert.ok(fs.existsSync(path.join(root, 'docs', 'RELEASE.md')));
});

test('release builders are valid Node ES modules', () => {
  for (const builder of ['build-win.mjs', 'build-linux.mjs']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, 'scripts', builder)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Windows builder can resolve the Electron package from an ES module', () => {
  const windowsBuilder = fs.readFileSync(path.join(root, 'scripts', 'build-win.mjs'), 'utf8');
  assert.match(windowsBuilder, /import \{ createRequire \} from 'node:module';/);
  assert.match(windowsBuilder, /const require=createRequire\(import\.meta\.url\);/);
});

test('Windows builder includes the per-user setup executable', () => {
  const windowsBuilder = fs.readFileSync(path.join(root, 'scripts', 'build-win.mjs'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'installer', 'OrivoSetup.cs')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'installer', 'Uninstall-Orivo.ps1')));
  assert.match(windowsBuilder, /build-installer\.mjs/);
});
