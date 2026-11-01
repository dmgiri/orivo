import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, access, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const releases=path.join(root,'dist','releases');
const releaseName=`Orivo-${pkg.version}-beta-win32-x64`;
const archive=path.join(releases,releaseName+'.zip');
const extraction=path.join(root,'.tmp',`packaged-extraction-${Date.now()}`,'Path with spaces');
let app,closed=false;
try{
await mkdir(extraction,{recursive:true});
const sevenZip=path.join(process.env.ProgramFiles||'C:\\Program Files','7-Zip','7z.exe');
let hasSevenZip=true;try{await access(sevenZip);}catch{hasSevenZip=false;}
if(hasSevenZip)execFileSync(sevenZip,['x','-y',`-o${extraction}`,archive],{windowsHide:true,stdio:'pipe'});
else execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${extraction.replaceAll("'","''")}'`],{windowsHide:true,stdio:'pipe'});
const directory=path.join(extraction,releaseName);
const executable=path.join(directory,'Orivo.exe');
const manifest=JSON.parse(await readFile(path.join(directory,'release-manifest.json'),'utf8'));
assert.equal(manifest.product,'Orivo');assert.equal(manifest.releaseChannel,'beta');assert.equal(manifest.requiresNode,false);
const checks=[];
async function hashFile(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function filesIn(folder,prefix=''){const found=[];for(const entry of await readdir(folder,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isDirectory())found.push(...await filesIn(path.join(folder,entry.name),relative+'/'));else found.push(relative);}return found.sort();}
for(const file of manifest.files){assert.ok(!file.path.includes('..'));const location=path.join(directory,file.path);assert.equal((await stat(location)).size,file.bytes,file.path);assert.equal(await hashFile(location),file.sha256,file.path);}
for(const file of manifest.files.filter(file=>file.path.startsWith('resources/app/')&&file.path!=='resources/app/package.json')){const current=path.join(root,file.path.slice('resources/app/'.length));assert.equal(await hashFile(current),file.sha256,`Release source changed after packaging: ${file.path}. Run build:win again.`);}
const actual=await filesIn(directory);
assert.deepEqual(actual,[...manifest.files.map(file=>file.path),'release-manifest.json'].sort());
assert.ok(!actual.some(file=>/(^|\/)(?:node_modules|test|evidence|\.tmp|\.git|\.env)(\/|$)/.test(file)));
assert.ok(!actual.some(file=>/default_app\.asar$|electron\.exe$|package-lock\.json$/.test(file)));
checks.push(`Verified SHA-256 inventory of ${manifest.files.length} shipped files, matching current application source; no development data or dependencies`);
const windowsInfo=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p='${executable.replaceAll("'","''")}'; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p); [PSCustomObject]@{ProductName=$v.ProductName;OriginalFilename=$v.OriginalFilename;FileVersion=$v.FileVersion;Signature=(Get-AuthenticodeSignature -LiteralPath $p).Status.ToString()} | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
assert.equal(windowsInfo.ProductName,'Orivo');assert.equal(windowsInfo.OriginalFilename,'Orivo.exe');assert.notEqual(windowsInfo.Signature,'Valid');
checks.push('Native Windows executable has Orivo product metadata; unsigned status is explicit');
const profile='packaged-'+Date.now(),env={...process.env,TRACE_ATLAS_TEST_PROFILE:profile,ORIVO_START_MODE:'welcome'};delete env.ELECTRON_RUN_AS_NODE;
const rendererErrors=[];
const started=performance.now();
  app=await electron.launch({executablePath:executable,args:[],env,timeout:30000,cwd:directory});
  const shell=await app.firstWindow();shell.setDefaultTimeout(20000);shell.on('pageerror',error=>rendererErrors.push(error.message));
  await shell.locator('#welcome-dialog[open]').waitFor();
  await shell.locator('#welcome-demo').click();
  await shell.locator('#coverage-badge').filter({hasText:'Element to column captured'}).waitFor();
  const identity=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,name:app.getName(),version:app.getVersion(),executable:app.getPath('exe'),userData:app.getPath('userData'),minimum:BrowserWindow.getAllWindows()[0].getMinimumSize(),visible:BrowserWindow.getAllWindows()[0].isVisible()}));
  assert.equal(identity.packaged,true);assert.equal(identity.name,'Orivo');assert.equal(identity.version,pkg.version);assert.equal(path.resolve(identity.executable).toLowerCase(),executable.toLowerCase());assert.equal(identity.visible,true);
  assert.equal(path.resolve(identity.userData).toLowerCase(),path.join(os.tmpdir(),'orivo-tests',`test-profile-${profile}`).toLowerCase());
  assert.deepEqual(identity.minimum,[1100,700]);
  checks.push('Extracted the ZIP and launched self-contained Orivo.exe from a path with spaces; packaged identity and isolated user profile verified');
  const state=await shell.evaluate(()=>window.traceAtlas.getState());
  assert.ok(state.demo);assert.ok(state.url.startsWith('http://127.0.0.1:'));
  const nativePreview=()=>app.evaluate(({BrowserWindow})=>{const view=BrowserWindow.getAllWindows()[0].contentView.children[0];return{visible:view.getVisible(),bounds:view.getBounds()};});
  const normalPreview=await nativePreview();
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(async()=>{const current=await window.traceAtlas.getState();return current.previewMaximized===true&&document.body.classList.contains('preview-maximized');});
  let expandedGeometry,expandedNative;
  for(let attempt=0;attempt<40;attempt++){
    expandedGeometry=await shell.evaluate(()=>{const rect=document.querySelector('#preview-surface').getBoundingClientRect();return{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height),viewport:{width:innerWidth,height:innerHeight}};});
    expandedNative=await nativePreview();
    if(expandedNative.visible&&['x','y','width','height'].every(key=>Math.abs(expandedNative.bounds[key]-expandedGeometry[key])<=1))break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal(expandedNative.visible,true);
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(expandedNative.bounds[key]-expandedGeometry[key])<=1,`Maximized native ${key} must follow the workspace surface`);
  assert.ok(expandedNative.bounds.width>expandedGeometry.viewport.width*0.7,'Maximized native preview must fill the workspace width');
  assert.ok(expandedNative.bounds.height>expandedGeometry.viewport.height*0.55,'Maximized native preview must fill the workspace height');
  assert.equal(await shell.locator('.main-content').isVisible(),false);
  assert.equal(await shell.locator('#expand-preview').getAttribute('aria-pressed'),'true');
  await shell.locator('#expand-preview').click();
  await shell.waitForFunction(async()=>{const current=await window.traceAtlas.getState();return current.previewMaximized===false&&!document.body.classList.contains('preview-maximized');});
  let restoredNative;
  for(let attempt=0;attempt<40;attempt++){restoredNative=await nativePreview();if(restoredNative.visible&&Math.abs(restoredNative.bounds.width-normalPreview.bounds.width)<=1)break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(restoredNative.visible,true);assert.ok(Math.abs(restoredNative.bounds.width-normalPreview.bounds.width)<=1,'Restore must return the native preview to the explorer');
  assert.equal(await shell.locator('.main-content').isVisible(),true);
  assert.equal(await shell.locator('#expand-preview').getAttribute('aria-pressed'),'false');
  checks.push('Packaged Maximize expands the actual native preview across the workspace; Restore returns to the normal trace layout');
  assert.match(await shell.locator('#trace-graph').textContent(),/products\.price/);
  await shell.locator('.graph-node[data-node^="query-"]').click();
  await shell.locator('[data-inspector="sql"]').click();
  assert.match(await shell.locator('#code-content').textContent(),/SELECT.+FROM products/s);
  checks.push('Bundled real SQLite demo captures element → source → request → backend → query → products.price');
  const previewBoundary=await app.evaluate(async({webContents},url)=>{const target=webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(url));return target.executeJavaScript('({require:typeof require,process:typeof process,bridge:typeof window.traceAtlas})');},state.url);
  assert.deepEqual(previewBoundary,{require:'undefined',process:'undefined',bridge:'undefined'});
  const graph=await shell.evaluate(()=>window.traceAtlas.capture('[data-trace-id="price-orbit"]'));
  const exportPath=path.join(identity.userData,'packaged-trace.json');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportPath);
  await shell.evaluate(id=>window.traceAtlas.exportTrace(id),graph.id);
  const exported=JSON.parse(await readFile(exportPath,'utf8'));assert.equal(exported.graph.coverage,'complete');
  assert.ok(exported.graph.nodes.some(node=>node.kind==='database'&&node.label==='products.price'));
  checks.push('Native JSON export contains captured column evidence; target preview has no Node or privileged bridge');
  const visual=await shell.evaluate(()=>({blur:[...document.querySelectorAll('*')].some(element=>{const style=getComputedStyle(element);return /blur\(/.test(style.filter+' '+style.backdropFilter);}),mobile:!!document.querySelector('#mobile-preview'),theme:document.documentElement.dataset.theme}));
  assert.equal(visual.blur,false);assert.equal(visual.mobile,false);assert.equal(visual.theme,'dark');
  checks.push('Desktop-only dark interface contains no CSS blur');
  assert.deepEqual(rendererErrors,[]);
  const shutdown=performance.now();await app.close();closed=true;
  checks.push('Packaged app closes cleanly without a background service');
  const result={passed:true,product:'Orivo',version:pkg.version,channel:'beta',executable:path.join(releases,releaseName,'Orivo.exe'),testedArchive:archive,extractedArchive:true,signature:windowsInfo.Signature,checks,rendererErrors,elapsedMilliseconds:Math.round(performance.now()-started),shutdownMilliseconds:Math.round(performance.now()-shutdown),runAt:new Date().toISOString()};
  await writeFile(path.join(releases,'packaged-smoke-result.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(releases,releaseName+'.smoke.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{if(app&&!closed)await app.close().catch(()=>{});const ownedParent=path.dirname(extraction),relative=path.relative(path.join(root,'.tmp'),ownedParent);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(ownedParent).startsWith('packaged-extraction-'))await rm(ownedParent,{recursive:true,force:true});}
