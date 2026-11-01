// Next's supported custom server interface lets Orivo supply an in-memory
// configuration and place all generated development output in its own profile.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import withStudioTracing from './next.mjs';
import {managedProxy} from './auto-vite.mjs';
import {managedTraceProxy} from './managed-trace-proxy.mjs';
import sourceGuard from './auto-next-guard.cjs';

export function managedRewrites(rewrites,backendUrl,backendPort){
 if(!backendUrl)return rewrites;
 return async function(...args){
  const original=typeof rewrites==='function'?await rewrites.apply(this,args):rewrites||[],groups=Array.isArray(original)?[original]:[original.beforeFiles||[],original.afterFiles||[],original.fallback||[]];
  const proxies={};let index=0;for(const group of groups)for(const route of group)proxies[String(index++)]={target:route.destination};
  const replaced=managedProxy(proxies,backendUrl,backendPort);index=0;
  const mapped=groups.map(group=>group.map(route=>{const target=replaced[String(index++)].target;return target===route.destination?route:{...route,destination:target};}));
  return Array.isArray(original)?mapped[0]:{...original,beforeFiles:mapped[0],afterFiles:mapped[1],fallback:mapped[2]};
 };
}
async function shadowWorkspace(config){
 const shadow=path.join(config.cacheDirectory,'workspace');await fsp.mkdir(shadow,{recursive:true});
 let bytes=0;const sizes=new Map(),ignored=/^(?:\.git|\.next|\.tmp|node_modules|\.studio-tracing|\.orivo-tracing|\.venv|venv|__pycache__|dist|build|coverage|archives?|uploads?|storage|databases?|data|logs?|\.env(?:\..*)?|next\.config\.[cm]?[jt]s|.*(?:secret|credential|password|private[-_]?key).*|.*\.(?:pem|key|p12|pfx|db|sqlite\d*|log|csv|tsv|parquet|zip|map))$/i;
 const inside=(parent,file)=>{const relative=path.relative(parent,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
 async function copy(source,target){const stat=await fsp.lstat(source);if(stat.isSymbolicLink())throw Error('Automatic Next.js attachment does not support linked source folders.');if(stat.isDirectory()){await fsp.mkdir(target,{recursive:true});for(const entry of await fsp.readdir(source,{withFileTypes:true}))if(!ignored.test(entry.name))await copy(path.join(source,entry.name),path.join(target,entry.name));}else if(stat.isFile()){const old=sizes.get(source)||0,nextBytes=bytes-old+stat.size,nextCount=sizes.size+(sizes.has(source)?0:1);if(nextCount>50000||nextBytes>268435456)throw Error('The Next.js source mirror exceeds 50,000 files or 256 MiB. Use a focused frontend folder.');sizes.set(source,stat.size);bytes=nextBytes;await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.copyFile(source,target);}}
 for(const entry of await fsp.readdir(config.directory,{withFileTypes:true}))if(!ignored.test(entry.name))await copy(path.join(config.directory,entry.name),path.join(shadow,entry.name));
 const require=createRequire(path.join(config.directory,'package.json'));let modules=path.join(config.directory,'node_modules');
 try{await fsp.stat(modules);}catch{modules=path.dirname(path.dirname(require.resolve('next/package.json')));}
 await fsp.symlink(modules,path.join(shadow,'node_modules'),process.platform==='win32'?'junction':'dir');
 const wrapper=`import {createManagedNextConfig} from ${JSON.stringify(new URL('./auto-next.mjs',import.meta.url).href)};\nexport default await createManagedNextConfig(${JSON.stringify({...config,shadow})});\n`;
 await fsp.writeFile(path.join(shadow,'next.config.mjs'),wrapper);
 const watcher=fs.watch(config.directory,{recursive:true},(_event,name)=>{
  if(!name||String(name).split(/[\\/]/).some(segment=>ignored.test(segment)))return;
  const relative=String(name),source=path.resolve(config.directory,relative),target=path.resolve(shadow,relative);if(!inside(config.directory,source)||!inside(shadow,target))return;
  // Next owns its copied tsconfig and type declarations. Preserve those local
  // defaults while regular source updates continue to refresh the mirror.
  if(/^(?:tsconfig\.json|next-env\.d\.ts)$/.test(relative))return;
  void (async()=>{try{const actual=await fsp.realpath(source);if(!inside(config.directory,actual))throw Error('A Next.js source folder changed to an external link. Restart automatic tracing.');await copy(source,target);}catch(error){if(error.code==='ENOENT'&&inside(shadow,target)){await fsp.rm(target,{recursive:true,force:true}).catch(()=>{});for(const [file,size] of sizes)if(file===source||inside(source,file)){bytes-=size;sizes.delete(file);}}else{console.error(error.message);process.exit(1);}}})();
 });
 return {shadow,watcher};
}
export async function createManagedNextConfig(config){
 sourceGuard.installSourceGuard(config.root);
 const require=createRequire(path.join(config.directory,'package.json')),loadModule=require('next/dist/server/config'),loadConfig=loadModule.default||loadModule;
 const {PHASE_DEVELOPMENT_SERVER}=require('next/constants'),raw=await loadConfig(PHASE_DEVELOPMENT_SERVER,config.directory,{rawConfig:true});
 let original=raw?.default??raw;if(typeof original==='function')original=await original(PHASE_DEVELOPMENT_SERVER,{defaultConfig:require('next/dist/server/config-shared').defaultConfig});original=await original||{};
 return withStudioTracing({...original,distDir:'.next',rewrites:managedRewrites(original.rewrites,config.backendUrl,config.backendPort)},{enabled:true,projectRoot:config.directory,shadowRoot:config.shadow,repositoryRoot:config.root});
}
async function run(config){
 const require=createRequire(path.join(config.directory,'package.json'));
 await fsp.mkdir(config.cacheDirectory,{recursive:true});const {shadow,watcher}=await shadowWorkspace(config);
 // Normal framework setup writes stay in the profile. The managed preload
 // also applies the source guard to Next's child workers.
 sourceGuard.installSourceGuard(config.root);
 const nextModule=require('next'),next=nextModule.default||nextModule;
 const traceProxy=managedTraceProxy(config);
 let app;const server=http.createServer((req,res)=>{
  if(traceProxy(req,res))return;
  if(req.url==='/__orivo_managed_ready/'+config.readyToken){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(config.readyToken);return;}
  Promise.resolve(app.getRequestHandler()(req,res)).catch(()=>{if(!res.headersSent)res.statusCode=500;res.end();});
 });
 app=next({dev:true,dir:shadow,hostname:(config.browserHost||config.host||'127.0.0.1').replace(/^\[|\]$/g,''),port:config.port,httpServer:server,webpack:true,turbopack:false});
 const close=async()=>{watcher.close();server.close();await app.close();process.exit(0);};process.once('SIGTERM',close);process.once('SIGINT',close);process.once('disconnect',close);
 await app.prepare();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host||'127.0.0.1',resolve);});
 console.log('Orivo managed Next.js frontend ready.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // The generated config imports createManagedNextConfig from this module.
 // Keep its evaluation complete while Next asynchronously loads that config.
 void (async()=>{if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Orivo launch configuration is required.');await run(JSON.parse(await fsp.readFile(process.argv[3],'utf8')));})().catch(error=>{console.error(error.message);process.exit(1);});
}
