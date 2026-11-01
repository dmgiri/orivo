import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const logs=path.join(root,'.tmp','launcher');await mkdir(logs,{recursive:true});
const before=new Set(await readdir(logs));
const env={...process.env,TRACE_ATLAS_TEST_PROFILE:'launcher-'+Date.now()};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn('cmd.exe',['/d','/s','/c',`""${path.join(root,'Start Orivo.cmd')}""`],{env,cwd:root,windowsVerbatimArguments:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',error='',ready;
child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
try{
  let timeout;
  const exitCode=await Promise.race([new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Shortcut launch timed out')),30000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(exitCode,0,error||output);
  for(const name of (await readdir(logs)).filter(name=>!before.has(name)&&name.endsWith('.json'))){const status=JSON.parse(await readFile(path.join(logs,name),'utf8'));if(status.state==='ready')ready=status;}
  assert.equal(ready?.visible,true,'Electron must report a visible window, not just a running process');
  assert.ok(Number.isInteger(ready.pid));
  const details=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${ready.pid} | Select-Object Id,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
  assert.match(details.MainWindowTitle,/Orivo/);
  assert.ok(Number(details.MainWindowHandle)!==0,'Native desktop window handle must be visible');
  console.log(JSON.stringify({passed:true,shortcut:path.join(root,'Start Orivo.cmd'),windowTitle:details.MainWindowTitle,visible:true}));
}finally{
  if(ready?.pid){execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$traceAtlasTest=Get-Process -Id ${ready.pid} -ErrorAction SilentlyContinue; if($traceAtlasTest){[void]$traceAtlasTest.CloseMainWindow(); $traceAtlasTest.WaitForExit(4000) | Out-Null; if(-not $traceAtlasTest.HasExited){throw 'Shortcut test instance did not close cleanly.'}}`],{encoding:'utf8',windowsHide:true});}
  if(child.exitCode===null)child.kill();
}
