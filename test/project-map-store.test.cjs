'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createProjectMapStore} = require('../project-map-store.cjs');

async function directories(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'orivo-map-store-'));
  const root = path.join(parent, 'connected-project'), profile = path.join(parent, 'profile-data');
  await fs.mkdir(root);
  t.after(async () => {assert.ok(path.basename(parent).startsWith('orivo-map-store-')); await fs.rm(parent, {recursive: true, force: true});});
  return {root, profile};
}
function map(fingerprint = 'a'.repeat(64)) {
  return {
    version: 1, fingerprint, projectName: 'connected-project', generatedAt: new Date().toISOString(),
    files: [{path: 'src/view.js', hash: 'b'.repeat(64), bytes: 10, lineCount: 1, language: 'javascript', analyzed: true}],
    languages: [{name: 'javascript', files: 1}], frameworks: [], symbols: [], references: [],
    summary: {sourceFiles: 1, analyzedFiles: 1, analyzedBytes: 10, symbols: 0, references: 0, parseFailures: 0, skippedByLimit: 0, skippedBySourceIndex: {}, sourceIndexTruncated: false, analysisLimited: false},
    limits: {analysisBytes: 100, symbols: 20, references: 20, mapBytes: 6 * 1024 * 1024},
  };
}

test('project map cache is outside the source root, fingerprinted, bounded and clearable', async t => {
  const {root, profile} = await directories(t), store = createProjectMapStore(profile), value = map();
  await store.save(root, value);
  assert.deepEqual(await store.load(root, value.fingerprint), value);
  assert.equal(await store.load(root, 'c'.repeat(64)), null);
  const files = await fs.readdir(profile);
  assert.equal(files.length, 1);
  const serialized = await fs.readFile(path.join(profile, files[0]), 'utf8');
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('PRIVATE'), false);
  await store.clear(root);
  assert.deepEqual(await fs.readdir(profile), []);
});

test('project map cache rejects source payloads and malformed metadata', async t => {
  const {root, profile} = await directories(t), store = createProjectMapStore(profile);
  await assert.rejects(store.save(root, {...map(), sourceText: 'should never persist'}), /invalid/);
  await store.save(root, map());
  const file = path.join(profile, (await fs.readdir(profile))[0]);
  await fs.writeFile(file, JSON.stringify({version: 1, fingerprint: 'a'.repeat(64), source: 'not a project map'}));
  assert.equal(await store.load(root, 'a'.repeat(64)), null);
});
