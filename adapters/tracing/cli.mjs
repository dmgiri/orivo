#!/usr/bin/env node
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {cp,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('.',import.meta.url));
export async function bundle(destination){
 const output=path.resolve(destination);try{await mkdir(output,{recursive:false});}catch(error){if(error.code==='EEXIST')throw Error('Tracing kit already exists at '+output+'. Choose another folder.');throw error;}
 for(const entry of await readdir(root,{withFileTypes:true}))if(entry.name==='examples'||entry.isFile()&&/\.(?:mjs|cjs|py|toml|json|md|txt)$/.test(entry.name))await cp(path.join(root,entry.name),path.join(output,entry.name),{recursive:true,errorOnExist:true,force:false});
 return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [command,argument]=process.argv.slice(2);
  if(command==='doctor')console.log(JSON.stringify(await require('./setup.cjs').describeProject(argument||'.'),null,2));
  else if(command==='bundle'&&argument)console.log('Tracing kit exported to '+await bundle(argument));
  else throw Error('Usage: orivo doctor [app-folder] | orivo bundle <new-output-folder>');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
