'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceStore, MAX_WORKSPACES } = require('../product-store.cjs');
const { diagnosticReport, redactDiagnosticText } = require('../product-diagnostics.cjs');
async function profile(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orivo-store-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
const project = (index = 0) => ({ name: 'Project ' + index, url: `http://localhost:${5000 + index}/`, repositoryPath: path.join(os.tmpdir(), 'orivo-project-' + index) });

test('workspaces survive restart without persisting source, trace payloads or arbitrary fields', async t => {
  const directory = await profile(t), store = createWorkspaceStore(directory);
  const saved = await store.save({ ...project(), source: 'PRIVATE SOURCE', traces: ['SQL SECRET'] });
  const reopened = createWorkspaceStore(directory);
  assert.deepEqual(await reopened.get(saved.id), saved);
  const serialized = await fs.readFile(path.join(directory, 'workspaces.json'), 'utf8');
  assert.ok(!serialized.includes('PRIVATE SOURCE') && !serialized.includes('SQL SECRET'));
  const list = await reopened.list(); list[0].name = 'changed externally';
  assert.equal((await reopened.get(saved.id)).name, 'Project 0');
});
test('concurrent saves stay bounded and repeat project saves retain their identity', async t => {
  const store = createWorkspaceStore(await profile(t));
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.save(project(index))));
  const list = await store.list(); assert.equal(list.length, MAX_WORKSPACES);
  const record = list[0], updated = await store.save({ ...record, name: 'Renamed project' });
  assert.equal(updated.id, record.id); assert.equal((await store.list()).length, MAX_WORKSPACES);
  await store.remove(record.id);
  await assert.rejects(store.get(record.id), /no longer saved/);
});

test('automatic workspaces retain detected selections and identity across ephemeral ports without exposing mutable metadata', async t => {
  const directory = await profile(t), store = createWorkspaceStore(directory);
  const attachment = { frontend: 'frontend:.', backend: 'python:backend:app.main:app' };
  const saved = await store.save({ ...project(), attachment });
  attachment.backend = 'mutated'; saved.attachment.frontend = 'mutated';
  const reopened = createWorkspaceStore(directory), first = (await reopened.list())[0];
  assert.equal(first.attachment.frontend, 'frontend:.');
  assert.equal(first.attachment.backend, 'python:backend:app.main:app');
  const updated = await reopened.save({ ...first, url: 'http://localhost:55555/' });
  assert.equal(updated.id, first.id);
  assert.equal((await reopened.list()).length, 1);
  const copy = await reopened.get(first.id); copy.attachment.backend = 'mutated';
  assert.equal((await reopened.get(first.id)).attachment.backend, 'python:backend:app.main:app');
  await assert.rejects(reopened.save({ ...project(), attachment: { ...first.attachment, command: 'arbitrary' } }), /attachment/);
});
test('invalid workspace URLs and source paths cannot enter persistent storage', async t => {
  const store = createWorkspaceStore(await profile(t));
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'https://user:password@example.com/', 'http://remote.example/']) await assert.rejects(store.save({ ...project(), url }));
  await assert.rejects(store.save({ ...project(), repositoryPath: '../arbitrary-folder' }));
  await assert.rejects(store.get('../../anything'));
  assert.deepEqual(await store.list(), []);
});
test('corrupt workspace metadata remains recoverable and does not block the app', async t => {
  const directory = await profile(t), broken = '{broken JSON';
  await fs.writeFile(path.join(directory, 'workspaces.json'), broken);
  const store = createWorkspaceStore(directory);
  assert.deepEqual(await store.list(), []); assert.match(await store.warning(), /preserved/);
  await store.save(project());
  const backup = (await fs.readdir(directory)).find(name => name.startsWith('workspaces.recovered-'));
  assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), broken);
  assert.equal(await store.warning(), null);
});
test('oversized or future workspace formats are not automatically reopened', async t => {
  const directory = await profile(t);
  for (const value of ['x'.repeat(130 * 1024), JSON.stringify({ version: 99, workspaces: [] })]) {
    await fs.writeFile(path.join(directory, 'workspaces.json'), value);
    const store = createWorkspaceStore(directory); assert.deepEqual(await store.list(), []); assert.ok(await store.warning());
  }
});
test('diagnostic export omits private source, queries, paths, URL credentials and query tokens', () => {
  const report = diagnosticReport({ version: '0.1.0', packaged: true, state: { url: 'https://example.com/private/customer?token=HIDDEN', repository: { name: 'PRIVATE PROJECT', path: 'C:\\Private\\Repo', fileCount: 12 }, query: 'SELECT PRIVATE SQL' }, errors: [{ at: '2026-10-17T00:00:00.000Z', message: 'C:\\Private\\Repo SELECT PRIVATE SQL Authorization: Bearer HIDDEN' }] });
  const serialized = JSON.stringify(report);
  for (const text of ['PRIVATE', 'HIDDEN', 'customer', 'Bearer', 'C:\\']) assert.ok(!serialized.includes(text), text);
  assert.equal(report.workspace.applicationOrigin, 'https://example.com'); assert.equal(report.workspace.indexedFiles, 12);
  assert.equal(report.recentErrors.length, 1);
  assert.ok(!redactDiagnosticText('https://user:password@example.com/a?token=SECRET C:\\Users\\Private\\file').includes('SECRET'));
});
