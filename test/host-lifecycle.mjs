import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, TRACE_ATLAS_TEST_PROFILE: `lifecycle-${Date.now()}` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [root], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${message}\n${stderr}`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
try {
  await bounded(new Promise((resolve, reject) => {
    child.on('message', message => { if (message?.type === 'trace-atlas:ready') resolve(); });
    exited.then(() => reject(Error(`Application exited before ready.\n${stderr}`)), reject);
  }), 20000, 'Isolated application did not start.');
  const started = performance.now();
  child.send({ type: 'trace-atlas:shutdown' });
  const result = await bounded(exited, 4000, 'Application did not exit after graceful shutdown.');
  assert.equal(result.code, 0);
  console.log(JSON.stringify({ passed: true, shutdownMilliseconds: Math.round(performance.now() - started), exitCode: result.code }));
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
