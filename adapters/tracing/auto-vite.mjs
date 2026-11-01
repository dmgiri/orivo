// Executed by the project's installed Node runtime, never by Electron. The
// launch plan and dependency cache live in Orivo's profile, not the repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import studioTracing from './vite.mjs';
import {managedTraceProxy} from './managed-trace-proxy.mjs';

const localHost=host=>['localhost','127.0.0.1','[::1]','::1','0.0.0.0'].includes(host);
export function managedProxy(proxy,backendUrl,backendPort){
 if(!backendUrl)return proxy;
 const rows=Object.entries(proxy||{}),local=[];
 for(const [key,value] of rows){
  const target=typeof value==='string'?value:value?.target;
  if(typeof target!=='string')continue;
  try{const url=new URL(target);if(['http:','https:','ws:','wss:'].includes(url.protocol)&&localHost(url.hostname))local.push({key,value,url,identity:url.protocol+'//loopback:'+String(url.port||(/^(?:https|wss):$/.test(url.protocol)?443:80))});}catch{}
 }
 if(!local.length)throw Error('The frontend has no local API proxy to attach. Configure a same-origin local API proxy, then start automatic tracing.');
 let selected=local;const origins=new Set(local.map(row=>row.identity));
 if(origins.size>1){selected=backendPort?local.filter(row=>Number(row.url.port||80)===Number(backendPort)):[];if(!selected.length||new Set(selected.map(row=>row.identity)).size!==1)throw Error('The frontend has multiple local backend proxy targets. Choose a backend with a matching development port, or configure one API target before automatic attachment.');}
 const result={...proxy};
 for(const row of selected){const target=new URL(backendUrl);target.pathname=row.url.pathname;target.search=row.url.search;target.username=row.url.username;target.password=row.url.password;if(/^wss?:$/.test(row.url.protocol))target.protocol='ws:';result[row.key]={...(typeof row.value==='object'?row.value:{}),target:target.href};}
 return result;
}

// Vite 5 and early Vite 6 have no in-memory runner config loader. Their installed
// esbuild bundles into the profile while keeping dependency resolution at each
// original module location. No temporary next-to-config files are written.
async function loadVite5Config(directory,cacheDirectory){
 const names=['vite.config.js','vite.config.mjs','vite.config.ts','vite.config.cjs','vite.config.mts','vite.config.cts'];let file;
 for(const name of names)try{const candidate=path.join(directory,name);if((await fs.stat(candidate)).isFile()){file=candidate;break;}}catch{}
 if(!file)return {};
 const require=createRequire(path.join(directory,'package.json')),esbuild=createRequire(require.resolve('vite'))('esbuild');
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')),esm=/\.[m][jt]s$/.test(file)||!/\.[c][jt]s$/.test(file)&&manifest.type==='module';
 const result=await esbuild.build({absWorkingDir:directory,entryPoints:[file],platform:'node',format:esm?'esm':'cjs',target:'node20',bundle:true,write:false,logLevel:'silent',define:{__dirname:'__orivo_config_dirname',__filename:'__orivo_config_filename','import.meta.url':'__orivo_config_url','import.meta.dirname':'__orivo_config_dirname','import.meta.filename':'__orivo_config_filename'},plugins:[{
  name:'orivo-original-config-location',setup(build){
   build.onResolve({filter:/.*/},async args=>{if(args.pluginData?.orivoResolved||args.kind==='entry-point'||args.path.startsWith('.')||path.isAbsolute(args.path))return;const resolved=await build.resolve(args.path,{kind:args.kind,resolveDir:path.dirname(args.importer||file),pluginData:{orivoResolved:true}});if(resolved.errors.length)return {errors:resolved.errors};return {path:esm&&args.kind!=='require-call'&&path.isAbsolute(resolved.path)?pathToFileURL(resolved.path).href:resolved.path,external:true};});
   build.onLoad({filter:/\.[cm]?[jt]s$/},async args=>({contents:`const __orivo_config_dirname=${JSON.stringify(path.dirname(args.path))};const __orivo_config_filename=${JSON.stringify(args.path)};const __orivo_config_url=${JSON.stringify(pathToFileURL(args.path).href)};\n`+await fs.readFile(args.path,'utf8'),loader:/\.[cm]?ts$/.test(args.path)?'ts':'js'}));
  }
 }]});
 await fs.mkdir(cacheDirectory,{recursive:true});const bundled=path.join(cacheDirectory,'original-config.'+(esm?'mjs':'cjs'));await fs.writeFile(bundled,result.outputFiles[0].text);
 let config=(await import(pathToFileURL(bundled).href)).default;if(typeof config==='function')config=await config({command:'serve',mode:'development',isSsrBuild:false,isPreview:false});return await config||{};
}
async function run(config){
 const imported=await import(pathToFileURL(config.viteFile).href),vite=typeof imported.createServer==='function'?imported:imported.default,major=Number(config.viteVersion.split('.')[0]);
 const original=major>=7?(await vite.loadConfigFromFile({command:'serve',mode:'development',isSsrBuild:false,isPreview:false},undefined,config.directory,undefined,undefined,'runner'))?.config||{}:await loadVite5Config(config.directory,config.cacheDirectory);
 const proxy=managedProxy(original.server?.proxy,config.backendUrl,config.backendPort);
 const flatten=async list=>(await Promise.all((list||[]).map(async item=>Array.isArray(item)?flatten(item):await item))).flat().filter(Boolean);
 const plugins=(await flatten(original.plugins)).filter(plugin=>!/^(?:studio-development-tracing|connectodot-development-tracing|connectodot-studio-tracing|studio-tracing)$/.test(plugin.name||''));
 plugins.unshift(studioTracing({enabled:true,repositoryRoot:config.root}));
 plugins.unshift({name:'orivo-managed-readiness',configureServer(server){server.middlewares.use(managedTraceProxy(config));server.middlewares.use((req,res,next)=>{if(req.url==='/__orivo_managed_ready/'+config.readyToken){res.statusCode=200;res.setHeader('Cache-Control','no-store');res.end(config.readyToken);}else next();});}});
 const browserHost=config.browserHost||config.host||'127.0.0.1';
 const server=await vite.createServer({...original,configFile:false,cacheDir:config.cacheDirectory,root:original.root?path.resolve(config.directory,original.root):config.directory,plugins,clearScreen:false,server:{...original.server,host:config.host||'127.0.0.1',port:config.port,strictPort:true,open:false,https:false,proxy,hmr:typeof original.server?.hmr==='object'?{...original.server.hmr,host:browserHost,port:undefined,clientPort:undefined}:original.server?.hmr,...(major>=8&&typeof original.server?.ws==='object'?{ws:{...original.server.ws,host:browserHost,port:undefined,clientPort:undefined}}:{})}});
 const close=async()=>{await server.close();process.exit(0);};process.once('SIGTERM',close);process.once('SIGINT',close);process.once('disconnect',close);
 await server.listen();console.log('Orivo managed frontend ready.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Orivo launch configuration is required.');await run(JSON.parse(await fs.readFile(process.argv[3],'utf8')));}catch(error){console.error(error.message);process.exit(1);}
}
