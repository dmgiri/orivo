import { mkdir, readFile, writeFile, readdir, cp, rename, rm, stat, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAssets } from './windows-assets.mjs';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const require=createRequire(import.meta.url);
if(process.platform!=='win32'||process.arch!=='x64')throw Error('This release builder currently supports Windows x64 only.');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(pkg.version)||pkg.productName!=='Orivo')throw Error('Expected a semver Orivo package.');
const runtime=path.dirname(require('electron'));
const runtimeVersion=(await readFile(path.join(runtime,'version'),'utf8')).trim();
if(runtimeVersion!==pkg.devDependencies.electron)throw Error(`Electron runtime ${runtimeVersion} differs from the locked dependency.`);
const binary=await readFile(path.join(runtime,'electron.exe'));
const peOffset=binary.readUInt32LE(0x3c);
if(binary.readUInt16LE(peOffset+4)!==0x8664)throw Error('The available Electron runtime is not Windows x64.');
const releases=path.join(root,'dist','releases');
const name=`Orivo-${pkg.version}-beta-win32-x64`;
const destination=path.join(releases,name);
const scratch=path.join(root,'.tmp',`release-build-${process.pid}-${Date.now()}`);
const staging=path.join(scratch,name);
await mkdir(staging,{recursive:true});await mkdir(releases,{recursive:true});
function run(command,args,options={}){return new Promise((resolve,reject)=>{let output='';const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],...options});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('exit',code=>code===0?resolve(output):reject(Error(`${path.basename(command)} exited ${code}: ${output.slice(-4000)}`)));});}
async function exists(file){try{await stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function removeRelease(file){const relative=path.relative(releases,path.resolve(file));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Refusing to replace a path outside the release directory.');await rm(file,{recursive:true,force:true});}
async function safeCopy(source,target){const info=await lstat(source);if(info.isSymbolicLink())throw Error(`Release inputs must not be symlinks: ${source}`);if(info.isDirectory()){await mkdir(target,{recursive:true});for(const entry of await readdir(source)){if(entry.startsWith('.')||entry==='node_modules'||entry==='__pycache__'||entry==='evidence'||entry==='test'||entry==='package-lock.json')continue;await safeCopy(path.join(source,entry),path.join(target,entry));}}else if(info.isFile()){await mkdir(path.dirname(target),{recursive:true});await cp(source,target);}}
const runtimeEntries=['chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','electron.exe','ffmpeg.dll','icudtl.dat','LICENSE','LICENSES.chromium.html','locales','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll'];
for(const entry of runtimeEntries)await safeCopy(path.join(runtime,entry),path.join(staging,entry));
await rename(path.join(staging,'electron.exe'),path.join(staging,'Orivo.exe'));
const application=path.join(staging,'resources','app');await mkdir(application,{recursive:true});
// Explicit runtime-only allowlist: no developer dependencies, caches, test traces, or repository metadata.
for(const entry of ['main.cjs','host-security.cjs','product-store.cjs','product-diagnostics.cjs','trace-store.cjs','editor-source.cjs','trace-health.cjs','project-map-store.cjs','page-runtime.cjs','session-navigation.cjs','diagram-studio.cjs','trace-to-diagram.cjs','preload.cjs','renderer','engine','adapters','demo','vendor','THIRD_PARTY_NOTICES.md'])await safeCopy(path.join(root,entry),path.join(application,entry));
await writeFile(path.join(application,'package.json'),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,description:pkg.description,main:pkg.main,license:pkg.license,releaseChannel:'beta'},null,2)+'\n');
await writeAssets(root,pkg.version,scratch);
for(const entry of await readdir(path.join(root,'resources'))){if(entry!=='ai')await safeCopy(path.join(root,'resources',entry),path.join(application,'resources',entry));}
const branding=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','windows-resources.ps1'),'-Executable',path.join(staging,'Orivo.exe'),'-Icon',path.join(root,'resources','orivo.ico'),'-VersionInfo',path.join(scratch,'version-info.bin')]);
console.log(branding.trim());
await cp(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(staging,'THIRD_PARTY_NOTICES.md'));
await writeFile(path.join(staging,'START-HERE.txt'),`ORIVO ${pkg.version} BETA — WINDOWS x64\r\n\r\nExtract this entire folder before launching Orivo.exe.\r\nKeep its DLLs, locales, resources and license files alongside the executable.\r\nNo separate Node.js or npm installation is needed.\r\n\r\nOpen the included demo or connect your running development application and source\r\nfolder. Complete database paths need tracing adapters.\r\nMinimum desktop window size: 1100 x 700.\r\n\r\nUser settings: %APPDATA%\\Orivo\r\nThis beta is unsigned and has no automatic update service.\r\nNo publisher identity or stable-release status is implied.\r\n\r\nTo update: close Orivo, extract the new version into a different folder, then\r\nlaunch that version. Keep your user-data folder to retain settings.\r\nTo remove the app: close it and delete its extracted folder. Removing settings\r\nis a separate choice; user data is never deleted by the application package.\r\n`);
await cp(path.join(root,'docs','RELEASE.md'),path.join(staging,'RELEASE.md'));
async function hashFile(file){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){bytes+=chunk.length;hash.update(chunk);}return {bytes,sha256:hash.digest('hex')};}
async function inventory(directory,prefix=''){const files=[];for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name),relative=prefix+entry.name;if(entry.isDirectory())files.push(...await inventory(file,relative+'/'));else{const digest=await hashFile(file);files.push({path:relative,...digest});}}return files;}
const files=await inventory(staging);
const manifest={schemaVersion:1,product:'Orivo',version:pkg.version,releaseChannel:'beta',platform:'win32',architecture:'x64',electron:runtimeVersion,builtAt:new Date().toISOString(),distribution:'portable',requiresNode:false,codeSigning:{signed:false,publisher:null},automaticUpdates:false,minimumWindow:{width:1100,height:700},files};
await writeFile(path.join(staging,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(await exists(destination))await removeRelease(destination);
await rename(staging,destination);
const zip=path.join(releases,name+'.zip');if(await exists(zip))await removeRelease(zip);
const sevenZip=path.join(process.env.ProgramFiles||'C:\\Program Files','7-Zip','7z.exe');
if(await exists(sevenZip))await run(sevenZip,['a','-tzip','-mx=7','-mmt=on',zip,name],{cwd:releases});
else await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath '${destination.replaceAll("'","''")}' -DestinationPath '${zip.replaceAll("'","''")}' -CompressionLevel Optimal`]);
const archive=await readFile(zip),archiveHash=createHash('sha256').update(archive).digest('hex');
const releaseManifest={...manifest,files:undefined,fileCount:files.length,uncompressedBytes:files.reduce((total,file)=>total+file.bytes,0),archive:{file:path.basename(zip),bytes:archive.length,sha256:archiveHash}};
const manifestFile=path.join(releases,name+'.manifest.json');await writeFile(manifestFile,JSON.stringify(releaseManifest,null,2)+'\n');
const manifestHash=createHash('sha256').update(await readFile(manifestFile)).digest('hex');
await writeFile(path.join(releases,'SHA256SUMS.txt'),`${archiveHash}  ${path.basename(zip)}\n${manifestHash}  ${path.basename(manifestFile)}\n`);
console.log(JSON.stringify({built:true,executable:path.join(destination,'Orivo.exe'),archive:zip,archiveBytes:archive.length,fileCount:files.length,sha256:archiveHash,signed:false,channel:'beta'},null,2));
const installerSource=path.join(root,'scripts','installer','OrivoSetup.cs');
if(await exists(installerSource))console.log((await run(process.execPath,[path.join(root,'scripts','build-installer.mjs')])).trim());
else console.log('Installer source is not included; portable package built.');
