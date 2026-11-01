'use strict';
// Own development processes, never mutate the connected repository. Renderer
// values select detected candidates; they cannot supply commands or paths.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn,execFile}=require('node:child_process');
const {createRequire}=require('node:module');
const {createHash,randomUUID}=require('node:crypto');
const {promisify}=require('node:util');
const {describeProject,frontendMatch}=require('./setup.cjs');
const runFile=promisify(execFile),MAX_OUTPUT=6000;
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cleanOutput(value){
 return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g,url=>{try{const parsed=new URL(url);if(parsed.username||parsed.password){parsed.username='redacted';parsed.password='redacted';}for(const key of [...parsed.searchParams.keys()])if(/token|secret|pass|auth|credential|key|session/i.test(key))parsed.searchParams.set(key,'redacted');return parsed.href;}catch{return '[redacted URL]';}})
  .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi,'$1 [redacted]')
  .replace(/((?:authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|token|session(?:[_-]?id)?|api[_-]?key|cookie|set-cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[redacted]');
}
const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
async function canonicalFolder(folder){const requested=path.resolve(folder),root=await fs.realpath(requested);if(!samePath(root,requested))throw Error('The connected project folder changed. Reopen the project before attaching.');if(!(await fs.stat(root)).isDirectory())throw Error('Choose a project folder.');return root;}
async function checkedDirectory(root,directory){const result=await fs.realpath(path.resolve(root,directory));if(!inside(root,result))throw Error('Detected app directory leaves the connected project.');return result;}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const attachmentError=(message,code)=>Object.assign(Error(message),{code});
function attachmentOptions(options){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['frontend','backend','url','urlMode'].includes(key)))throw Error('Automatic attachment accepts detected app selections only.');
 if(options.urlMode!==undefined&&!['provided','separate'].includes(options.urlMode))throw Error('Choose the provided application address or a separate tracing address.');
}
function applicationAddress(value){
 let url;try{if(typeof value!=='string'||value.length>2048)throw Error();url=new URL(value.trim());}catch{throw attachmentError('Enter a full local HTTP application address before attaching tracing.','unsupported-origin');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||Number(url.port||(url.protocol==='https:'?443:80))<1)throw attachmentError('Enter an HTTP or HTTPS application address without embedded credentials.','unsupported-origin');
 return {url};
}
function localAddress(value){
 const {url}=applicationAddress(value);
 if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw attachmentError('Automatic tracing can start an application at an HTTP localhost address only. Open the local development address, or explicitly use a separate tracing address.','unsupported-origin');
 return {url,port:Number(url.port||80),host:url.hostname==='localhost'?'127.0.0.1':url.hostname.replace(/^\[|\]$/g,''),browserHost:url.hostname};
}
const portInUseNotice=address=>`Port ${address.port} at ${address.url.origin} is already in use. Stop the frontend development server and retry, or explicitly use a separate tracing address. Orivo has left the existing application running.`;
async function availableAddress(address){
 // localhost represents both loopback families in browsers. Refuse an address
 // already served by either family instead of showing two apps at one origin.
 const hosts=address.url.hostname==='localhost'?['127.0.0.1','::1']:[address.host];
 for(const host of hosts){
  const server=net.createServer();
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({port:address.port,host,exclusive:true},resolve);});}
  catch(error){
   if(host==='::1'&&address.url.hostname==='localhost'&&['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code))continue;
   if(error.code==='EADDRINUSE')throw attachmentError(portInUseNotice(address),'port-in-use');
   throw error;
  }finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
 }
}
async function findNode(){
 const candidates=[];
 if(!process.versions.electron)candidates.push(process.execPath);
 if(process.env.npm_node_execpath)candidates.push(process.env.npm_node_execpath);
 for(const folder of (process.env.PATH||process.env.Path||'').split(path.delimiter))if(folder)candidates.push(path.join(folder,process.platform==='win32'?'node.exe':'node'));
 for(const file of [...new Set(candidates)])try{
  const absolute=await fs.realpath(file);if(!(await fs.stat(absolute)).isFile())continue;
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const {stdout}=await runFile(absolute,['-p','JSON.stringify({node:process.versions.node,electron:!!process.versions.electron})'],{env,windowsHide:true,timeout:5000,maxBuffer:1024});
  const value=JSON.parse(stdout.trim());if(!value.electron&&/^\d+\.\d+\.\d+$/.test(value.node)&&Number(value.node.split('.')[0])>=20)return {file:absolute,version:value.node};
 }catch{}
 throw Error('Install Node.js 24.13 or later to start managed development servers.');
}
function createAutoAttach({runtimeDirectory,onState}={}){
 if(typeof runtimeDirectory!=='string'||!path.isAbsolute(runtimeDirectory))throw Error('Automatic tracing requires an absolute Orivo runtime directory.');
 const jobs=new Map(),starts=new Map();let closing=false;
 function existingRoot(folder){const requested=path.resolve(folder);return [...jobs.keys()].find(root=>samePath(root,requested))||requested;}
 const live=job=>!!job?.children?.some(child=>!child.closed);
 function snapshot(job){return job?{status:job.status,active:live(job),url:job.url||null,requestedUrl:job.requestedUrl||null,urlMode:job.urlMode||'provided',errorCode:job.errorCode||null,frontend:job.frontend||null,backend:job.backend||null,notice:job.notice||'',output:job.output||'',bounded:true}:{status:'idle',active:false,url:null,requestedUrl:null,urlMode:'provided',errorCode:null,frontend:null,backend:null,notice:'',output:'',bounded:true};}
 function publish(root,job){try{onState?.(root,snapshot(job));}catch{}}
 function update(root,job,status,notice){job.status=status;job.notice=notice;publish(root,job);}
 function output(root,job,chunk){
  // Child stdout can split a secret halfway through a chunk. Hold incomplete
  // lines rather than publishing an unredacted tail in the middle of a value.
  let text=String(chunk);
  if(job.dropOutputLine){const end=text.indexOf('\n');if(end<0)return;text=text.slice(end+1);job.dropOutputLine=false;}
  const lines=((job.pendingOutput||'')+text).split('\n'),tail=lines.pop();
  job.pendingOutput=tail.length>8192?'':tail;if(tail.length>8192)job.dropOutputLine=true;
  if(!lines.length)return;
  const safe=lines.map(line=>line.length>8192?'[Long application output line omitted]':cleanOutput(line)).join('\n')+'\n';
  job.output=(job.output+safe).slice(-MAX_OUTPUT);const now=Date.now();if(!job.lastOutput||now-job.lastOutput>200){job.lastOutput=now;publish(root,job);}
 }
 async function detect(folder,{url}={}){
  const root=await canonicalFolder(folder),description=await describeProject(root),issues=[];
  const frontends=description.frontends.map(row=>({...row,id:(row.bundler==='Next.js'?'next:':'vite:')+row.directory,type:row.bundler==='Next.js'?'next':'vite',supported:row.framework==='React'&&row.bundler==='Vite'&&!!row.viteVersion&&row.guided||row.framework==='Next.js'&&/^16\./.test(row.nextVersion||''),...(row.framework==='Next.js'&&/^16\./.test(row.nextVersion||'')?{reason:'Automatic client JSX and same-origin request capture using Next.js 16 webpack in an Orivo-owned source mirror.',limitations:['Server components, server actions and server rendering do not have automatic data provenance.','Linked source folders and source mirrors larger than 50,000 files or 256 MiB are not supported.']}: {})}));
  for(const row of frontends)if(!row.supported)issues.push(row.reason);
  const {detectPython}=require('./auto-python.cjs'),{detectNode}=require('./auto-node-detect.cjs');
  const backends=[...await detectPython(root,description),...await detectNode(root,description)];
  for(const row of backends)if(row.issue)issues.push(row.issue);
  const available=frontends.filter(row=>row.supported);let frontend=null;
  if(url)try{frontend=frontendMatch(available,url).frontend;}catch{}
  if(!frontend&&available.length===1)frontend=available[0].directory;
  const selected={frontend:available.find(row=>row.directory===frontend)?.id||null,backend:backends.length===1?backends[0].id:null};
  if(!available.length)issues.push('Automatic attachment needs an installed React/Vite 5–8 or Next.js 16 frontend.');
  return {supported:available.length>0,frontends,backends,selected,requiresSelection:available.length>1&&!selected.frontend||backends.length>1&&!selected.backend,issues:[...new Set(issues)]};
 }
 async function state(folder){return snapshot(jobs.get(existingRoot(folder)));}
 async function terminate(child){
  if(child.closed)return;
  const ended=new Promise(resolve=>child.process.once('close',resolve));
  if(process.platform==='win32')await runFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.process.pid),'/T','/F'],{windowsHide:true,timeout:4000,maxBuffer:2048}).catch(()=>{});
  else try{process.kill(-child.process.pid,'SIGTERM');}catch{try{child.process.kill('SIGTERM');}catch{}}
  await Promise.race([ended,wait(1200)]);
  if(!child.closed){try{if(process.platform!=='win32')process.kill(-child.process.pid,'SIGKILL');else child.process.kill();}catch{}await Promise.race([ended,wait(500)]);}
 }
 async function cleanup(job){await Promise.allSettled((job.children||[]).map(terminate));}
 function ownedSpawn(root,job,command,args,cwd,env,label){
  if(job.cancelled)throw Error('Automatic attachment was stopped.');
  const child={process:null,closed:false,label};
  child.process=spawn(command,args,{cwd,env,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
  job.children.push(child);
  child.process.stdout.on('data',chunk=>output(root,job,chunk));child.process.stderr.on('data',chunk=>output(root,job,chunk));
  child.process.once('error',error=>{child.error=error;child.closed=true;if(job.status==='running'){update(root,job,'failed',`${label} could not continue. Check the output.`);void cleanup(job);}});
  child.process.once('close',code=>{child.closed=true;child.exitCode=code;if(job.status==='running'&&!job.cancelled){update(root,job,'failed',`${label} stopped. Start automatic tracing again.`);void cleanup(job);}});
  return child;
 }
 async function ready(child,port,token,job,host='127.0.0.1'){
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
   if(job.cancelled)throw Error('Automatic attachment was stopped.');
   if(child.closed)throw Error(`${child.label} could not start. Check the output.`);
   const matched=await new Promise(resolve=>{
    let timer;const done=value=>{clearTimeout(timer);resolve(value);};
    const request=http.get({hostname:host,port,path:'/__orivo_managed_ready/'+token,timeout:600},response=>{let value='';response.on('data',chunk=>{value+=chunk;if(value.length>256)response.destroy();});response.on('end',()=>done(response.statusCode===200&&value===token));response.on('error',()=>done(false));});
    timer=setTimeout(()=>{request.destroy();done(false);},750);request.on('timeout',()=>request.destroy());request.on('error',()=>done(false));
   });
   if(matched&&!child.closed)return;
   await wait(100);
  }
  throw Error(`${child.label} did not become ready within 60 seconds. Check its dependencies and output.`);
 }
 async function begin(root,options){
  const previous=jobs.get(root);if(live(previous)&&previous.status==='running'){
   attachmentOptions(options);
   const found=await detect(root,{url:options.url}),frontend=options.frontend??previous.frontend,backend=Object.hasOwn(options,'backend')&&options.backend!==undefined?options.backend==='none'?null:options.backend:previous.backend;
   if(frontend!==previous.frontend||backend!==previous.backend)throw Error('Stop the current attachment before choosing another application.');
   if(!found.frontends.some(row=>row.id===frontend&&row.supported)||backend&&!found.backends.some(row=>row.id===backend))throw Error('The detected application changed. Stop attachment and detect it again.');
   if(options.urlMode!==undefined&&options.urlMode!==previous.urlMode)throw Error('Stop the current attachment before changing its application address.');
   if(options.url!==undefined){
    const requested=(previous.urlMode==='separate'?applicationAddress(options.url):localAddress(options.url)).url,actual=new URL(previous.url),original=previous.requestedUrl&&new URL(previous.requestedUrl);
    if(requested.origin!==actual.origin&&!(previous.urlMode==='separate'&&options.urlMode==='separate'&&requested.origin===original?.origin))throw Error('Stop the current attachment before changing its application address.');
    const suffix=requested.pathname+requested.search+requested.hash;
    previous.url=actual.origin+suffix;previous.requestedUrl=previous.urlMode==='separate'&&original?original.origin+suffix:requested.href;publish(root,previous);
   }
   return snapshot(previous);
  }
  if(previous)await cleanup(previous);
  const job={status:'detecting',notice:'Detecting app runtimes…',output:'',children:[],cancelled:false};jobs.set(root,job);publish(root,job);
  try{
   attachmentOptions(options);
   const supplied=options.url===undefined?null:applicationAddress(options.url);if(supplied)job.requestedUrl=supplied.url.href;
   const found=await detect(root,{url:options.url});if(!found.supported)throw Error(found.issues.join(' '));
   const frontendId=options.frontend??found.selected.frontend,backendId=Object.hasOwn(options,'backend')&&options.backend===null?'none':options.backend??found.selected.backend;
   const frontend=found.frontends.find(row=>row.id===frontendId&&row.supported);
   if(!frontend)throw Error('Choose one detected React/Vite or Next.js frontend.');
   const backend=backendId==='none'?null:found.backends.find(row=>row.id===backendId);
   if(backendId!=='none'&&found.backends.length&&!backend)throw Error('Choose one detected backend, or explicitly choose frontend only.');
   if(backend?.issue)throw Error(backend.issue);
   if(job.cancelled||closing)throw Error('Automatic attachment was stopped.');
   job.frontend=frontend.id;job.backend=backend?.id||null;
   const sameSelection=previous?.frontend===job.frontend&&(previous?.backend||null)===job.backend;
   const previousAddress=sameSelection&&(previous.url||previous.resumeUrl)?localAddress(previous.url||previous.resumeUrl):null;
   const previousRequested=sameSelection&&previous.requestedUrl?applicationAddress(previous.requestedUrl):null;
   const inheritedMode=sameSelection&&(!supplied||supplied.url.origin===previousAddress?.url.origin)?previous.urlMode:null;
   job.urlMode=options.urlMode||inheritedMode||'provided';
   const suffix=supplied?supplied.url.pathname+supplied.url.search+supplied.url.hash:previousAddress?previousAddress.url.pathname+previousAddress.url.search+previousAddress.url.hash:'/';
   let address;
   if(job.urlMode==='separate'){
    address=previousAddress&&previous.urlMode==='separate'?localAddress(previousAddress.url.origin+suffix):localAddress('http://127.0.0.1:'+await freePort()+suffix);
    job.requestedUrl=supplied&&supplied.url.origin!==previousAddress?.url.origin?supplied.url.href:previousRequested?previousRequested.url.origin+suffix:null;
   }else{
    address=supplied?localAddress(supplied.url.href):previousAddress||localAddress('http://127.0.0.1:'+await freePort()+'/');
    job.requestedUrl=supplied?.url.href||previousRequested?.url.href||null;
   }
   job.resumeUrl=address.url.href;
   await availableAddress(address);
   if(job.cancelled||closing)throw Error('Automatic attachment was stopped.');
   const node=await findNode(),frontendCwd=await checkedDirectory(root,frontend.directory);
   if(backend&&backend.type!=='python'&&backend.minimumNode){const parts=node.version.split('.').map(Number),minimum=backend.minimumNode.split('.').map(Number);if(parts[0]<minimum[0]||parts[0]===minimum[0]&&(parts[1]<minimum[1]||parts[1]===minimum[1]&&parts[2]<minimum[2]))throw Error('This Node backend requires Node.js '+backend.minimumNode+' or later.');}
   const frontendRequire=createRequire(path.join(frontendCwd,'package.json')),viteFile=frontend.type==='vite'?frontendRequire.resolve('vite'):null;
   await fs.mkdir(runtimeDirectory,{recursive:true});const base=await fs.realpath(runtimeDirectory);
   if(inside(root,base))throw Error('Orivo runtime configuration must be stored outside the connected project.');
   const directory=path.join(base,createHash('sha256').update(root).digest('hex').slice(0,20)+'-'+randomUUID());
   await fs.mkdir(directory);job.directory=directory;
   // Root identity and each selected directory are pinned again after detection.
   if(await canonicalFolder(root)!==root)throw Error('The connected project changed during attachment.');
   const env={...process.env,NO_COLOR:'1',PYTHONDONTWRITEBYTECODE:'1'};
   for(const key of ['ELECTRON_RUN_AS_NODE','FORCE_COLOR','NODE_OPTIONS','ORIVO_AUTO_NODE_CONFIG'])delete env[key];
   let backendUrl=null,backendTraceToken=null;
   if(backend){
    update(root,job,'starting','Starting the backend with tracing…');
    const cwd=await checkedDirectory(root,backend.directory);let port=await freePort();while(port===address.port)port=await freePort();const readyToken=randomUUID(),config=path.join(directory,'backend.json');
    const value={...backend,root,directory:backend.directory,port,host:'127.0.0.1',readyToken,parentPid:process.pid,traceTransport:'memory-v1'};
    backendTraceToken=readyToken;
    await fs.writeFile(config,JSON.stringify(value),'utf8');let child;
    if(backend.type==='python'||backend.framework==='FastAPI'||backend.framework==='Starlette'){
     if(!backend.python)throw Error('A project Python virtual environment is required.');
     backendTraceToken=readyToken;
     child=ownedSpawn(root,job,backend.python,['-B',path.join(__dirname,'auto_python.py'),'--config',config],cwd,env,'Python backend');
    }else{
     const entry=await fs.realpath(backend.entry);if(!inside(root,entry))throw Error('Detected backend entry leaves the connected project.');
     child=ownedSpawn(root,job,node.file,['--require',path.join(__dirname,'auto-node.cjs'),entry,...(backend.arguments||[])],cwd,{...env,PORT:String(port),HOST:'127.0.0.1',ORIVO_AUTO_NODE_CONFIG:config},'Node backend');
    }
    await ready(child,port,readyToken,job);backendUrl='http://127.0.0.1:'+port;
   }
   update(root,job,'starting','Starting the frontend with tracing…');
   job.frontendStarting=true;
   const port=address.port,readyToken=randomUUID(),config=path.join(directory,'frontend.json');
   await fs.writeFile(config,JSON.stringify({root,directory:frontendCwd,viteFile,viteVersion:frontend.viteVersion,cacheDirectory:path.join(directory,frontend.type==='next'?'next-cache':'vite-cache'),port,host:address.host,browserHost:address.browserHost,readyToken,backendUrl,backendTraceToken,backendPort:backend?.originalPort||backend?.port||null}),'utf8');
   const guard=path.join(__dirname,'auto-next-guard.cjs'),child=ownedSpawn(root,job,node.file,[...(frontend.type==='next'?['--require',guard]:[]),path.join(__dirname,frontend.type==='next'?'auto-next.mjs':'auto-vite.mjs'),'--config',config],frontendCwd,{...env,NEXT_TELEMETRY_DISABLED:'1',...(frontend.type==='next'?{CI:'1',ORIVO_SOURCE_GUARD_ROOT:root,NODE_OPTIONS:'--require '+JSON.stringify(guard.replaceAll('\\','/'))}:{})},frontend.type==='next'?'Next.js frontend':'Vite frontend');
   await ready(child,port,readyToken,job,address.host);
   if(job.cancelled||job.children.some(row=>row.closed))throw Error('Automatic attachment was stopped before the app was ready.');
   job.url=address.url.href;
   update(root,job,'running',backend?'App running with frontend, backend and database tracing.':'App running with frontend tracing.');
  }catch(error){
   job.errorCode=error.code==='port-in-use'||error.code==='unsupported-origin'?error.code:job.frontendStarting&&/EADDRINUSE|Port \d+ is already in use/i.test(job.output)?'port-in-use':null;
   const notice=job.errorCode==='port-in-use'&&job.resumeUrl?portInUseNotice(localAddress(job.resumeUrl)):error.message;
   await cleanup(job);update(root,job,job.cancelled?'stopped':'failed',job.cancelled?'Automatic tracing stopped.':cleanOutput(notice));
  }
  return snapshot(job);
 }
 async function start(folder,options={}){if(closing)throw Error('Orivo is closing.');const root=await canonicalFolder(folder);if(starts.has(root))return starts.get(root);const pending=begin(root,options);starts.set(root,pending);try{return await pending;}finally{starts.delete(root);}}
 async function stop(folder){const root=existingRoot(folder),job=jobs.get(root);if(!job)return snapshot();job.cancelled=true;update(root,job,'stopping','Stopping automatic tracing…');await cleanup(job);update(root,job,'stopped','Automatic tracing stopped.');return snapshot(job);}
 async function close(){closing=true;for(const [root,job] of jobs){job.cancelled=true;update(root,job,'stopping','Stopping automatic tracing…');}await Promise.allSettled([...jobs.values()].map(cleanup));for(const [root,job] of jobs)update(root,job,'stopped','Automatic tracing stopped.');}
 return {detect,start,state,stop,close};
}
module.exports={createAutoAttach,cleanOutput,findNode};
