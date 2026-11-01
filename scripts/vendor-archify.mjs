import {cp,mkdir,readdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),source=process.argv[2];
if(!source)throw Error('Provide an existing original Archify distribution directory.');
const pkg=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
if(pkg.name!=='archify'||pkg.version!=='3.2.0')throw Error('Expected the reviewed upstream Archify 3.2.0 distribution.');
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Pin a valid original upstream Git commit.');
const origin=execFileSync('git',['-C',source,'remote','get-url','origin'],{encoding:'utf8',windowsHide:true}).trim();
if(origin.replace(/\.git$/,'')!=='https://github.com/tt-a1i/archify')throw Error('Use the original GitHub Archify repository.');
if(execFileSync('git',['-C',source,'status','--porcelain','--','.'],{encoding:'utf8',windowsHide:true}).trim())throw Error('The original upstream distribution has local changes.');
const target=path.join(root,'vendor','archify');await mkdir(target,{recursive:true});
const files=[];
async function copy(directory,relative=''){
 for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(item.name.startsWith('.')||item.name==='node_modules')continue;
  const from=path.join(directory,item.name),name=relative+item.name,to=path.join(target,name);
  if((await lstat(from)).isSymbolicLink())throw Error('Upstream symbolic links are not supported.');
  if(item.isDirectory()){await mkdir(to,{recursive:true});await copy(from,name+'/');}
  else if(item.isFile()){const bytes=await readFile(from);await cp(from,to);files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 }
}
await copy(path.resolve(source));
await writeFile(path.join(root,'vendor','archify-manifest.json'),JSON.stringify({version:pkg.version,repository:'https://github.com/tt-a1i/archify',commit,source:'Original GitHub archify/ distribution, preserved byte-for-byte',license:pkg.license,files},null,2)+'\n');
console.log(`Preserved ${files.length} upstream files (${files.reduce((n,f)=>n+f.bytes,0)} bytes).`);
