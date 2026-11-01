import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODEL_ASSET, RUNTIME_ASSET, selectRuntimeAsset, validateModelMetadata} from '../engine/ai-assets.cjs';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const aiRoot=path.join(root,'resources','ai');
const runtimeDirectory=path.join(aiRoot,'runtime',RUNTIME_ASSET.release);
const modelPath=path.join(root,'model',MODEL_ASSET.file);
const manifestPath=path.join(aiRoot,'asset-manifest.json');
if(process.platform!=='win32')throw Error('The pinned Orivo AI runtime asset is Windows x64 only.');

async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function download(url,destination,{sha,sizeBytes,label}){
  let response;
  try{response=await fetch(url,{redirect:'follow',headers:{'user-agent':'Orivo-local-ai-preparer'}});}
  catch(error){throw Error(`${label} download could not connect: ${error.message}`);}
  if(!response.ok||!response.body||new URL(response.url).protocol!=='https:')throw Error(`${label} download failed with HTTP ${response.status}.`);
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&sizeBytes&&declared!==sizeBytes)throw Error(`${label} download reported an unexpected byte length.`);
  const hash=createHash('sha256');let bytes=0,nextReport=64*1024*1024;
  const inspect=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);if(bytes>=nextReport){console.log(`${label}: ${sizeBytes?`${Math.min(100,Math.floor(bytes*100/sizeBytes))}%`:`${(bytes/1024/1024).toFixed(0)} MB`} downloaded`);nextReport=Math.ceil(bytes/(64*1024*1024))*64*1024*1024;}callback(null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),inspect,createWriteStream(destination,{flags:'wx'}));
  const actual=hash.digest('hex');
  if(sizeBytes&&bytes!==sizeBytes)throw Error(`${label} download size does not match the pinned release.`);
  if(sha&&actual!==sha)throw Error(`${label} download SHA-256 does not match the published/pinned digest.`);
  return {bytes,sha256:actual};
}
async function runPowerShell(script,environment){
  await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,...environment}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Windows archive extraction failed with exit code ${code}.`)));});
}
async function findServer(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);
    if(entry.isSymbolicLink())throw Error('The llama.cpp runtime archive contains a symbolic link.');
    if(entry.isDirectory()){const found=await findServer(file);if(found)return found;}
    else if(entry.isFile()&&entry.name.toLowerCase()==='llama-server.exe')return file;
  }
  return null;
}
async function copyRuntimeFiles(source,destination,relative=''){
  for(const entry of await readdir(path.join(source,relative),{withFileTypes:true})){
    const childRelative=path.posix.join(relative,entry.name),sourcePath=path.join(source,childRelative),destinationPath=path.join(destination,...childRelative.split('/'));
    if(entry.isSymbolicLink())throw Error('The llama.cpp runtime archive contains a symbolic link.');
    if(entry.isDirectory())await copyRuntimeFiles(source,destination,childRelative);
    else if(entry.isFile()){await mkdir(path.dirname(destinationPath),{recursive:true});await copyFile(sourcePath,destinationPath);}
  }
}
async function runtimeInventory(folder,relative=''){
  const result=[];
  for(const entry of await readdir(path.join(folder,relative),{withFileTypes:true})){
    const child=path.posix.join(relative,entry.name),file=path.join(folder,...child.split('/'));
    if(entry.isSymbolicLink())throw Error('The prepared llama.cpp runtime contains a symbolic link.');
    if(entry.isDirectory())result.push(...await runtimeInventory(folder,child));
    else if(entry.isFile()){const info=await stat(file);result.push({path:child,sizeBytes:info.size,sha256:await sha256(file)});}
  }
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function writeLicense(url,destination){
  const response=await fetch(url,{redirect:'follow',headers:{'user-agent':'Orivo-local-ai-preparer'}});
  if(!response.ok||new URL(response.url).protocol!=='https:')throw Error(`Could not retrieve a third-party license from ${url}.`);
  await writeFile(destination,await response.text(),'utf8');
}

await mkdir(aiRoot,{recursive:true});
const temporary=await mkdtemp(path.join(aiRoot,'.prepare-'));
try{
  const releaseResponse=await fetch(`https://api.github.com/repos/${RUNTIME_ASSET.repository}/releases/tags/${RUNTIME_ASSET.release}`,{redirect:'error',headers:{accept:'application/vnd.github+json','user-agent':'Orivo-local-ai-preparer'}});
  if(!releaseResponse.ok)throw Error(`Could not inspect the pinned llama.cpp release (HTTP ${releaseResponse.status}).`);
  const release=await releaseResponse.json();
  const runtimeAsset=selectRuntimeAsset(release.assets);
  const archive=path.join(temporary,runtimeAsset.name);
  const runtimeDownload=await download(runtimeAsset.url,archive,{sha:runtimeAsset.sha256,sizeBytes:release.assets.find(row=>row.name===runtimeAsset.name)?.size,label:'llama.cpp runtime'});
  const expanded=path.join(temporary,'expanded');await mkdir(expanded,{recursive:true});
  const extractionScript=path.join(temporary,'extract.ps1');
  await writeFile(extractionScript,"Expand-Archive -LiteralPath $env:ORIVO_AI_ARCHIVE -DestinationPath $env:ORIVO_AI_DESTINATION -Force\n",'utf8');
  await runPowerShell(extractionScript,{ORIVO_AI_ARCHIVE:archive,ORIVO_AI_DESTINATION:expanded});
  const server=await findServer(expanded);
  if(!server)throw Error('The pinned llama.cpp archive did not contain llama-server.exe.');
  const serverDirectory=path.dirname(server);
  await mkdir(runtimeDirectory,{recursive:true});
  await copyRuntimeFiles(serverDirectory,runtimeDirectory);
  const modelUrl=`https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/${MODEL_ASSET.id.split('@')[1]}/${MODEL_ASSET.file}?download=true`;
  let modelDownload;
  const existingModel=await stat(modelPath).catch(()=>null);
  if(existingModel?.isFile()){
    modelDownload={bytes:existingModel.size,sha256:await sha256(modelPath)};
    if(modelDownload.bytes!==MODEL_ASSET.sizeBytes||modelDownload.sha256!==MODEL_ASSET.sha256)throw Error('The Qwen model already in the project model folder does not match the pinned size and SHA-256.');
    console.log(`Using the existing verified model: ${modelPath}`);
  }else{
    const modelTemporary=path.join(temporary,MODEL_ASSET.file);
    modelDownload=await download(modelUrl,modelTemporary,{sha:MODEL_ASSET.sha256,sizeBytes:MODEL_ASSET.sizeBytes,label:'Qwen model'});
    validateModelMetadata(modelDownload.bytes,modelDownload.sha256);
    await mkdir(path.dirname(modelPath),{recursive:true});await copyFile(modelTemporary,modelPath);
  }
  validateModelMetadata(modelDownload.bytes,modelDownload.sha256);
  const licenseDirectory=path.join(aiRoot,'licenses');await mkdir(licenseDirectory,{recursive:true});
  await writeLicense(`https://raw.githubusercontent.com/${RUNTIME_ASSET.repository}/${RUNTIME_ASSET.release}/LICENSE`,path.join(licenseDirectory,'LLAMA-CPP-LICENSE.txt'));
  await writeLicense(`https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/${MODEL_ASSET.id.split('@')[1]}/LICENSE`,path.join(licenseDirectory,'QWEN-LICENSE.txt'));
  const runtimeFiles=await runtimeInventory(runtimeDirectory);
  if(!runtimeFiles.some(file=>file.path.toLowerCase()==='llama-server.exe'))throw Error('The prepared runtime is missing llama-server.exe.');
  const manifest={schemaVersion:1,preparedAt:new Date().toISOString(),model:{...MODEL_ASSET,sourceUrl:modelUrl},runtime:{...RUNTIME_ASSET,directory:RUNTIME_ASSET.release,sha256:runtimeDownload.sha256,archiveBytes:runtimeDownload.bytes,files:runtimeFiles}};
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n','utf8');
  console.log(JSON.stringify({prepared:true,model:modelPath,modelBytes:modelDownload.bytes,modelSha256:modelDownload.sha256,runtime:runtimeDirectory,runtimeFiles:runtimeFiles.length,licenses:licenseDirectory},null,2));
}finally{
  const relative=path.relative(aiRoot,path.resolve(temporary));
  if(!relative.startsWith('.prepare-')||path.isAbsolute(relative))throw Error('Refusing to clean a temporary path outside the Orivo AI resource folder.');
  await rm(temporary,{recursive:true,force:true});
}
