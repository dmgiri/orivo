'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createDiagramStudio,candidate,TYPES,PRESETS}=require('../diagram-studio.cjs');
async function fixture(t){const base=path.resolve(__dirname,'../.tmp');await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'orivo-diagram-test-'));const studio=createDiagramStudio({runtimeDirectory:directory});t.after(async()=>{await studio.close();assert.equal(path.dirname(directory),base);await fs.rm(directory,{recursive:true,force:true});});return studio;}
test('the bundled GitHub Archify source and notices remain byte-for-byte original',async t=>{const studio=await fixture(t),verified=await studio.verifyOriginal();assert.equal(verified.unchanged,true);assert.ok(verified.files>150);const license=await fs.readFile(path.join(__dirname,'../vendor/archify/LICENSE'),'utf8');assert.match(license,/Apache License/);const manifest=JSON.parse(await fs.readFile(path.join(__dirname,'../vendor/archify-manifest.json'),'utf8'));assert.match(manifest.commit,/^[a-f\d]{40}$/);assert.equal(manifest.repository,'https://github.com/tt-a1i/archify');});
test('all ten diagram types and the explainer render with the unchanged upstream engine',async t=>{
 const studio=await fixture(t);
 for(const type of TYPES){await t.test(type,async()=>{const text=await studio.example(type),rendered=await studio.render({type,text});assert.equal(rendered.type,type);assert.equal(rendered.receipt.ok,true);const response=await fetch(rendered.url);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);const html=await response.text();assert.match(html,/<!doctype html>/i);assert.ok(html.length>20000);});}
});
test('all original visual presets and architecture Before/After comparison are available',async t=>{
 const studio=await fixture(t),text=await studio.example('architecture');
 for(const preset of PRESETS){const artifact=await studio.render({type:'architecture',text,preset});const html=(await studio.bytes(artifact.id,'html')).toString();assert.ok(html.includes('data-preset="'+preset+'"'));}
 const sample=await studio.compareExample(),comparison=await studio.render({type:'architecture',text:sample.after,before:sample.before,preset:'blueprint'});assert.equal(comparison.type,'comparison');assert.equal(comparison.receipt.ok,true);
});
test('failed candidates leave the last valid diagram available and cannot choose filesystem outputs',async t=>{
 const studio=await fixture(t),text=await studio.example('architecture'),good=await studio.render({type:'architecture',text});
 const bad=JSON.parse(text);bad.connections[0].to='missing-node';await assert.rejects(studio.render({type:'architecture',text:JSON.stringify(bad)}));
 assert.equal(studio.info().lastGood,good.id);assert.equal((await fetch(good.url)).status,200);
 const source=JSON.parse(text);source.meta.output='../../outside.html';assert.equal(candidate(JSON.stringify(source),'architecture').meta.output,'diagram.html');
 assert.throws(()=>candidate('{"diagram_type":"architecture","meta":{},"path":"C:/secret"}','architecture'),/self-contained/);
 assert.throws(()=>candidate(text,'tree'),/must match/);assert.throws(()=>candidate(text,'architecture','unknown'),/visual preset/);
 assert.throws(()=>studio.artifact('../../outside'),/created in this Orivo session/);
 assert.equal((await fetch(new URL('/../../outside',good.url))).status,404);
 await assert.rejects(studio.bytes(good.id,'exe'),/export/);
});
