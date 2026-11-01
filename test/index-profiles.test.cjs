'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {indexRepository,readSource}=require('../engine/index.cjs');
test('large source profile indexes deeper and larger source while preserving exclusions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orivo-index-profiles-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const deep=path.join(root,...Array.from({length:18},(_,i)=>'level'+i));await fs.mkdir(deep,{recursive:true});
 await fs.writeFile(path.join(deep,'deep.js'),'export const deep=true;');
 await fs.writeFile(path.join(root,'large.js'),'// padding\n'.repeat(26000)+'export const visible=true;\n');
 await fs.writeFile(path.join(root,'credentials.json'),'{"password":"excluded"}');
 await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules','dependency.js'),'excluded');
 const standard=await indexRepository(root),large=await indexRepository(root,{profile:'large'});
 assert.equal(standard.files.length,0);assert.equal(standard.truncated,true);
 assert.equal(large.files.length,2);assert.equal(large.truncated,false);assert.equal(large.profile,'large');
 assert.ok(readSource(large,'large.js',26001).code.includes('visible'));
 assert.ok(!large.files.some(file=>file.path.includes('credentials')||file.path.includes('node_modules')));
 assert.ok(large.limits.files>standard.limits.files);
});
test('unknown profiles cannot silently disable work limits',async()=>{
 await assert.rejects(indexRepository('.', {profile:'unlimited'}),/index profile/);
});
