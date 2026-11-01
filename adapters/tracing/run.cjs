const fs=require('node:fs/promises'),path=require('node:path');
const {spawn,execFile}=require('node:child_process');

function createTracingRunner(guided,options={}){
 const jobs=new Map(),starts=new Map(),spawnProcess=options.spawn||spawn,killProcess=options.execFile||execFile;
 const live=job=>!!job?.child&&!job.closed;
 function snapshot(job){return job?{status:job.status,active:live(job),frontend:job.frontend,command:'npm run dev:studio',output:job.output,notice:job.notice,url:job.url||null}:{status:'idle',active:false,output:'',notice:'',url:null};}
 async function state(folder){return snapshot(jobs.get(await fs.realpath(folder)));}
 async function start(folder){
  const root=await fs.realpath(folder);if(starts.has(root))return starts.get(root);
  const pending=begin(root);starts.set(root,pending);try{return await pending;}finally{starts.delete(root);}
 }
 async function begin(root){
  const previous=jobs.get(root);if(live(previous))return snapshot(previous);
  const launch=await guided.launch(root);
  const job={status:'starting',frontend:launch.frontend,output:'',notice:'Starting app...',url:null,child:null,closed:false};
  jobs.set(root,job);
  const env={...process.env,NO_COLOR:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.FORCE_COLOR;
  // Fixed npm invocation only. Renderer input never supplies commands, arguments or paths.
  // Ignore npm lifecycle hooks; explicitly run the verified dev:studio script.
  const windows=process.platform==='win32';
  try{
   job.child=spawnProcess(windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'):'npm',windows?['/d','/s','/c','npm.cmd --ignore-scripts run dev:studio']:['--ignore-scripts','run','dev:studio'],{cwd:launch.cwd,env,windowsHide:true,shell:false,detached:!windows,stdio:['ignore','pipe','pipe']});
   const output=chunk=>{
    const text=String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');job.output=(job.output+text).slice(-6000);
    const match=job.output.match(/Local:\s*(https?:\/\/[^\s]+)/);
    if(match&&job.status==='starting'){
     try{const url=new URL(match[1]);if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)){job.url=url.href;job.status='running';job.notice='App running with tracing.';}}catch{}
    }
   };
   job.child.stdout?.on('data',output);job.child.stderr?.on('data',output);
   job.child.once('error',()=>{job.closed=true;job.status='failed';job.notice='Could not execute npm. Make sure Node.js and npm are installed.';});
   job.child.once('close',code=>{
    job.closed=true;
    if(job.status==='stopping'){job.status='stopped';job.notice='App stopped.';}
    else if(job.status!=='failed'){job.status=code===0?'stopped':'failed';job.notice=/port .*already in use/i.test(job.output)?'Port already in use. Stop your current dev server, then Execute again.':code===0?'App stopped.':'App could not start. Check the output below.';}
   });
  }catch{job.closed=true;job.status='failed';job.notice='Could not start the app. Check your Node.js installation.';}
  return snapshot(job);
 }
 async function stop(folder){
  const job=jobs.get(await fs.realpath(folder));if(!live(job))return snapshot(job);
  job.status='stopping';job.notice='Stopping app...';
  await new Promise((resolve,reject)=>{
   let timer;
   const done=()=>{clearTimeout(timer);resolve();};job.child.once('close',done);
   timer=setTimeout(()=>{job.child.removeListener('close',done);reject(Error('Could not stop the app. Try Stop again.'));},10000);
   if(process.platform==='win32')killProcess('taskkill.exe',['/PID',String(job.child.pid),'/T','/F'],{windowsHide:true},error=>{if(error&&!job.closed){clearTimeout(timer);job.child.removeListener('close',done);reject(Error('Could not stop the app. Try Stop again.'));}});
   else{try{process.kill(-job.child.pid,'SIGTERM');}catch{job.child.kill();}}
  }).catch(error=>{if(!job.closed){job.status=job.url?'running':'starting';job.notice=error.message;}throw error;});
  return snapshot(job);
 }
 async function close(){await Promise.allSettled([...starts.values()]);await Promise.allSettled([...jobs].filter(([,job])=>live(job)).map(([root])=>stop(root)));}
 return {start,state,stop,close};
}
module.exports={createTracingRunner};
