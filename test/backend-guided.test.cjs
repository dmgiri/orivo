'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGuidedSetup } = require('../adapters/tracing/guided.cjs');

const temporaryRoot = path.resolve(__dirname, '../.tmp');
const base = '.orivo-tracing/backend';
const options = { backendOnly: true, appOrigin: 'http://localhost:5173', backend: { directory: 'backend', app: 'service.main:create_app', factory: true, engine: '@app.state.database.engine', sessions: '@app.state.database.session_factory', instrument: true } };
const application = `from contextlib import asynccontextmanager
from types import SimpleNamespace
from builtins import _orivo_test_events as events
events.append('application import')
def create_app():
    events.append('factory')
    app = SimpleNamespace(state=SimpleNamespace())
    @asynccontextmanager
    async def lifespan(application):
        events.append('lifespan enter')
        application.state.database = SimpleNamespace(engine=SimpleNamespace(sync_engine='SYNC_ENGINE'), session_factory='SESSIONS')
        try:
            yield {'original': 'state'}
        finally:
            events.append('lifespan exit')
    app.router = SimpleNamespace(lifespan_context=lifespan)
    return app
`;

async function project(t) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'test-backend-guided-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), temporaryRoot); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(root, 'backend/src/service'), { recursive: true });
  const manifest = JSON.stringify({ name: 'existing-frontend', scripts: { dev: 'vite --port 5173' }, dependencies: { react: '19.3.0' }, devDependencies: { vite: '8.3.3' } }, null, 2) + '\n';
  const vite = "// The existing integration must be preserved.\nexport default {plugins:['existing tracing plugin']};\n";
  await fs.writeFile(path.join(root, 'frontend/package.json'), manifest);
  await fs.writeFile(path.join(root, 'frontend/vite.config.mjs'), vite);
  await fs.writeFile(path.join(root, 'backend/requirements.txt'), 'fastapi\nsqlalchemy\n');
  await fs.writeFile(path.join(root, 'backend/src/service/__init__.py'), '');
  await fs.writeFile(path.join(root, 'backend/src/service/main.py'), application);
  return { root, manifest, vite };
}

