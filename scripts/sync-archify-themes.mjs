import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),template=await readFile(path.join(root,'vendor/archify/assets/template.html'),'utf8'),themes={};
for(const preset of ['classic','signal-flow','blueprint','editorial']){
 themes[preset]={};
 for(const mode of ['dark','light']){
  const selector=(preset==='classic'?'':`[data-preset="${preset}"]`)+`[data-theme="${mode}"] {`;
  const start=template.indexOf(selector);if(start<0)throw Error('Upstream theme not found: '+selector);
  const block=template.slice(start+selector.length,template.indexOf('}',start));
  themes[preset][mode]=Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-fA-F\d]{6}|rgba?\([^;]+\));/g)].map(match=>[match[1],match[2]]));
 }
}
await writeFile(path.join(root,'renderer/archify-theme-data.js'),`/* Theme values extracted from the pinned, unmodified GitHub Archify template. */\n(function(root){const data=${JSON.stringify(themes,null,2)};if(typeof module==='object'&&module.exports)module.exports=data;else root.OrivoArchifyThemes=data;})(globalThis);\n`);
console.log('Synced the four original Archify presets in light and dark modes.');
