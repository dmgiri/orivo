'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {describeSetup} = require('../engine/index.cjs');

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orivo-setup-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('orivo-setup-'));
    await fs.rm(root, {recursive:true,force:true});
  });
  await fs.mkdir(path.join(root, 'frontend'));
  await fs.writeFile(path.join(root, 'frontend', 'package.json'), JSON.stringify({
    name:'example-app', scripts:{dev:'vite --port 5173'},
    dependencies:{react:'19.3.0'}, devDependencies:{vite:'8.3.3'}
  }));
  return root;
}

test('setup detects an existing nested tracing flag without exposing config contents', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'frontend', 'vite.config.ts'), [
    "import studioTracing from './studio-tracing.mjs';",
    "const enabled = process.env.VITE_STUDIO_TRACE === '1';",
    "const unrelated = 'private-config-fixture';",
    'export default {plugins: enabled ? [studioTracing()] : []};'
  ].join('\n'));
  const result = await describeSetup(root);
  assert.equal(result.readOnly, true);
  assert.equal(result.frontends[0].framework, 'React');
  assert.equal(result.frontends[0].bundler, 'Vite');
  assert.deepEqual(result.existingTracing, [{
    directory:'frontend',configFile:'frontend/vite.config.ts',flag:'VITE_STUDIO_TRACE',value:'1'
  }]);
  assert.ok(!JSON.stringify(result).includes('private-config-fixture'));
});

test('setup bounds config inspection and keeps unknown activation distinct from runtime readiness', async t => {
  const root = await project(t), config = path.join(root, 'frontend', 'vite.config.ts');
  await fs.writeFile(config, "import studioTracing from './studio-tracing.mjs';\nexport default {plugins:[studioTracing()]};");
  const detected = await describeSetup(root);
  assert.equal(detected.existingTracing[0].flag, null);
  assert.equal(detected.existingTracing[0].value, null);
  assert.equal(detected.runtime, undefined, 'A source config cannot prove the live adapter is active');
  await fs.writeFile(config, ' '.repeat(65537) + 'studioTracing VITE_STUDIO_TRACE');
  assert.deepEqual((await describeSetup(root)).existingTracing, []);
});