async function runWrapper(root, { failEngine = false } = {}) {
  const script = `import asyncio, builtins, importlib.util, json, sys, types
events = []
builtins._orivo_test_events = events
sdk = types.ModuleType('studio_tracing')
def instrument_project(root, include):
    events.append(['instrument', include])
    return lambda: events.append('instrument removed')
def setup(app, root, **kwargs):
    events.append(['middleware setup', kwargs])
    return lambda: events.append('middleware removed')
def attach_sqlalchemy(engine):
    events.append(['engine attach', engine])
    ${failEngine ? "raise RuntimeError('controlled engine failure')" : "return lambda: events.append('engine removed')"}
def attach_orm(sessions):
    events.append(['sessions attach', sessions])
    return lambda: events.append('sessions removed')
sdk.instrument_project, sdk.setup, sdk.attach_sqlalchemy, sdk.attach_orm = instrument_project, setup, attach_sqlalchemy, attach_orm
sys.modules['studio_tracing'] = sdk
spec = importlib.util.spec_from_file_location('generated_backend', ${JSON.stringify(path.join(root, base, 'orivo_backend.py'))})
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)
async def run():
    try:
        async with entry.app.router.lifespan_context(entry.app) as state:
            events.append(['application ready', state])
    except RuntimeError as error:
        events.append(['startup error', str(error)])
asyncio.run(run())
print(json.dumps(events))
`;
  return JSON.parse(execFileSync('python', ['-c', script], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
}

test('backend-only preview and apply preserve every existing frontend file', async t => {
  const { root, manifest, vite } = await project(t), guided = createGuidedSetup();
  await fs.mkdir(path.join(root, '.studio-tracing')); await fs.writeFile(path.join(root, '.studio-tracing/keep.mjs'), '// Existing manual frontend integration.\n');
  const plan = await guided.preview(root, options);
  assert.equal(plan.backendOnly, true); assert.equal(plan.command, null); assert.equal(plan.frontend, null);
  assert.ok(plan.changes.every(change => change.path.startsWith(base + '/')));
  assert.match(plan.backendCommand, /python -B -m uvicorn orivo_backend:app/);
  const diff = plan.changes.find(change => change.path.endsWith('orivo_backend.py')).diff;
  assert.ok(diff.indexOf('studio_tracing.instrument_project(') < diff.indexOf('app = resolve('));
  assert.match(diff, /include=\["backend\/src"\]/); assert.match(diff, /app = app\(\)/);
  assert.match(diff, /response_models=True/); assert.match(diff, /@app\.state\.database\.session_factory/);
  await assert.rejects(fs.stat(path.join(root, base)), error => error.code === 'ENOENT');
  await guided.apply(root, plan.id, options.appOrigin);
  const saved = await guided.state(root);
  assert.equal(saved.installed, false); assert.equal(saved.backendInstalled, true); assert.equal(saved.backend.installed, true);
  assert.equal(saved.backend.configuration.factory, true); assert.equal(saved.backend.journal, undefined);
  assert.equal(await fs.readFile(path.join(root, 'frontend/package.json'), 'utf8'), manifest);
  assert.equal(await fs.readFile(path.join(root, 'frontend/vite.config.mjs'), 'utf8'), vite);
  assert.equal(await fs.readFile(path.join(root, '.studio-tracing/keep.mjs'), 'utf8'), '// Existing manual frontend integration.\n');
  await guided.undo(root, { backendOnly: true });
  assert.equal((await guided.state(root)).backendInstalled, false);
  assert.equal(await fs.readFile(path.join(root, 'frontend/package.json'), 'utf8'), manifest);
  assert.equal(await fs.readFile(path.join(root, 'backend/src/service/main.py'), 'utf8'), application);
});

test('backend-only and frontend guided setups coexist and remove independently', async t => {
  const { root, manifest } = await project(t), guided = createGuidedSetup();
  const frontend = await guided.preview(root, { frontend: 'frontend' }); await guided.apply(root, frontend.id);
  const generatedVite = await fs.readFile(path.join(root, '.studio-tracing/vite.config.mjs'), 'utf8');
  const backend = await guided.preview(root, options); await guided.apply(root, backend.id, options.appOrigin);
  assert.equal((await guided.state(root)).installed, true); assert.equal((await guided.state(root)).backendInstalled, true);
  assert.equal(await fs.readFile(path.join(root, '.studio-tracing/vite.config.mjs'), 'utf8'), generatedVite);
  await guided.undo(root);
  assert.equal(await fs.readFile(path.join(root, 'frontend/package.json'), 'utf8'), manifest);
  assert.equal((await guided.state(root)).installed, false); assert.equal((await guided.state(root)).backendInstalled, true);
  await fs.writeFile(path.join(root, '.orivo-tracing/keep.txt'), 'Preserve my extra file');
  await guided.undo(root, { backendOnly: true });
  assert.equal(await fs.readFile(path.join(root, '.orivo-tracing/keep.txt'), 'utf8'), 'Preserve my extra file');
});

test('generated factory wrapper instruments before import and attaches app-state database after lifespan startup', async t => {
  const { root } = await project(t), guided = createGuidedSetup();
  const plan = await guided.preview(root, options); await guided.apply(root, plan.id, options.appOrigin);
  const events = await runWrapper(root);
  assert.deepEqual(events, [['instrument', ['backend/src']], 'application import', 'factory', ['middleware setup', { development: true, response_models: true }], 'lifespan enter', ['engine attach', 'SYNC_ENGINE'], ['sessions attach', 'SESSIONS'], ['application ready', { original: 'state' }], 'lifespan exit', 'sessions removed', 'engine removed', 'middleware removed', 'instrument removed']);
});

test('generated wrapper removes request and import hooks when database attachment fails during startup', async t => {
  const { root } = await project(t), guided = createGuidedSetup();
  const plan = await guided.preview(root, options); await guided.apply(root, plan.id, options.appOrigin);
  const events = await runWrapper(root, { failEngine: true });
  assert.deepEqual(events.slice(-5), [['engine attach', 'SYNC_ENGINE'], 'lifespan exit', 'middleware removed', 'instrument removed', ['startup error', 'controlled engine failure']]);
  assert.equal(events.some(event => Array.isArray(event) && event[0] === 'application ready'), false);
});

test('backend plans reject changed source/config/origin and invalid factory or state references without writing', async t => {
  const { root } = await project(t), guided = createGuidedSetup();
  let plan = await guided.preview(root, options);
  await assert.rejects(guided.apply(root, plan.id, 'http://localhost:5174'), /app changed/);
  await fs.appendFile(path.join(root, 'backend/src/service/main.py'), '# Changed after review\n');
  await assert.rejects(guided.apply(root, plan.id, options.appOrigin), /Backend configuration changed/);
  await assert.rejects(fs.stat(path.join(root, base)), error => error.code === 'ENOENT');
  for (const backend of [{ ...options.backend, factory: 'yes' }, { ...options.backend, instrument: 1 }, { ...options.backend, engine: '@app.__dict__.engine' }, { ...options.backend, app: 'service.main:create_app()' }, { ...options.backend, sessions: '@app.state.database.session_factory', engine: '' }]) await assert.rejects(guided.preview(root, { ...options, backend }), /true or false|module:object|engine reference/);
  plan = await guided.preview(root, options); await guided.apply(root, plan.id, options.appOrigin);
  await assert.rejects(guided.preview(root, options), /already configured/);
  const entry = path.join(root, base, 'orivo_backend.py'), edited = (await fs.readFile(entry, 'utf8')) + '# Keep my customization\n';
  await fs.writeFile(entry, edited);
  await assert.rejects(guided.undo(root, { backendOnly: true }), /generated backend setup file changed/);
  assert.equal(await fs.readFile(entry, 'utf8'), edited);
});

test('instrumentation can be explicitly omitted and module-object database references remain compatible', async t => {
  const { root } = await project(t), guided = createGuidedSetup();
  const plan = await guided.preview(root, { ...options, backend: { directory: 'backend', app: 'service.main:app', engine: 'service.database:database.engine', sessions: 'service.database:SessionLocal', instrument: false } });
  const source = plan.changes.find(change => change.path.endsWith('orivo_backend.py')).diff;
  assert.ok(!source.includes('instrument_project(')); assert.ok(!source.includes('app = app()'));
  assert.match(source, /service\.database:database\.engine/);
  execFileSync('python', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8', windowsHide: true });
});

test('a setup directory created after preview is preserved when apply cannot own it', async t => {
  const { root } = await project(t), guided = createGuidedSetup();
  const plan = await guided.preview(root, options);
  await fs.mkdir(path.join(root, base), { recursive: true });
  await fs.mkdir(path.join(root, base, 'kit'));
  await assert.rejects(guided.apply(root, plan.id, options.appOrigin), error => error.code === 'EEXIST');
  assert.equal((await fs.stat(path.join(root, base, 'kit'))).isDirectory(), true);
  assert.equal((await guided.state(root)).backendInstalled, false);
});
