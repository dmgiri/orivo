'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const {spawn} = require('node:child_process');

const BUNDLED_MODEL_ID = 'Orivo Local · Qwen3 4B';
const MODEL_ALIAS = 'orivo-local';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const START_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 300_000;

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function readJson(response, label) {
  if (!response?.ok) throw Error(`${label} returned HTTP ${response?.status ?? 'error'}.`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw Error(`${label} response exceeded the local size limit.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Error(`${label} response exceeded the local size limit.`);
  try {return JSON.parse(text);} catch {throw Error(`${label} returned invalid JSON.`);}
}

function createBundledModelProvider({runtimePath, modelPath, spawnImpl = spawn, fetchImpl = globalThis.fetch, existsImpl = file => fs.access(file).then(() => true, () => false), portAllocator = reserveLoopbackPort, startTimeoutMs = START_TIMEOUT_MS, healthTimeoutMs = 2_000, requestTimeoutMs = REQUEST_TIMEOUT_MS} = {}) {
  if (typeof fetchImpl !== 'function') throw Error('This Node.js runtime does not support local model requests.');
  let child = null, base = null, ready = false, startPromise = null, exitError = null;

  async function stop() {
    const process = child;
    child = null; base = null; ready = false; startPromise = null; exitError = null;
    if (!process || process.exitCode !== null && process.exitCode !== undefined || process.killed) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => {try {process.kill('SIGKILL');} catch {} resolve();}, 1500);
      timer.unref?.();
      process.once('exit', () => {clearTimeout(timer); resolve();});
      try {process.kill('SIGTERM');} catch {clearTimeout(timer); resolve();}
    });
  }

  async function start(signal) {
    if (ready) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (typeof runtimePath !== 'string' || typeof modelPath !== 'string' || !await existsImpl(runtimePath) || !await existsImpl(modelPath)) throw Error('The bundled Orivo AI runtime or model is missing. Run the Orivo AI asset preparation step, then restart the app.');
      const port = await portAllocator();
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Orivo could not reserve a local model port.');
      const args = ['--model', modelPath, '--alias', MODEL_ALIAS, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '8192', '--n-predict', '512', '--reasoning-budget', '0', '--jinja', '--no-webui', '--offline'];
      let process;
      try {process = spawnImpl(runtimePath, args, {windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore']});}
      catch {throw Error('Orivo could not start its bundled local AI runtime.');}
      child = process;
      process.once('error', error => {exitError = error; ready = false;});
      process.once('exit', (code, signalName) => {if (child === process) {exitError = Error(`The bundled AI runtime stopped${code == null ? ` (${signalName || 'unknown'})` : ` with exit code ${code}`}.`); ready = false; child = null; base = null;}});
      base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + startTimeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw Error('Local explanation cancelled.');
        if (exitError || child !== process) throw Error(exitError?.message || 'The bundled AI runtime stopped before becoming ready.');
        try {
          const healthTimeout = AbortSignal.timeout(healthTimeoutMs);
          const healthSignal = signal ? AbortSignal.any([signal, healthTimeout]) : healthTimeout;
          const response = await fetchImpl(`${base}/health`, {method: 'GET', signal: healthSignal, redirect: 'error'});
          if (response.ok) {ready = true; return;}
        } catch (error) {if (signal?.aborted) throw Error('Local explanation cancelled.');}
        await new Promise(resolve => {const timer = setTimeout(resolve, Math.max(1, Math.min(250, deadline - Date.now()))); timer.unref?.();});
      }
      await stop();
      throw Error('Orivo’s bundled AI model did not become ready within five minutes.');
    })().catch(async error => {if (child) await stop(); throw error;}).finally(() => {startPromise = null;});
    return startPromise;
  }

  async function request(route, body, signal) {
    await start(signal);
    const timeout = AbortSignal.timeout(requestTimeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${base}${route}`, {method: body ? 'POST' : 'GET', headers: body ? {'content-type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, signal: combined, redirect: 'error'});
      return await readJson(response, 'Orivo local model');
    } catch (error) {
      if (signal?.aborted) throw Error('Local explanation cancelled.');
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        ready = false;
        if (child) await stop();
        throw Error('Orivo local model did not respond before the timeout.');
      }
      if (error instanceof TypeError) {
        ready = false;
        if (child) await stop();
        throw Error('Orivo’s bundled local model stopped responding. Restart Orivo and try again.');
      }
      throw error;
    }
  }

  async function listModels({signal} = {}) {await start(signal); return [BUNDLED_MODEL_ID];}
  async function explain({model, messages, schema, signal}) {
    if (model !== BUNDLED_MODEL_ID) throw Error('Choose the bundled Orivo model. External model identifiers are not accepted.');
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4 || messages.some(row => !row || !['system', 'user', 'assistant'].includes(row.role) || typeof row.content !== 'string')) throw Error('Invalid local explanation prompt.');
    if (Buffer.byteLength(JSON.stringify(messages)) > MAX_PROMPT_BYTES) throw Error('The local explanation context exceeded its size limit. Narrow the selected trace and try again.');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('A structured explanation schema is required.');
    const result = await request('/v1/chat/completions', {model: MODEL_ALIAS, messages, response_format: {type: 'json_schema', json_schema: {name: 'orivo_explanation', strict: true, schema}}, temperature: 0, max_tokens: 512, stream: false}, signal);
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 64 * 1024) throw Error('The local model returned an empty or oversized explanation.');
    try {return JSON.parse(content);} catch {throw Error('The local model response was not valid structured JSON. Try again.');}
  }

  return Object.freeze({listModels, explain, stop, status: () => Object.freeze({ready, starting: !!startPromise, bundled: true, model: BUNDLED_MODEL_ID})});
}

module.exports = {BUNDLED_MODEL_ID, createBundledModelProvider, reserveLoopbackPort};
