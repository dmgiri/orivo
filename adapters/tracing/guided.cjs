const fs=require('node:fs/promises'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {describeProject}=require('./setup.cjs');
const digest=text=>createHash('sha256').update(text).digest('hex');
const managed='.studio-tracing',backendManaged='.orivo-tracing/backend',script='dev:studio';
const validName=name=>typeof name==='string'&&name.length<512&&!path.isAbsolute(name)&&!name.includes('\\')&&!name.split('/').some(part=>!part||part==='.'||part==='..');
async function safePath(root,name){
 if(!validName(name))throw Error('Invalid setup path.');
 let full=root;for(const part of name.split('/')){full=path.join(full,part);try{if((await fs.lstat(full)).isSymbolicLink())throw Error('Linked setup paths are not supported.');}catch(error){if(error.code!=='ENOENT')throw error;}}
 return full;
}
async function read(root,name){const full=await safePath(root,name);try{const stat=await fs.stat(full);if(!stat.isFile()||stat.size>1048576)throw Error('Setup file is too large.');return await fs.readFile(full,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function reference(value,required=false,appRelative=false){
 if(!value&&!required)return '';
 const moduleReference=typeof value==='string'&&/^([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value);
 const stateReference=appRelative&&typeof value==='string'&&/^@app(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
 if(typeof value!=='string'||value.length>180||!moduleReference&&!stateReference)throw Error('Use a Python module:object reference, such as app.main:app, or an app reference such as @app.state.database.engine.');
 return value;
}
async function files(base=managed){const rows=[];for(const entry of await fs.readdir(__dirname,{withFileTypes:true}))if(entry.isFile()&&/\.(?:mjs|cjs|py|toml|json|md|txt)$/.test(entry.name))rows.push({path:base+'/kit/'+entry.name,after:await fs.readFile(path.join(__dirname,entry.name),'utf8')});return rows;}
async function removeOwned(root,rows,base=managed,removeParent=false){for(const row of [...rows].reverse()){const full=await safePath(root,row.path);if(await read(root,row.path)===row.after)await fs.unlink(full);}
 for(const name of [base+'/kit',base,...(removeParent?[path.posix.dirname(base)]:[])]){const full=await safePath(root,name);await fs.rmdir(full).catch(error=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;});}}
const directoryName=value=>value==='.'||validName(value);
function backendCommand(root,directory,base=backendManaged,entry='orivo_backend'){
 const relative=path.relative(path.join(root,directory),path.join(root,base)).replaceAll('\\','/')||'.';
 return 'python '+(base===backendManaged?'-B ':'')+'-m uvicorn '+entry+':app --app-dir '+JSON.stringify(relative)+' --reload --host 127.0.0.1';
}
async function pythonBackend(root,setup,options,base=managed,entry='studio_app'){
 const backend=setup.backends.find(item=>item.directory===options.directory&&['FastAPI','Starlette'].includes(item.framework));
 if(!backend||!directoryName(backend.directory))throw Error('Choose a detected FastAPI or Starlette backend.');
 for(const flag of ['factory','instrument'])if(options[flag]!==undefined&&typeof options[flag]!=='boolean')throw Error('Backend '+flag+' must be true or false.');
 const app=reference(options.app,true),engine=reference(options.engine,false,true),sessions=reference(options.sessions,false,true),factory=options.factory===true,instrument=options.instrument!==false;
 if(sessions&&!engine)throw Error('An ORM session reference also needs its engine reference.');
 const src=backend.directory==='.'?'src':backend.directory+'/src';
 const sourceDirectory=await fs.stat(await safePath(root,src)).then(stat=>stat.isDirectory()?src:backend.directory,error=>{if(error.code==='ENOENT')return backend.directory;throw error;});
 const responseModels=backend.framework==='FastAPI'&&!!engine&&!!sessions;
 const source=`# Reviewed development entry point. Application files and frontend tracing stay unchanged.\nimport sys\nfrom pathlib import Path\nfrom importlib import import_module\nfrom contextlib import asynccontextmanager, ExitStack\nROOT = Path(__file__).resolve().parents[${base.split('/').length}]\nBACKEND = ROOT / ${JSON.stringify(backend.directory)}\nsys.path.insert(0, str(BACKEND))\nif (BACKEND / 'src').is_dir():\n    sys.path.insert(0, str(BACKEND / 'src'))\nsys.path.insert(0, str(Path(__file__).resolve().parent / 'kit'))\nimport studio_tracing\ndef resolve(reference, application=None):\n    if not reference:\n        return None\n    if reference.startswith('@app.'):\n        value, names = application, reference[5:].split('.')\n    else:\n        module, member = reference.split(':')\n        value, names = import_module(module), member.split('.')\n    for name in names:\n        value = getattr(value, name)\n    return value\nstartup_hooks = ExitStack()\ntry:\n${instrument?`    startup_hooks.callback(studio_tracing.instrument_project(ROOT, include=[${JSON.stringify(sourceDirectory)}]))\n`:''}    app = resolve(${JSON.stringify(app)})\n${factory?'    app = app()\n':''}    startup_hooks.callback(studio_tracing.setup(app, ROOT, development=True${responseModels?', response_models=True':''}))\nexcept BaseException:\n    startup_hooks.close()\n    raise\noriginal_lifespan = app.router.lifespan_context\n@asynccontextmanager\nasync def traced_lifespan(application):\n    with startup_hooks:\n        async with original_lifespan(application) as state:\n            engine = resolve(${JSON.stringify(engine)}, application)\n            sessions = resolve(${JSON.stringify(sessions)}, application)\n            if engine is not None:\n                startup_hooks.callback(studio_tracing.attach_sqlalchemy(getattr(engine, 'sync_engine', engine)))\n            if sessions is not None:\n                startup_hooks.callback(studio_tracing.attach_orm(sessions))\n            yield state\napp.router.lifespan_context = traced_lifespan\n`;
 const watched=[];
 for(const name of ['requirements.txt','pyproject.toml']){const file=backend.directory==='.'?name:backend.directory+'/'+name,value=await read(root,file);watched.push({path:file,hash:value===null?null:digest(value)});}
 for(const module of [...new Set([app,engine,sessions].filter(value=>value&&!value.startsWith('@app.')).map(value=>value.split(':')[0]))]){
  for(const prefix of [backend.directory,src])for(const suffix of [module.replaceAll('.','/')+'.py',module.replaceAll('.','/')+'/__init__.py']){
   const name=prefix==='.'?suffix:prefix+'/'+suffix,value=await read(root,name);if(value!==null)watched.push({path:name,hash:digest(value)});
  }
 }
 return {row:{path:base+'/'+entry+'.py',after:source},watched,backendDirectory:backend.directory,backendCommand:backendCommand(root,backend.directory,base,entry),configuration:{directory:backend.directory,app,factory,engine,sessions,instrument,include:sourceDirectory}};
}
function createGuidedSetup(){
 const plans=new Map();
 async function state(folder){const root=await fs.realpath(folder),raw=await read(root,managed+'/setup.json');if(!raw)return {installed:false};
  const journal=JSON.parse(raw);if(journal.version!==1||!validName(journal.package)||!Array.isArray(journal.files)||journal.files.length>40||typeof journal.before!=='string'||typeof journal.after!=='string'||!journal.files.every(row=>validName(row.path)&&row.path.startsWith(managed+'/')&&typeof row.after==='string'&&row.after.length<1048576))throw Error('Setup history is invalid. Keep the files and reconnect the code folder.');
  return {installed:true,command:journal.command,backendCommand:journal.backendCommand||null,backendDirectory:journal.backendDirectory||null,frontend:journal.frontend,appOrigin:journal.appOrigin||null,journal,root};
 }
 async function backendState(folder){
  const root=await fs.realpath(folder),raw=await read(root,backendManaged+'/setup.json');if(!raw)return {installed:false};
  const journal=JSON.parse(raw);
  if(journal.version!==1||journal.kind!=='backend-only'||!directoryName(journal.backendDirectory)||!Array.isArray(journal.files)||journal.files.length>40||!journal.files.every(row=>validName(row.path)&&(row.path===backendManaged+'/orivo_backend.py'||row.path.startsWith(backendManaged+'/kit/'))&&typeof row.after==='string'&&row.after.length<1048576)||journal.backendCommand!==backendCommand(root,journal.backendDirectory))throw Error('Backend setup history is invalid. Keep its files and preview the backend again.');
  return {installed:true,backendOnly:true,frontend:null,command:null,backendCommand:journal.backendCommand,backendDirectory:journal.backendDirectory,appOrigin:journal.appOrigin||null,configuration:journal.configuration,journal,root};
 }
 function origin(value){const address=value||null;if(address){const url=new URL(address);if(!['http:','https:'].includes(url.protocol)||url.origin!==address)throw Error('Invalid tracing app address.');}return address;}
 async function previewBackend(root,setup,options){
  if(!options.backend?.app)throw Error('Choose a backend application before previewing backend tracing.');
  if((await backendState(root)).installed)throw Error('Backend tracing is already configured. Use its saved launch command or remove its generated setup first.');
  if((await state(root)).backendCommand)throw Error('The existing guided setup already has a backend entry point. Preserve it or remove that setup before creating another backend integration.');
  if(await fs.lstat(await safePath(root,backendManaged)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('.orivo-tracing/backend already exists. Its files have been preserved.');
  const configured=await pythonBackend(root,setup,options.backend,backendManaged,'orivo_backend'),rows=[...await files(backendManaged),configured.row];
  const id=randomUUID(),appOrigin=origin(options.appOrigin),plan={id,root,backendOnly:true,frontend:null,command:null,rows,watched:configured.watched,backendDirectory:configured.backendDirectory,backendCommand:configured.backendCommand,configuration:configured.configuration,appOrigin};
  plans.clear();plans.set(id,plan);
  return {id,backendOnly:true,frontend:null,command:null,backendDirectory:plan.backendDirectory,backendCommand:plan.backendCommand,changes:[{path:configured.row.path,detail:'Adds a separate backend development entry point with factory, application state, and shutdown cleanup.',diff:configured.row.after},{path:backendManaged+'/kit/',detail:`Copies ${rows.length-1} portable adapter files. No dependencies are installed.`}],notice:'Adds backend request/query tracing while preserving the existing frontend integration. Plain direct ORM/DTO fields can carry column origins; custom transformations still need explicit mapping. Restart this backend with your existing Python environment and keep the frontend API proxy pointed at it.'};
 }
 async function applyBackend(root,plan){
  for(const row of plan.watched){const value=await read(root,row.path);if((value===null?null:digest(value))!==row.hash)throw Error('Backend configuration changed after preview. Preview again.');}
  const parent=await safePath(root,path.posix.dirname(backendManaged)),directory=await safePath(root,backendManaged);
  let createdParent=false;
  try{await fs.mkdir(parent);createdParent=true;}catch(error){if(error.code!=='EEXIST')throw error;}
  const written=[];let createdDirectory=false;
  try{
   await fs.mkdir(directory);createdDirectory=true;await fs.mkdir(path.join(directory,'kit'));
   for(const row of plan.rows){await fs.writeFile(await safePath(root,row.path),row.after,{flag:'wx'});written.push(row);}
   for(const row of plan.watched){const value=await read(root,row.path);if((value===null?null:digest(value))!==row.hash)throw Error('Backend configuration changed while preparing setup. Preview again.');}
   const journal={version:1,kind:'backend-only',files:plan.rows,backendCommand:plan.backendCommand,backendDirectory:plan.backendDirectory,configuration:plan.configuration,appOrigin:plan.appOrigin,createdParent};
   const history={path:backendManaged+'/setup.json',after:JSON.stringify(journal)};await fs.writeFile(await safePath(root,history.path),history.after,{flag:'wx'});written.push(history);
   plans.delete(plan.id);
   return {installed:true,backendOnly:true,frontend:null,command:null,backendCommand:plan.backendCommand,backendDirectory:plan.backendDirectory,configuration:plan.configuration,appOrigin:plan.appOrigin,notice:'Backend tracing configured. Restart only the backend with the displayed command and its existing Python environment, then reload and select an element.'};
  }catch(error){if(createdDirectory)await removeOwned(root,written,backendManaged,createdParent);else if(createdParent)await fs.rmdir(parent).catch(failure=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(failure.code))throw failure;});throw error;}
 }
 async function undoBackend(folder){
  const saved=await backendState(folder);if(!saved.installed)throw Error('There is no separate backend setup to remove.');
  const {root,journal}=saved;
  for(const row of journal.files)if(await read(root,row.path)!==row.after)throw Error('A generated backend setup file changed. Preserve your edits or restore it before removing setup.');
  const history={path:backendManaged+'/setup.json',after:await read(root,backendManaged+'/setup.json')};
  await removeOwned(root,[...journal.files,history],backendManaged,journal.createdParent===true);
  return {installed:false,backendOnly:true,notice:'Generated backend setup removed. Frontend configuration, application files, and other files are preserved.'};
 }
 async function preview(folder,options={}){
  if(options.backendOnly!==undefined&&typeof options.backendOnly!=='boolean')throw Error('backendOnly must be true or false.');
  if(options.backend!==undefined&&(!options.backend||typeof options.backend!=='object'||Array.isArray(options.backend)||Object.keys(options.backend).some(key=>!['directory','app','engine','sessions','factory','instrument'].includes(key))))throw Error('Invalid backend setup input.');
  const root=await fs.realpath(folder),setup=await describeProject(root);if(options.backendOnly)return previewBackend(root,setup,options);
  if((await state(root)).installed)throw Error('Tracing is already set up. Use the saved launch command or undo this setup first.');
  if(options.backend?.app&&(await backendState(root)).installed)throw Error('Backend tracing is already configured separately. Preserve it and configure the frontend only.');
  if(await fs.lstat(path.join(root,managed)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('.studio-tracing already exists. Preserve it or choose another app.');
  const frontend=setup.frontends.find(item=>item.directory===(options.frontend||setup.frontends.find(item=>item.guided)?.directory||setup.frontends.find(item=>item.automatic)?.directory||setup.frontends[0]?.directory));
  if(frontend?.framework==='Next.js')throw Error(frontend.reason);
  if(!frontend?.automatic)throw Error(frontend?.framework==='React'&&frontend?.bundler==='Vite'?frontend.reason:'Guided frontend setup requires React with Vite 5–8. Export the kit for this stack.');
  const packageName=path.posix.join(frontend.directory,'package.json'),before=await read(root,packageName),manifest=JSON.parse(before),dev=manifest.scripts?.dev;
  if(typeof dev!=='string'||!/^vite(?:\s|$)/.test(dev)||/[;&|<>`$()\r\n]/.test(dev)||/\s--(?:config|root)(?:\s|=)/.test(dev)||/^vite\s+[^-\s]/.test(dev))throw Error('Guided setup needs a direct vite development script without a custom config/root. Export the kit to integrate this command manually.');
  if(manifest.scripts[script])throw Error('dev:studio already exists. Your existing script has been preserved.');
  const relative=path.relative(path.join(root,frontend.directory),path.join(root,managed,'vite.config.mjs')).replaceAll('\\','/');
  const nextScript=dev+' --config '+JSON.stringify(relative);manifest.scripts={...manifest.scripts,[script]:nextScript};
  const indent=before.match(/\n([ \t]+)"/)?.[1]||'  ',after=JSON.stringify(manifest,null,indent)+(before.endsWith('\n')?'\n':'');
  const relFrontend=path.relative(path.join(root,managed),path.join(root,frontend.directory)).replaceAll('\\','/');
  const config=`import path from 'node:path';\nimport {fileURLToPath} from 'node:url';\nimport {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nimport studioTracing from './kit/vite.mjs';\nconst directory=path.dirname(fileURLToPath(import.meta.url));\nconst root=path.resolve(directory,'..'),frontend=path.resolve(directory,${JSON.stringify(relFrontend)});\nconst require=createRequire(path.join(frontend,'package.json'));\nconst vitePackage=require.resolve('vite/package.json'),viteDirectory=path.dirname(vitePackage);\nconst {readFile}=await import('node:fs/promises');\nconst viteManifest=JSON.parse(await readFile(vitePackage,'utf8')),exported=viteManifest.exports?.['.'];\nconst imported=typeof exported==='string'?exported:exported?.import,entry=typeof imported==='string'?imported:imported?.default;\nif(typeof entry!=='string'||!entry.startsWith('./')||entry.split('/').includes('..'))throw Error('The installed Vite package has no supported ESM entry.');\nconst {loadConfigFromFile,mergeConfig}=await import(pathToFileURL(path.resolve(viteDirectory,entry)).href);\nexport default async env=>{\n const existing=await loadConfigFromFile(env,undefined,frontend);\n return mergeConfig({plugins:[studioTracing({enabled:true,repositoryRoot:root})]}, existing?.config||{});\n};\n`;
  const rows=[...await files(),{path:managed+'/vite.config.mjs',after:config}],watched=[];
  for(const extension of ['js','mjs','cjs','ts','mts','cts']){const name=path.posix.join(frontend.directory,'vite.config.'+extension),value=await read(root,name);watched.push({path:name,hash:value===null?null:digest(value)});}
  let backendCommand=null,backendDirectory=null;
  if(options.backend?.app){
   const configured=await pythonBackend(root,setup,options.backend);rows.push(configured.row);watched.push(...configured.watched);backendDirectory=configured.backendDirectory;backendCommand=configured.backendCommand;
  }
  const appOrigin=options.appOrigin||null;if(appOrigin){const address=new URL(appOrigin);if(!['http:','https:'].includes(address.protocol)||address.origin!==appOrigin)throw Error('Invalid tracing app address.');}
  const id=randomUUID(),command='npm run dev:studio',plan={id,root,frontend:frontend.directory,package:packageName,before,after,rows,watched,command,backendCommand,backendDirectory,appOrigin};plans.clear();plans.set(id,plan);
  return {id,frontend:frontend.directory,command,backendCommand,changes:[{path:packageName,detail:'Adds dev:studio. Existing scripts remain available.',diff:` dev: ${dev}\n+dev:studio: ${nextScript}`},{path:managed+'/vite.config.mjs',detail:'Loads the original config and adds development tracing.',diff:config},...(backendCommand?[{path:managed+'/studio_app.py',detail:'Separate development backend entry point with shutdown cleanup.',diff:rows.at(-1).after}]:[]),{path:managed+'/kit/',detail:`Copies ${rows.length-(backendCommand?2:1)} portable adapter files. No dependency install is run.`}],notice:backendCommand?'Backend request/query capture is configured. With FastAPI, an engine and session factory also enable direct ORM response-model field capture. Custom transformations require explicit field mapping.':'Frontend setup only. Backend tracing requires its request/query adapter; configure the optional backend entry point or follow the kit README.'};
 }
 async function apply(folder,id,appOrigin){
  const root=await fs.realpath(folder),plan=plans.get(id);if(!plan||plan.root!==root)throw Error('Preview the setup again for this app.');
  if(plan.appOrigin&&appOrigin!==plan.appOrigin)throw Error('The app changed after preview. Preview setup again.');
  if(plan.backendOnly)return applyBackend(root,plan);
  if(await read(root,plan.package)!==plan.before)throw Error('package.json changed after preview. Preview again.');
  for(const row of plan.watched){const value=await read(root,row.path);if((value===null?null:digest(value))!==row.hash)throw Error('The Vite config changed after preview. Preview again.');}
  const directory=await safePath(root,managed);await fs.mkdir(directory);const written=[];
  try{
   await fs.mkdir(path.join(directory,'kit'));
   for(const row of plan.rows){await fs.writeFile(await safePath(root,row.path),row.after,{flag:'wx'});written.push(row);}
   if(await read(root,plan.package)!==plan.before)throw Error('package.json changed while preparing setup. Preview again.');
   const journal={version:1,package:plan.package,frontend:plan.frontend,before:plan.before,after:plan.after,files:plan.rows,command:plan.command,backendCommand:plan.backendCommand,backendDirectory:plan.backendDirectory,appOrigin:plan.appOrigin};
   const history={path:managed+'/setup.json',after:JSON.stringify(journal)};await fs.writeFile(await safePath(root,history.path),history.after,{flag:'wx'});written.push(history);
   const temporary=path.join(directory,'package.next');await fs.writeFile(temporary,plan.after,{flag:'wx'});await fs.rename(temporary,await safePath(root,plan.package));
   plans.delete(id);return {installed:true,frontend:plan.frontend,appOrigin:plan.appOrigin,command:plan.command,backendCommand:plan.backendCommand,backendDirectory:plan.backendDirectory,notice:'Restart the app using the tracing command, then refresh evidence. Use the original dev command to run without tracing.'};
  }catch(error){const temp=managed+'/package.next';if(await read(root,temp)===plan.after)await fs.unlink(await safePath(root,temp));await removeOwned(root,written);throw error;}
 }
 async function undo(folder,options={}){
  if(options.backendOnly===true)return undoBackend(folder);
  const saved=await state(folder);if(!saved.installed)throw Error('There is no guided setup to undo.');const {root,journal}=saved;
  for(const row of journal.files)if(await read(root,row.path)!==row.after)throw Error('A generated setup file changed. Keep your edits or restore it before undoing setup.');
  const current=await read(root,journal.package),manifest=JSON.parse(current),previous=JSON.parse(journal.before),expected=JSON.parse(journal.after);
  if(manifest.scripts?.[script]!==expected.scripts?.[script])throw Error('dev:studio changed. Preserve your edits before undoing setup.');
  delete manifest.scripts[script];if(previous.scripts?.[script])manifest.scripts[script]=previous.scripts[script];
  const restored=current===journal.after?journal.before:JSON.stringify(manifest,null,current.match(/\n([ \t]+)"/)?.[1]||'  ')+'\n';
  const temp=await safePath(root,managed+'/package.undo');await fs.writeFile(temp,restored,{flag:'wx'});await fs.rename(temp,await safePath(root,journal.package));
  const history={path:managed+'/setup.json',after:await read(root,managed+'/setup.json')};await removeOwned(root,[...journal.files,history]);return {installed:false,notice:'Guided setup removed. Other package changes and extra files are preserved.'};
 }
 async function launch(folder){
  const saved=await state(folder);if(!saved.installed)throw Error('Apply tracing setup first.');
  const {root,journal}=saved,frontend=journal.frontend;
  if((frontend!=='.'&&!validName(frontend))||journal.package!==path.posix.join(frontend,'package.json')||journal.command!=='npm run dev:studio')throw Error('Tracing launch setup is invalid. Check this app again.');
  const cwd=frontend==='.'?root:await safePath(root,frontend);
  const current=JSON.parse(await read(root,journal.package)),before=JSON.parse(journal.before),dev=before.scripts?.dev;
  if(typeof dev!=='string'||!/^vite(?:\s|$)/.test(dev)||/[;&|<>`$()\r\n]/.test(dev)||/\s--(?:config|root)(?:\s|=)/.test(dev)||/^vite\s+[^-\s]/.test(dev))throw Error('The saved development command is unsupported. Preview setup again.');
  const relative=path.relative(cwd,path.join(root,managed,'vite.config.mjs')).replaceAll('\\','/');
  if(current.scripts?.[script]!==dev+' --config '+JSON.stringify(relative))throw Error('The tracing command changed. Undo and preview setup again before executing.');
  for(const row of journal.files)if(await read(root,row.path)!==row.after)throw Error('Tracing setup files changed. Undo and preview setup again before executing.');
  return {root,cwd,frontend,command:'npm run dev:studio'};
 }
 return {preview,apply,undo,launch,state:async folder=>{const [{journal,root,...result},{journal:backendJournal,root:backendRoot,...backend}]=await Promise.all([state(folder),backendState(folder)]);return {...result,backendInstalled:backend.installed,backend};}};
}
module.exports={createGuidedSetup};
