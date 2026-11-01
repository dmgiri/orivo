// Real Next.js 16 webpack client + ordinary Node HTTP/SQLite application.
// Dependency installation is deliberately separate from this acceptance test.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,realpath,symlink,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),require=createRequire(import.meta.url),id='automatic-next-'+Date.now();
const deps=path.resolve(process.env.ORIVO_NEXT_DEPS||path.join(root,'.tmp/next-automatic-deps'));
const dependencyRequire=createRequire(path.join(deps,'package.json'));
const nextVersion=dependencyRequire('next/package.json').version;
assert.match(nextVersion,/^16\./,'Install Next.js 16 into an isolated dependency folder first.');
const fixture=path.join(root,'.tmp/product-fixture',id),evidence=fixture+'-evidence';
await mkdir(path.join(fixture,'frontend/pages'),{recursive:true});await mkdir(path.join(fixture,'backend'),{recursive:true});await mkdir(evidence,{recursive:true});
const fixtureModules=path.join(fixture,'frontend/node_modules');await mkdir(fixtureModules);
for(const entry of await readdir(path.join(deps,'node_modules'),{withFileTypes:true})){
 if(entry.name.startsWith('.'))continue;
 const source=path.join(deps,'node_modules',entry.name),destination=path.join(fixtureModules,entry.name);
 if(entry.name.startsWith('@')){await mkdir(destination);for(const child of await readdir(source,{withFileTypes:true}))if(child.isDirectory()||child.isSymbolicLink())await symlink(path.join(source,child.name),path.join(destination,child.name),process.platform==='win32'?'junction':'dir');}
 else if(entry.isDirectory()||entry.isSymbolicLink())await symlink(source,destination,process.platform==='win32'?'junction':'dir');
}
const reactVersion=dependencyRequire('react/package.json').version;
await writeFile(path.join(fixture,'frontend/package.json'),JSON.stringify({name:'ordinary-next-product',private:true,dependencies:{next:nextVersion,react:reactVersion,'react-dom':reactVersion},scripts:{dev:'next dev'}}));
const typescript=process.argv.includes('--typescript');
await writeFile(path.join(fixture,'frontend',typescript?'next.config.ts':'next.config.mjs'),typescript?`import type {NextConfig} from 'next';\nconst config:NextConfig={reactStrictMode:true,async rewrites(){return [{source:'/api/:path*',destination:'http://127.0.0.1:32001/api/:path*'}]}};export default config;\n`:`export default {reactStrictMode:true,async rewrites(){return [{source:'/api/:path*',destination:'http://127.0.0.1:32001/api/:path*'}]}};\n`);
if(typescript){
 const supplied=process.env.ORIVO_TYPESCRIPT_DEPS;assert.ok(supplied,'Set ORIVO_TYPESCRIPT_DEPS to existing TypeScript/@types packages for --typescript.');
 const sourceRequire=createRequire(path.join(path.resolve(supplied),'package.json'));
 for(const name of ['typescript','@types/react','@types/node']){
  const destination=path.join(fixtureModules,name);await mkdir(path.dirname(destination),{recursive:true});
  try{await realpath(destination);}catch{await symlink(path.dirname(sourceRequire.resolve(name+'/package.json')),destination,process.platform==='win32'?'junction':'dir');}
 }
 await writeFile(path.join(fixture,'frontend/tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2017',lib:['dom','dom.iterable','esnext'],allowJs:true,skipLibCheck:true,strict:true,noEmit:true,esModuleInterop:true,module:'esnext',moduleResolution:'bundler',resolveJsonModule:true,isolatedModules:true,jsx:'preserve'},include:['next-env.d.ts','**/*.ts','**/*.tsx'],exclude:['node_modules']},null,2));
 await writeFile(path.join(fixture,'frontend/next-env.d.ts'),'/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
}
const sourceFile=path.join(fixture,'frontend/pages',typescript?'index.tsx':'index.jsx');
const source=`import React,{useEffect,useState} from 'react';
export default function Shipments(){const [data,setData]=useState${typescript?'<{items:{reference:string}[]}|null>':''}(null);useEffect(()=>{fetch('/api/parcels').then(r=>r.json()).then(setData)},[]);return <main><h1>Next automatic attachment</h1>{data&&<strong id="reference">{data.items[0].reference}</strong>}</main>}
`;
await writeFile(sourceFile,source);
await writeFile(path.join(fixture,'backend/package.json'),JSON.stringify({name:'ordinary-next-api',engines:{node:'>=24.13.0'},scripts:{dev:'node server.cjs'}}));
await writeFile(path.join(fixture,'backend/server.cjs'),`const http=require('node:http');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE parcels(reference TEXT); INSERT INTO parcels VALUES('NEXT-AUTO-314')");http.createServer(function parcelRequest(req,res){const rows=db.prepare('SELECT reference FROM parcels').all();res.setHeader('content-type','application/json');res.end(JSON.stringify({items:rows}));}).listen(32001,'127.0.0.1');\n`);
async function snapshot(directory=fixture,prefix=''){const result={};for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name==='node_modules')continue;const file=path.join(directory,entry.name),name=prefix+entry.name;if(entry.isDirectory())Object.assign(result,await snapshot(file,name+'/'));else result[name]=createHash('sha256').update(await readFile(file)).digest('hex');}return result;}
const original=await snapshot(),checks=[],errors=[];let app;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message,timeout=35000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(70);}throw Error(message);}
try{
 const bootstrap=path.join(evidence,'bootstrap.cjs');await writeFile(bootstrap,`const {app,BrowserWindow}=require('electron');BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};BrowserWindow.prototype.moveTop=function(){};app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));require(${JSON.stringify(path.join(root,'main.cjs'))});`);
 const env={...process.env,TRACE_ATLAS_TEST_PROFILE:id,ORIVO_START_MODE:'welcome'};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:require('electron'),args:[bootstrap],env,timeout:30000});const shell=await app.firstWindow();shell.setDefaultTimeout(40000);shell.on('pageerror',error=>errors.push(error.message));
 await shell.waitForFunction(()=>typeof window.traceAtlas?.detectAttachment==='function');
 await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},fixture);
 await shell.evaluate(()=>window.traceAtlas.connectRepository());await shell.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()));
 const detected=await shell.evaluate(()=>window.traceAtlas.detectAttachment());assert.equal(detected.selected.frontend,'next:frontend');assert.equal(detected.backends.length,1);assert.deepEqual(detected.issues,[]);
 await shell.locator('#attach-button').click();
 const state=await until(async()=>{const state=await shell.evaluate(()=>window.traceAtlas.getState());if(state.attachment?.status==='failed')throw Error(state.attachment.notice+'\n'+state.attachment.output);return state.attachment?.status==='running'&&!state.loading?state:false;},'Next managed preview did not start',70000);
 checks.push('The real Attach tracing button detects Next.js 16 and an ordinary Node HTTP server and starts both without project hooks');
 const previewId=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(url))?.id,state.url);assert.ok(previewId);
 const evaluate=script=>app.evaluate(({webContents},{id,script})=>webContents.fromId(id).executeJavaScript(script),{id:previewId,script});
 await until(()=>evaluate("document.querySelector('#reference')?.textContent==='NEXT-AUTO-314'"),'The Next client did not hydrate and render its managed API response');
 await shell.evaluate(()=>{window.__nextTrace=null;window.addEventListener('trace-atlas:graph',event=>{window.__nextTrace=event.detail;});});
 async function pick(){
  await shell.evaluate(()=>{window.__nextTrace=null;});await shell.locator('#inspect-button').click();await shell.locator('#inspect-button.inspecting').waitFor();
  await app.evaluate(async({webContents},id)=>{const contents=webContents.fromId(id),point=await contents.executeJavaScript("(()=>{const r=document.querySelector('#reference').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");contents.sendInputEvent({type:'mouseMove',...point});contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});},previewId);
  await shell.waitForFunction(()=>window.__nextTrace);return shell.evaluate(()=>window.__nextTrace);
 }
 const trace=await pick();await writeFile(path.join(evidence,'complete-trace.json'),JSON.stringify(trace,null,2));
 assert.equal(trace.coverage,'complete',JSON.stringify(trace.gaps));assert.deepEqual(trace.gaps,[]);
 const client=trace.nodes.find(node=>node.kind==='source'&&node.file===`frontend/pages/index.${typescript?'tsx':'jsx'}`);assert.ok(client,'Original source path survives profile mirroring');
 assert.ok(trace.nodes.some(node=>node.kind==='backend'&&node.file==='backend/server.cjs'));assert.ok(trace.nodes.some(node=>node.kind==='query'&&node.code.includes('SELECT reference FROM parcels')));assert.ok(trace.nodes.some(node=>node.kind==='database'&&node.label==='parcels.reference'));
 checks.push('A genuine native selection proves original Next client source → managed API → original Node handler → actual SQLite SELECT → parcels.reference');
 assert.deepEqual(await snapshot(),original);checks.push('All original source files, Next configuration and TypeScript configuration remain byte for byte unchanged');
 const changed=source.replace('Next automatic attachment','Next attachment updated');await writeFile(sourceFile,changed);
 await until(()=>evaluate("document.querySelector('h1')?.textContent==='Next attachment updated'"),'The Next profile mirror did not refresh after a source edit',45000);
 await until(async()=>{if((await shell.evaluate(()=>window.traceAtlas.getState())).loading)return false;try{await shell.evaluate(()=>window.traceAtlas.refreshSource());return true;}catch(error){if(error.message.includes('changed during refresh'))return false;throw error;}},'The Next navigation did not settle for a fresh source index');
 const updated=await pick();assert.equal(updated.coverage,'complete',JSON.stringify(updated.gaps));checks.push('Source edits update the profile mirror and refresh Next with fresh original source hashes and complete tracing');
 await writeFile(sourceFile,source);
 const info=await shell.evaluate(()=>window.traceAtlas.getProductInfo()),automatic=path.join(info.dataDirectory,'automatic'),ports=[];
 for(const directory of await readdir(automatic))for(const name of ['frontend.json','backend.json'])try{const row=JSON.parse(await readFile(path.join(automatic,directory,name),'utf8'));if(row.root===fixture)ports.push(row.port);}catch{}
 await shell.evaluate(()=>window.traceAtlas.stopAttachment());
 for(const port of ports)await until(async()=>{try{await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(400)});return false;}catch{return true;}},'An owned Next or API port survived Stop');
 assert.deepEqual(await snapshot(),original);assert.deepEqual(errors,[]);checks.push('Stop closes both owned servers and preserves the original project file list and bytes');
 const result={passed:true,checks,typescript,nextVersion,fixture,evidence,rendererErrors:errors};await writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:false,error:error.stack,checks,rendererErrors:errors},null,2));console.error('Next acceptance artifacts: '+evidence);throw error;}finally{if(app)await app.close();await writeFile(sourceFile,source);}
