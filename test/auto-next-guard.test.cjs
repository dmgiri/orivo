'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {finished}=require('node:stream/promises');
const {installSourceGuard}=require('../adapters/tracing/auto-next-guard.cjs');
const guardFile=require.resolve('../adapters/tracing/auto-next-guard.cjs');
const temp=path.resolve(__dirname,'../.tmp');
function fixture(t) {
 fs.mkdirSync(temp,{recursive:true});const directory=fs.mkdtempSync(path.join(temp,'next-source-guard-')),root=path.join(directory,'source'),profile=path.join(directory,'profile');fs.mkdirSync(root);fs.mkdirSync(profile);const source=path.join(root,'page.tsx');fs.writeFileSync(source,'original bytes');fs.symlinkSync(root,path.join(profile,'source-alias'),process.platform==='win32'?'junction':'dir');
 let detach=()=>{};t.after(()=>{detach();fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {directory,root,profile,source,attach(){detach=installSourceGuard(root);return detach;}};
}
function blocked(error){return error?.code==='ORIVO_SOURCE_READ_ONLY';}
test('source guard rejects synchronous, callback, promise and stream writes but preserves profile output',async t=>{
 const item=fixture(t);item.attach();
 assert.throws(()=>fs.writeFileSync(item.source,'changed'),blocked);await assert.rejects(promisify(fs.appendFile)(item.source,'changed'),blocked);await assert.rejects(fsp.writeFile(item.source,'changed'),blocked);
 assert.throws(()=>fs.openSync(item.source,'w'),blocked);await assert.rejects(promisify(fs.open)(item.source,'r+'),blocked);await assert.rejects(fsp.open(item.source,'a'),blocked);assert.throws(()=>fs.createWriteStream(item.source),blocked);
 assert.throws(()=>fs.mkdtempSync(path.join(item.root,'generated-')),blocked);await assert.rejects(fsp.mkdtemp(path.join(item.root,'generated-')),blocked);
 const output=path.join(item.profile,'cache.txt');fs.writeFileSync(output,'profile');await fsp.appendFile(output,' cache');const stream=fs.createWriteStream(output,{flags:'a'});stream.end(' stream');await finished(stream);assert.equal(await fsp.readFile(output,'utf8'),'profile cache stream');assert.equal(fs.readFileSync(item.source,'utf8'),'original bytes');
});
test('source guard resolves symlink aliases and non-existing descendants before permitting mutations',async t=>{
 const item=fixture(t),dangling=path.join(item.profile,'dangling-alias');fs.symlinkSync(path.join(item.root,'not-created'),dangling,process.platform==='win32'?'junction':'dir');item.attach();const alias=path.join(item.profile,'source-alias');
 assert.throws(()=>fs.writeFileSync(path.join(alias,'page.tsx'),'changed'),blocked);await assert.rejects(fsp.mkdir(path.join(alias,'new','nested'),{recursive:true}),blocked);assert.throws(()=>fs.openSync(path.join(alias,'new.tsx'),'w'),blocked);
 await fsp.mkdir(alias,{recursive:true});assert.equal(await fsp.readFile(path.join(alias,'page.tsx'),'utf8'),'original bytes');
 assert.throws(()=>fs.rmSync(item.directory,{recursive:true,force:true}),blocked);await assert.rejects(fsp.rename(item.root,path.join(item.profile,'moved')),blocked);assert.throws(()=>fs.linkSync(item.source,path.join(item.profile,'hardlink')),blocked);
 assert.throws(()=>fs.mkdirSync(path.join(dangling,'nested'),{recursive:true}),blocked);assert.equal(fs.existsSync(path.join(item.root,'not-created')),false);
});
test('source guard protects copy, deletion, rename and source metadata APIs across variants',async t=>{
 const item=fixture(t),scratch=path.join(item.profile,'scratch.txt');fs.writeFileSync(scratch,'scratch');item.attach();
 for(const operation of [()=>fs.copyFileSync(scratch,item.source),()=>fs.cpSync(scratch,item.source),()=>fs.renameSync(scratch,item.source),()=>fs.unlinkSync(item.source),()=>fs.truncateSync(item.source,0),()=>fs.chmodSync(item.source,0o600),()=>fs.utimesSync(item.source,new Date(),new Date())])assert.throws(operation,blocked);
 for(const operation of [()=>fsp.copyFile(scratch,item.source),()=>fsp.cp(scratch,item.source),()=>fsp.unlink(item.source),()=>fsp.truncate(item.source,0),()=>fsp.chmod(item.source,0o600),()=>fsp.utimes(item.source,new Date(),new Date()),()=>promisify(fs.rename)(scratch,item.source),()=>promisify(fs.rm)(item.root,{recursive:true})])await assert.rejects(operation(),blocked);
 await fsp.copyFile(item.source,path.join(item.profile,'read-only-copy'));assert.equal(await fsp.readFile(path.join(item.profile,'read-only-copy'),'utf8'),'original bytes');
});
test('source guard protects tracked descriptors and FileHandles without blocking ordinary profile handles',async t=>{
 const item=fixture(t);item.attach();const descriptor=fs.openSync(item.source,'r');assert.throws(()=>fs.writeSync(descriptor,'changed'),blocked);await assert.rejects(promisify(fs.ftruncate)(descriptor,0),blocked);fs.closeSync(descriptor);
 const handle=await fsp.open(item.source,'r');await assert.rejects(handle.writeFile('changed'),blocked);await assert.rejects(handle.truncate(0),blocked);assert.throws(()=>handle.createWriteStream(),blocked);await handle.close();
 const output=await fsp.open(path.join(item.profile,'handle.txt'),'w');await output.writeFile('profile');await output.close();assert.equal(fs.readFileSync(item.source,'utf8'),'original bytes');
});
test('recursive copies cannot overwrite original files through nested destination aliases',async t=>{
 const item=fixture(t),from=path.join(item.profile,'from'),to=path.join(item.profile,'to');fs.mkdirSync(path.join(from,'nested'),{recursive:true});fs.mkdirSync(to);fs.writeFileSync(path.join(from,'nested','page.tsx'),'changed');fs.symlinkSync(item.root,path.join(to,'nested'),process.platform==='win32'?'junction':'dir');item.attach();
 assert.throws(()=>fs.cpSync(from,to,{recursive:true,dereference:true}),blocked);await assert.rejects(fsp.cp(from,to,{recursive:true,dereference:true}),blocked);await assert.rejects(promisify(fs.cp)(from,to,{recursive:true,dereference:true}),blocked);assert.equal(fs.readFileSync(item.source,'utf8'),'original bytes');
 const safe=path.join(item.profile,'safe-copy');await fsp.cp(from,safe,{recursive:true});assert.equal(await fsp.readFile(path.join(safe,'nested','page.tsx'),'utf8'),'changed');
});
test('source guard reference counts and detach restore normal APIs',async t=>{
 const item=fixture(t),before=fs.writeFileSync,detach=item.attach(),second=installSourceGuard(item.root);detach();assert.throws(()=>fs.writeFileSync(item.source,'changed'),blocked);second();assert.equal(fs.writeFileSync,before);fs.writeFileSync(item.source,'after detach');assert.equal(await fsp.readFile(item.source,'utf8'),'after detach');
});
test('source guard preload updates ESM fs and promises imports in owned child processes',async t=>{
 const item=fixture(t),script=`import assert from 'node:assert/strict';import {writeFileSync,createWriteStream} from 'node:fs';import {writeFile} from 'node:fs/promises';const source=process.argv[1],output=process.argv[2];assert.throws(()=>writeFileSync(source,'changed'),error=>error.code==='ORIVO_SOURCE_READ_ONLY');assert.throws(()=>createWriteStream(source),error=>error.code==='ORIVO_SOURCE_READ_ONLY');await assert.rejects(writeFile(source,'changed'),error=>error.code==='ORIVO_SOURCE_READ_ONLY');await writeFile(output,'profile');`;
 const env={...process.env,ORIVO_SOURCE_GUARD_ROOT:item.root};delete env.ELECTRON_RUN_AS_NODE;await promisify(execFile)(process.execPath,['--require',guardFile,'--input-type=module','--eval',script,item.source,path.join(item.profile,'esm.txt')],{env,windowsHide:true,timeout:10000});assert.equal(await fsp.readFile(item.source,'utf8'),'original bytes');assert.equal(await fsp.readFile(path.join(item.profile,'esm.txt'),'utf8'),'profile');
});
