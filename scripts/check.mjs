import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const files = [];
async function visit(folder) { for (const e of await readdir(folder,{withFileTypes:true})) { if (['node_modules','.tmp','dist','evidence','adapters','docs','vendor'].includes(e.name)) continue; const full=path.join(folder,e.name); if(e.isDirectory())await visit(full);else if(/\.(?:cjs|mjs|js)$/.test(e.name))files.push(full); } }
await visit(root);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});if(result.status){console.error(result.stderr);process.exit(1);}}
const html=await readFile(path.join(root,'renderer/index.html'),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(new Set(ids).size!==ids.length)throw Error('Duplicate renderer IDs');
console.log(`Checked ${files.length} JavaScript files and ${ids.length} unique UI IDs.`);
