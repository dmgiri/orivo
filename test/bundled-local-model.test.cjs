'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createBundledModelProvider, BUNDLED_MODEL_ID} = require('../engine/local-model.cjs');

function fixture(overrides = {}) {
  const calls = [], children = [], commands = [];
  const spawnImpl = (command, args, options) => {
    commands.push({command, args, options});
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = signal => {child.killed = true; child.emit('exit', 0, signal); return true;};
    children.push(child); return child;
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({url: String(url), options});
    if (String(url).endsWith('/health')) return Response.json({status: 'ok'});
    if (String(url).endsWith('/v1/chat/completions')) return Response.json({choices: [{message: {content: JSON.stringify({version: 1})}}]});
    throw Error(`Unexpected request ${url}`);
  };
  const provider = createBundledModelProvider({runtimePath: 'ai/llama-server.exe', modelPath: 'ai/model.gguf', spawnImpl, fetchImpl, existsImpl: async () => true, portAllocator: async () => 43210, ...overrides});
  return {provider, calls, children, commands};
}

test('starts the Orivo-bundled model only on loopback and reports its fixed model', async () => {
  const {provider, commands} = fixture();
  assert.deepEqual(await provider.listModels(), [BUNDLED_MODEL_ID]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'ai/llama-server.exe');
  assert.ok(commands[0].args.includes('--host') && commands[0].args[commands[0].args.indexOf('--host') + 1] === '127.0.0.1');
  assert.ok(commands[0].args.includes('--model') && commands[0].args[commands[0].args.indexOf('--model') + 1] === 'ai/model.gguf');
  assert.ok(commands[0].args.includes('--offline'));
  assert.equal(commands[0].options.windowsHide, true);
  assert.equal(provider.status().ready, true);
  await provider.stop();
});

test('uses schema-constrained local inference and rejects arbitrary model identifiers', async () => {
  const {provider, calls} = fixture();
  const result = await provider.explain({model: BUNDLED_MODEL_ID, messages: [{role: 'user', content: 'trace'}], schema: {type: 'object'}});
  assert.deepEqual(result, {version: 1});
  const request = calls.find(call => call.url.endsWith('/v1/chat/completions'));
  assert.ok(request.url.startsWith('http://127.0.0.1:43210/'));
  assert.ok(request.options.redirect === 'error');
  assert.equal(JSON.parse(request.options.body).response_format.type, 'json_schema');
  await assert.rejects(provider.explain({model: 'external-model', messages: [], schema: {}}), /bundled Orivo model/);
  await provider.stop();
});

test('does not start an external provider when bundled runtime or model assets are absent', async () => {
  let starts = 0;
  const {provider} = fixture({existsImpl: async file => file.endsWith('llama-server.exe') && ++starts > 20});
  await assert.rejects(provider.listModels(), /bundled Orivo AI runtime or model is missing/);
  assert.equal(starts, 1);
});

test('stops the bundled inference process when requested', async () => {
  const {provider, children} = fixture();
  await provider.listModels();
  await provider.stop();
  assert.equal(children[0].killed, true);
  assert.equal(provider.status().ready, false);
});

test('cancelling model startup shuts down the partially started runtime process', async () => {
  let enteredHealth;
  const healthStarted = new Promise(resolve => {enteredHealth = resolve;});
  const fetchImpl = async (_url, {signal} = {}) => new Promise((_resolve, reject) => {
    enteredHealth();
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
  });
  const {provider, children} = fixture({fetchImpl});
  const controller = new AbortController();
  const pending = provider.listModels({signal: controller.signal});
  await healthStarted;
  controller.abort();
  await assert.rejects(pending, /Local explanation cancelled/);
  assert.equal(children[0].killed, true);
  assert.equal(provider.status().ready, false);
});

test('a stalled health request cannot outlive the model startup deadline', async () => {
  const fetchImpl = async (_url, options = {}) => new Promise((_resolve, reject) => {
    if (options.signal) options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), {once: true});
  });
  const {provider, children} = fixture({fetchImpl, startTimeoutMs: 20, healthTimeoutMs: 5});
  const outcome = await Promise.race([
    provider.listModels().then(() => 'ready', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('health request hung'), 150)),
  ]);
  assert.match(outcome, /did not become ready/);
  assert.equal(children[0].killed, true);
});
