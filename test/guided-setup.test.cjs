'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createGuidedSetup}=require('../adapters/tracing/guided.cjs');

async function project(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orivo-guided-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('orivo-guided-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'frontend'));await fs.mkdir(path.join(root,'backend'));
  const manifest={name:'independent-project',scripts:{dev:'vite --port 5173',lint:'eslint src'},dependencies:{react:'19.3.0'},devDependencies:{vite:'8.3.3'}};
  const before=JSON.stringify(manifest,null,2)+'\n';
  await fs.writeFile(path.join(root,'frontend/package.json'),before);
  await fs.writeFile(path.join(root,'frontend/vite.config.mjs'),'export default {server:{port:5173}};\n');
  await fs.writeFile(path.join(root,'backend/requirements.txt'),'fastapi\nsqlalchemy\n');
  return {root,before,manifest};
}
const options={frontend:'frontend',appOrigin:'http://localhost:5173',backend:{directory:'backend',app:'service.main:app',engine:'service.database:engine',sessions:'service.database:SessionLocal'}};

test('guided preview is read only; reviewed FastAPI setup applies and can undo while preserving later package edits',async t=>{
  const {root,before}=await project(t),guided=createGuidedSetup();
  const plan=await guided.preview(root,options);
  assert.equal(await fs.readFile(path.join(root,'frontend/package.json'),'utf8'),before);
  await assert.rejects(fs.stat(path.join(root,'.studio-tracing')),error=>error.code==='ENOENT');
  assert.ok(plan.changes.some(row=>row.path==='.studio-tracing/studio_app.py'&&row.diff.includes('response_models=True')));
  const saved=await guided.apply(root,plan.id,options.appOrigin);
  assert.equal(saved.backendDirectory,'backend');
  assert.match(saved.backendCommand,/uvicorn studio_app:app/);
  const state=await guided.state(root);assert.equal(state.installed,true);assert.equal(state.journal,undefined);
  const file=path.join(root,'frontend/package.json'),manifest=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(manifest.scripts.dev,'vite --port 5173');assert.equal(manifest.scripts.lint,'eslint src');assert.match(manifest.scripts['dev:studio'],/--config/);
  manifest.description='Keep my later edit';await fs.writeFile(file,JSON.stringify(manifest,null,2)+'\n');
  await guided.undo(root);
  const restored=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(restored.description,'Keep my later edit');assert.equal(restored.scripts['dev:studio'],undefined);assert.equal(restored.scripts.dev,'vite --port 5173');
  assert.equal((await guided.state(root)).installed,false);
});

test('guided setup rejects changed manifests, configurations and app origins before writing',async t=>{
  const {root,before}=await project(t),guided=createGuidedSetup(),file=path.join(root,'frontend/package.json');
  let plan=await guided.preview(root,options);
  await assert.rejects(guided.apply(root,plan.id,'http://localhost:5174'),/app changed/);
  await fs.writeFile(file,before+' ');await assert.rejects(guided.apply(root,plan.id,options.appOrigin),/package.json changed/);
  await fs.writeFile(file,before);plan=await guided.preview(root,options);
  await fs.writeFile(path.join(root,'frontend/vite.config.mjs'),'export default {server:{port:5174}};');
  await assert.rejects(guided.apply(root,plan.id,options.appOrigin),/Vite config changed/);
  await assert.rejects(fs.stat(path.join(root,'.studio-tracing')),error=>error.code==='ENOENT');
});

test('undo preserves a modified generated adapter rather than deleting developer work',async t=>{
  const {root}=await project(t),guided=createGuidedSetup(),plan=await guided.preview(root,options);
  await guided.apply(root,plan.id,options.appOrigin);
  const file=path.join(root,'.studio-tracing/studio_app.py'),edited=(await fs.readFile(file,'utf8'))+'\n# Developer change\n';await fs.writeFile(file,edited);
  await assert.rejects(guided.undo(root),/generated setup file changed/);
  assert.equal(await fs.readFile(file,'utf8'),edited);assert.equal((await guided.state(root)).installed,true);
});

test('guided Python entry references and backend selection cannot inject executable setup code',async t=>{
  const {root}=await project(t),guided=createGuidedSetup();
  await assert.rejects(guided.preview(root,{...options,backend:{...options.backend,app:'service:app; remove'}}),/module:object/);
  await assert.rejects(guided.preview(root,{...options,backend:{...options.backend,directory:'../elsewhere'}}),/detected FastAPI/);
  await assert.rejects(guided.preview(root,{...options,backend:{...options.backend,engine:''}}),/engine reference/);
  await assert.rejects(fs.stat(path.join(root,'.studio-tracing')),error=>error.code==='ENOENT');
});
