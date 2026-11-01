'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { detectPython } = require('../adapters/tracing/auto-python.cjs');
const temporary = path.resolve(__dirname, '../.tmp');
async function fixture(t, files) {
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'auto-python-detection-'));
  t.after(async () => { assert.equal(path.dirname(root), temporary); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, source] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), source); }
  return root;
}
test('detects src-layout factory and existing root environment without executing app code', async t => {
  const root = await fixture(t, {
    '.venv/Scripts/python.exe': 'unexecuted fixture executable',
    'backend/requirements.txt': 'fastapi\nsqlalchemy\n',
    'backend/src/catalog/main.py': 'from fastapi import FastAPI\nraise RuntimeError("Must not execute discovery")\ndef create_app(settings=None):\n    app = FastAPI()\n    return app\n',
    'backend/src/catalog/__init__.py': ''
  });
  const rows = await detectPython(root);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: 'python:backend:catalog.main:create_app', type: 'python', directory: 'backend', framework: 'FastAPI', app: 'catalog.main:create_app', factory: true, python: path.join(root, '.venv/Scripts/python.exe'), sourcePaths: [path.join(root, 'backend/src'), path.join(root, 'backend')], issue: null });
  assert.deepEqual(await fs.readdir(root), ['.venv', 'backend']);
});
test('does not select examples, comments, tests or excluded trees as applications', async t => {
  const root = await fixture(t, {
    'main.py': '# from fastapi import FastAPI\n# app=FastAPI()\ntext="""from fastapi import FastAPI\napp=FastAPI()\n"""\n',
    'tests/main.py': 'from fastapi import FastAPI\napp=FastAPI()\n',
    'node_modules/hidden/main.py': 'from fastapi import FastAPI\napp=FastAPI()\n',
    '.cache/main.py': 'from fastapi import FastAPI\napp=FastAPI()\n'
  });
  assert.deepEqual(await detectPython(root), []);
});
test('reports multiple independent apps and missing environment rather than choosing a global Python', async t => {
  const root = await fixture(t, {
    'api.py': 'from fastapi import FastAPI as API\napp = API()\n',
    'other.py': 'from starlette.applications import Starlette\napplication = Starlette()\n'
  });
  const rows = await detectPython(root);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.python === null && /\.venv/.test(row.issue)));
  assert.deepEqual(rows.map(row => row.app), ['api:app', 'other:application']);
});
test('uses a matching startup hint and avoids duplicate app/factory candidates', async t => {
  const root = await fixture(t, {
    'pyproject.toml': '[project]\ndependencies=["fastapi"]\n',
    'package.json': JSON.stringify({ scripts: { backend: 'uvicorn main:app --port 8000' } }),
    'main.py': 'import fastapi as framework\ndef create_app():\n    return framework.FastAPI()\napp = create_app()\n',
    'alternate.py': 'from fastapi import FastAPI\napp=FastAPI()\n'
  });
  const rows = await detectPython(root);
  assert.equal(rows.length, 1); assert.equal(rows[0].app, 'main:app'); assert.equal(rows[0].factory, false);
});
