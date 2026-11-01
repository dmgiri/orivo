import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),parser=require('../adapters/tracing/parser-bundle.cjs'),root=path.resolve(import.meta.dirname,'..'),directory=path.join(root,'vendor','vscode-themes');
function literal(node){
 if(node.type==='ObjectExpression')return Object.fromEntries(node.properties.map(p=>[p.key.value??p.key.name,literal(p.value)]));
 if(node.type==='ArrayExpression')return node.elements.map(literal);
 if(node.type==='NullLiteral')return null;
 if(['StringLiteral','NumericLiteral','BooleanLiteral'].includes(node.type))return node.value;
 throw Error('Unexpected non-data theme syntax: '+node.type);
}
async function load(name,seen=new Set()){
 if(!/^[\w-]+\.json$/.test(name)||seen.has(name))throw Error('Invalid VS Code theme include.');seen.add(name);
 const text=await readFile(path.join(directory,name),'utf8');
 const value=literal(parser.parse('const theme='+text,{sourceType:'script'}).program.body[0].declarations[0].init);
 const base=value.include?await load(path.basename(value.include),seen):{colors:{},tokenColors:[]};
 return {name:value.name,colors:{...base.colors,...value.colors},tokenColors:[...base.tokenColors,...(value.tokenColors||[])]};
}
const data={dark:await load('2026-dark.json'),light:await load('2026-light.json')};
await writeFile(path.join(root,'renderer/vscode-theme-data.js'),`/* Official Microsoft VS Code 2026 colors. Source revision and MIT license: vendor/vscode-themes/. */\n(function(root){const data=${JSON.stringify(data,null,2)};if(typeof module==='object'&&module.exports)module.exports=data;else root.OrivoVSCodeThemes=data;})(globalThis);\n`);
console.log('Synced official VS Code Dark 2026 and Light 2026 theme inheritance.');
