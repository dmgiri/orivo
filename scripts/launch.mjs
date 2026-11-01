import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const options = process.argv.slice(2);
if (options.some(option => !option.startsWith('--remote-debugging-port='))) throw Error('Unsupported launch option.');
const launchToken = process.env.TRACE_ATLAS_LAUNCH_TOKEN;
if (launchToken !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(launchToken)) throw Error('Invalid launch status token.');
const statusFile = launchToken ? path.join(root,'.tmp','launcher',`${launchToken}.json`) : null;
let statusWrites = Promise.resolve();
function status(value) {
  if (!statusFile) return;
  statusWrites = statusWrites.then(async()=>{await mkdir(path.dirname(statusFile),{recursive:true});await writeFile(statusFile,JSON.stringify({...value,updatedAt:new Date().toISOString()}));}).catch(error=>console.error(`Could not record launch status: ${error.message}`));
}
let executable;
try { executable = require('electron'); await access(executable); }
catch {
  const existingRuntime = path.resolve(root, '../dev-tool-studio/desktop/node_modules/electron/dist/electron.exe');
  try { await access(existingRuntime); executable = existingRuntime; }
  catch { const error='Electron is not installed. Run npm.cmd install in trace-atlas, then npm.cmd start.';console.error(error);status({state:'error',message:error});await statusWrites;process.exit(1); }
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
// Hide the helper console in start.ps1; the Electron GUI must start visibly.
const child = spawn(executable, [...options, root], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: false });
let stopping = false, ready = false;
const stop = () => {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  if (child.connected) child.send({ type: 'trace-atlas:shutdown' }); else child.kill();
  const timer = setTimeout(() => child.kill(), 5000); timer.unref();
};
child.on('message', message => { if (message?.type === 'trace-atlas:ready') { ready = true;status({state:'ready',pid:message.pid,visible:message.visible===true});console.log('Orivo is open. Close its window or press Ctrl+C to stop.'); if (process.connected) process.send(message); } else if (message?.type === 'trace-atlas:existing') { ready = true;status({state:'existing'});console.log('Orivo is already running. Its window has been requested.');if(process.connected)process.send(message); } });
child.on('error', error => { console.error(`Orivo could not launch: ${error.message}`);status({state:'error',message:error.message});process.exitCode = 1; });
child.on('close', code => { process.exitCode = ready ? (code ?? 1) : 1;if(!ready)status({state:'error',message:`Electron exited before its window was ready (exit ${code ?? 'unknown'}). See the launch error log.`});if (process.connected) process.disconnect(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
if (process.connected) { process.on('message', message => { if (message?.type === 'trace-atlas:shutdown') stop(); }); process.on('disconnect', stop); }
