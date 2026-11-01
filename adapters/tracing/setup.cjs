const fs=require('node:fs/promises'),path=require('node:path');
const {createRequire}=require('node:module');
async function dependencyVersion(directory,name,declared){
 let version=null,installed=false;
 if(declared)for(const modules of (createRequire(path.join(directory,'package.json')).resolve.paths(name)||[]).slice(0,32))try{
  // Resolve from this app so nested and hoisted workspace dependencies agree
  // with the development executable it actually runs. Only inspect its manifest.
  const file=path.join(modules,name,'package.json'),stat=await fs.stat(file);installed=true;
  if(stat.isFile()&&stat.size<=65536)version=JSON.parse(await fs.readFile(file,'utf8')).version;
  break;
 }catch(error){if(installed)break;}
 const value=installed?version:declared;
 // A missing install can be previewed for an unambiguous major. Broad ranges,
 // tags and workspace references need the actual installed version first.
 const match=typeof value==='string'?value.trim().match(installed?/^(\d+)\.\d+\.\d+(?:[-+].*)?$/:/^[~^]?(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?$/):null;
 const major=match?Number(match[1]):null;
 return {version:typeof version==='string'?version:null,installed,major,known:major!==null};
}
async function describeProject(folder){
 const root=await fs.realpath(folder),frontends=[],backends=[],gaps=[];
 async function text(name){try{const file=path.join(root,name),actual=await fs.realpath(file),relative=path.relative(root,actual);if(relative.startsWith('..')||path.isAbsolute(relative)||(await fs.stat(actual)).size>65536)return null;return await fs.readFile(actual,'utf8');}catch{return null;}}
 const directories=[''];
 async function discover(directory){try{for(const entry of (await fs.readdir(path.join(root,directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(directories.length>=64)break;if(entry.isDirectory()&&!entry.name.startsWith('.')&&!/^(?:node_modules|dist|build|archives?|venv|__pycache__)$/i.test(entry.name))directories.push(path.join(directory,entry.name));}}catch{}}
 await discover('');for(const directory of [...directories].filter(name=>/^(?:apps|packages)$/.test(name)))await discover(directory);
 for(const directory of directories){
  const raw=await text(path.join(directory,'package.json'));if(!raw)continue;let value;try{value=JSON.parse(raw);}catch{continue;}
  const dependencies={...value.dependencies,...value.devDependencies},framework=dependencies.next?'Next.js':dependencies.react?'React':dependencies.vue?'Vue':dependencies.svelte?'Svelte':'JavaScript';
  const vite=await dependencyVersion(path.join(root,directory),'vite',dependencies.vite),next=await dependencyVersion(path.join(root,directory),'next',dependencies.next),guided=framework==='React'&&vite.major>=5&&vite.major<=8,automatic=guided||framework==='Next.js'&&next.major===16;
  const reason=framework==='Next.js'?automatic?'Client DOM binding and same-origin fetch/JSON capture with Next.js 16 webpack. Export the kit and wrap your existing next.config with withStudioTracing; guided setup, Turbopack and server-component provenance are not available.':!next.known?'Install the app dependencies so Studio can verify its Next.js version. The manual client tracing adapter supports Next.js 16 webpack.':'The manual client tracing adapter supports Next.js 16 webpack. Use the explicit browser adapter for this version.':automatic?'Automatic intrinsic JSX binding and same-origin fetch/JSON capture.':framework==='React'&&dependencies.vite&&!vite.known?'Install the app dependencies so Studio can verify its Vite version. React with Vite 5–8 supports automatic tracing.':'Use the explicit browser adapter. Automatic JSX capture supports React with Vite 5–8; other compiler adapters are not available.';
  const portMatch=typeof value.scripts?.dev==='string'?value.scripts.dev.match(/(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/):null,devPort=portMatch?Number(portMatch[1]):null;
  if(dependencies.vite||framework!=='JavaScript')frontends.push({directory:directory.replaceAll('\\','/')||'.',framework,bundler:dependencies.next?'Next.js':dependencies.vite?'Vite':'Other',automatic,guided,viteVersion:vite.version,nextVersion:next.version,devPort:devPort>0&&devPort<=65535?devPort:null,reason});
  if(value.engines?.node||dependencies.fastify||dependencies.express||dependencies['better-sqlite3']||dependencies['@prisma/client'])backends.push({directory:directory||'.',framework:'Node.js',adapter:'Node HTTP middleware + built-in SQLite result fields; other database drivers need an execution adapter.'});
 }
 for(const directory of directories){
  const manifests=await Promise.all(['pyproject.toml','requirements.txt'].map(name=>text(path.join(directory,name)))),joined=manifests.filter(Boolean).join('\n');
  if(/fastapi|starlette/i.test(joined))backends.push({directory:directory||'.',framework:/fastapi/i.test(joined)?'FastAPI':'Starlette',adapter:/sqlalchemy/i.test(joined)?'Request + SQLAlchemy execution + direct ORM field serialization':/psycopg/i.test(joined)?'Request capture + PostgreSQL result-column adapter':'Request capture; configure a database execution adapter.'});
 }
 if(!frontends.length)gaps.push('No supported frontend manifest detected. Use the framework-neutral browser adapter or configure source roots explicitly.');
 if(!backends.length)gaps.push('No supported backend manifest detected. Frontend tracing can still work; backend/query evidence requires an adapter.');
 return {root,frontends,backends,gaps,kit:path.resolve(__dirname),instructions:[
  'Add the tracing package to the app as a local development dependency, or export a kit with studio-trace bundle.',
  'React/Vite: add studioTracing({repositoryRoot: YOUR_REPOSITORY_ROOT}) to vite.config. Start the dev server with STUDIO_TRACE=1. Configure include for nonstandard source folders.',
  'Next.js 16: export the kit, wrap your existing next.config with withStudioTracing from next.mjs and set repositoryRoot to the connected folder. Enable STUDIO_TRACE=1 and start next dev --webpack. Only client DOM and same-origin fetch/JSON tracing are supported; Turbopack, server components and server actions are not traced.',
  'Node.js: createTracing({repositoryRoot, development:true}) from @orivo/tracing/node-http provides handler/middleware and read(database, sql, parameters). Map direct SQLite result fields with result.field(row, column, "items.0.name"). Other Node database drivers need execution adapters.',
  'FastAPI: install the Python package, call studio_tracing.setup(app, repository_root, development=enabled, engine=engine, sessions=Session, response_models=True), and call its returned detach function at shutdown. Plain Pydantic v2 response models can capture direct ORM attributes, aliases, lists and envelopes.',
  'Use studio_tracing.serialize(model, output_to_attribute_map, path="items.0") for explicit direct ORM field mappings. Custom validators, serializers, DTOs and arbitrary computations do not automatically inherit database origins.',
  'Use the same repository root on the frontend, backend and Orivo. Proxy the API through the frontend origin; cross-origin tracing is not supported yet.',
  'Restart traced servers after source changes, reload the app, select an element, and check Element flow. Coverage details explain unsupported or unproven connections. Production builds exclude the Vite tracing plugin.'
 ]};
}
function frontendMatch(frontends,url,paths=[]){
 const rows=frontends.filter(row=>row.automatic),port=Number(new URL(url).port||(new URL(url).protocol==='https:'?443:80));
 const located=rows.filter(row=>paths.some(file=>row.directory==='.'||file.startsWith(row.directory+'/')));
 if(located.length){const depth=Math.max(...located.map(row=>row.directory==='.'?0:row.directory.length)),deepest=located.filter(row=>(row.directory==='.'?0:row.directory.length)===depth);if(deepest.length===1)return {frontend:deepest[0].directory,evidence:'runtime'};}
 const matching=rows.filter(row=>row.devPort===port);if(matching.length===1)return {frontend:matching[0].directory,evidence:'port'};
 return {frontend:rows.length===1?rows[0].directory:null,evidence:rows.length===1?'single':'ambiguous'};
}
function setupMismatch(frontends,state,url,match){
 if(!state?.installed)return '';
 if(state.appOrigin&&state.appOrigin!==new URL(url).origin)return 'Tracing is configured for another app address. Change tracing app to configure this page.';
 if(match?.frontend&&['runtime','port'].includes(match.evidence)&&match.frontend!==state.frontend)return `Tracing is configured for ${state.frontend}, but this page belongs to ${match.frontend}. Change tracing app.`;
 const row=frontends.find(row=>row.directory===state.frontend),port=Number(new URL(url).port||(new URL(url).protocol==='https:'?443:80));
 return row?.devPort&&row.devPort!==port?`Tracing is configured for ${state.frontend} on port ${row.devPort}. This page uses port ${port}. Change tracing app.`:'';
}
module.exports={describeProject,frontendMatch,setupMismatch};
