'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createServer}=require('node:http');
const provenance=require('./vendor/archify-manifest.json');
const runFile=promisify(execFile);
const TYPES=Object.freeze(['architecture','workflow','sequence','dataflow','lifecycle','erd','class','tree','timeline','waterfall','explainer']);
const PRESETS=Object.freeze(['classic','signal-flow','blueprint','editorial']);
const EXAMPLES=Object.freeze({architecture:'web-app.architecture.json',workflow:'agent-tool-call.workflow.json',sequence:'cache-miss-request.sequence.json',dataflow:'product-analytics.dataflow.json',lifecycle:'deployment-release.lifecycle.json',erd:'orders.erd.json',class:'payments.class.json',tree:'payment-platform.tree.json',timeline:'payment-incident.timeline.json',waterfall:'checkout-request.waterfall.json',explainer:'delivery.explainer.json'});
const MAX_INPUT=2*1024*1024,MAX_HTML=32*1024*1024;
function candidate(text,type,preset='classic'){
 if(!TYPES.includes(type)||!PRESETS.includes(preset))throw Error('Choose an available diagram type and visual preset.');
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_INPUT)throw Error('Diagram source must be JSON smaller than 2 MiB.');
 let value;try{value=JSON.parse(text);}catch{throw Error('Enter valid Archify JSON.');}
 if(!value||typeof value!=='object'||Array.isArray(value)||value.diagram_type!==type)throw Error('The selected type must match diagram_type in the source.');
 if(!value.meta||typeof value.meta!=='object'||Array.isArray(value.meta))throw Error('Diagram source needs a meta object.');
 let budget=50000;
 function inspect(value,depth=0){
  if(--budget<0||depth>40)throw Error('Diagram source exceeds its structure limit.');
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
   if(['__proto__','constructor','prototype'].includes(key))throw Error('Unsafe diagram property.');
   // The studio accepts self-contained source. Local-resource resolution must
   // never escape the profile-owned job, even when importing foreign JSON.
   if(['path','file','filePath','repoRoot','baseDir'].includes(key)&&typeof item==='string')throw Error('Use self-contained diagram JSON. Local file references must be inlined before import.');
   inspect(item,depth+1);
  }
 }
 inspect(value);
 value.meta={...value.meta,output:'diagram.html',...(type==='explainer'?{}:{visual_preset:preset})};
 return value;
}
function createDiagramStudio({runtimeDirectory,vendorRoot=path.join(__dirname,'vendor','archify'),executable=process.execPath}={}){
 if(!runtimeDirectory)throw Error('A profile-owned diagram directory is required.');
 const directory=path.resolve(runtimeDirectory),artifacts=new Map();
 let server=null,origin=null,busy=false,closed=false,lastGood=null;
 const children=new Set();
 async function startServer(){
  if(server)return;
  server=createServer(async(request,response)=>{
   try{
    const url=new URL(request.url,'http://127.0.0.1');
    const id=url.pathname.slice(1),artifact=artifacts.get(id);
    if(request.method!=='GET'||!artifact){response.writeHead(404);response.end();return;}
    const html=await fs.readFile(artifact.file);
    if(html.length>MAX_HTML)throw Error('Diagram output too large.');
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'"});
    response.end(html);
   }catch{response.writeHead(500);response.end('Diagram unavailable.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
 }
 async function run(args,cwd){
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',ARCHIFY_UPDATE_CHECK_DISABLED:'1'};
  delete env.ARCHIFY_REPO_ROOT;delete env.ARCHIFY_EXPLAINER_PREPARED;delete env.ARCHIFY_EXPLAINER_PAGE_DIR;delete env.ARCHIFY_EXPLAINER_SNAPSHOT_INPUT;
  const pending=runFile(executable,[path.join(vendorRoot,'bin','archify.mjs'),...args],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  if(pending.child)children.add(pending.child);
  try{return await pending;}
  catch(error){let receipt;try{receipt=JSON.parse(error.stdout);}catch{};const messages=(receipt?.diagnostics||[]).map(d=>d.message).filter(Boolean);throw Error((messages.join('\n')||receipt?.message||error.stderr||error.message).slice(0,4000));}
  finally{if(pending.child)children.delete(pending.child);}
 }
 async function render({type,text,preset='classic',quality='standard',before}={}){
  if(closed)throw Error('Diagram studio is closed.');
  if(busy)throw Error('Wait for the current diagram render.');
  if(!['standard','showcase'].includes(quality))throw Error('Choose standard or showcase validation.');
  const source=candidate(text,type,preset),base=before===undefined?null:candidate(before,'architecture',preset);
  source.meta.quality_profile=quality;if(base)base.meta.quality_profile=quality;
  if(base&&type!=='architecture')throw Error('Before/After comparison requires Architecture.');
  if(artifacts.size>=40)throw Error('This session already holds 40 diagrams. Restart Orivo to begin another diagram session. Export the diagrams you want to keep.');
  busy=true;
  let job=null,committed=false;
  try{
   const id=randomUUID();job=path.join(directory,id);await fs.mkdir(job,{recursive:true});
   const input=path.join(job,'candidate.json'),output=path.join(job,'diagram.html');
   await fs.writeFile(input,JSON.stringify(source,null,2));
   let result;
   if(base){const baseFile=path.join(job,'before.json');await fs.writeFile(baseFile,JSON.stringify(base,null,2));result=await run(['compare','architecture',baseFile,input,output,'--quality',quality,'--json'],job);}
   else result=await run(['deliver',type,input,output,'--quality',quality,'--json'],job);
   let receipt;try{receipt=JSON.parse(result.stdout);}catch{throw Error('The upstream renderer did not return a delivery receipt.');}
   if(receipt.ok===false)throw Error('Upstream diagram validation failed.');
   const stat=await fs.stat(output);if(stat.size>MAX_HTML)throw Error('Diagram output exceeds 32 MiB.');
   if(closed)throw Error('Diagram studio closed while rendering.');
   const artifact={id,type:base?'comparison':type,title:String(source.meta.title||type).slice(0,120),preset,quality,source:JSON.stringify(source,null,2),file:output,receipt,createdAt:new Date().toISOString()};
   await startServer();artifacts.set(id,artifact);lastGood=id;committed=true;
   return describe(artifact);
  }finally{busy=false;if(job&&!committed&&path.dirname(job)===directory&&/^[a-f\d-]{36}$/.test(path.basename(job)))await fs.rm(job,{recursive:true,force:true}).catch(()=>{});}
 }
 function describe(artifact){return {id:artifact.id,type:artifact.type,title:artifact.title,preset:artifact.preset,quality:artifact.quality,url:origin+'/'+artifact.id,createdAt:artifact.createdAt,receipt:artifact.receipt};}
 function find(id){if(typeof id!=='string'||!artifacts.has(id))throw Error('Choose a diagram created in this Orivo session.');return artifacts.get(id);}
 return {
  info:()=>({version:provenance.version,commit:provenance.commit,upstream:provenance.repository,license:provenance.license,types:TYPES,presets:PRESETS,lastGood,diagrams:[...artifacts.values()].map(describe)}),
  async example(type){if(!Object.hasOwn(EXAMPLES,type))throw Error('Unknown diagram example.');return fs.readFile(path.join(vendorRoot,'examples',EXAMPLES[type]),'utf8');},
  async compareExample(){return {before:await fs.readFile(path.join(vendorRoot,'examples','checkout-platform.base.architecture.json'),'utf8'),after:await fs.readFile(path.join(vendorRoot,'examples','checkout-platform.head.architecture.json'),'utf8')};},
  render,
  artifact(id){return describe(find(id));},
  async bytes(id,format){const artifact=find(id);if(format==='html')return fs.readFile(artifact.file);if(format==='json')return Buffer.from(artifact.source);if(format==='receipt')return Buffer.from(JSON.stringify(artifact.receipt,null,2));throw Error('Choose HTML, JSON or receipt export.');},
  async verifyOriginal(){const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(vendorRoot),'archify-manifest.json'),'utf8'));for(const file of manifest.files){const bytes=await fs.readFile(path.join(vendorRoot,file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Original Archify file changed: '+file.path);}return {version:manifest.version,commit:manifest.commit,repository:manifest.repository,files:manifest.files.length,unchanged:true};},
  async close(){closed=true;for(const child of children)child.kill();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}}
 };
}
module.exports={createDiagramStudio,candidate,TYPES,PRESETS};
