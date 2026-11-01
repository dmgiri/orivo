'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url'),{createRequire}=require('node:module');

test('Axios parsed responses retain exact request and field identity across created clients',async t=>{
 const saved=new Map(['window','location','fetch','__studioElementFlowV1','__studioElementFlowPendingV1'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 globalThis.window={};globalThis.location={href:'http://localhost:7410/',origin:'http://localhost:7410'};
 const requests=[];
 globalThis.fetch=async request=>{const id=request.headers.get('X-Studio-Trace');requests.push({url:request.url,id});return new Response(JSON.stringify({title:'Equal title'}),{headers:{'Content-Type':'application/json','Studio-Trace':Buffer.from(JSON.stringify({id,route:{name:'items'},queries:[{id:'sql1',sql:'SELECT title FROM items'}],fields:{}})).toString('base64')}});};
 t.after(()=>{for(const [key,value] of saved){delete globalThis[key];if(value)Object.defineProperty(globalThis,key,value);}});
 const axiosPath=process.env.ORIVO_AXIOS_FIXTURE;
 if(!axiosPath){t.skip('Set ORIVO_AXIOS_FIXTURE to an installed Axios project package.json');return;}
 let axios;try{axios=(await import(pathToFileURL(createRequire(path.resolve(axiosPath)).resolve('axios')).href)).default;}catch{t.skip('Set ORIVO_AXIOS_FIXTURE to an installed Axios project package.json');return;}
 const flow=await import(pathToFileURL(path.resolve(__dirname,'../adapters/tracing/runtime.mjs')).href+'?axios='+Date.now());
 assert.equal(typeof flow.attachAxios,'function');
 flow.attachAxios(axios);flow.attachAxios(axios);
 const client=axios.create({baseURL:'http://localhost:7410',adapter:'fetch'}),other=axios.create({baseURL:'http://localhost:7410',adapter:'fetch'});
 const [one,two]=await Promise.all([client.get('/api/one'),other.get('/api/two')]);
 await Promise.allSettled([...globalThis.__studioElementFlowPendingV1.values()]);
 const bind=value=>{let mount;const element={};flow.element({path:'App.jsx',line:1,hash:'a'.repeat(64)},ref=>{mount=ref;flow.read(value,'title');},false);mount(element);return globalThis.__studioElementFlowV1.get(element);};
 const first=bind(one.data),second=bind(two.data),unrelated=bind({title:'Equal title'});
 assert.equal(first.dependencies.length,1);assert.equal(first.dependencies[0].field,'title');assert.match(first.dependencies[0].request.url,/\/api\/one$/);
 assert.equal(first.dependencies[0].backend.queries.length,1);assert.notEqual(first.dependencies[0].request.id,second.dependencies[0].request.id);assert.equal(unrelated.dependencies.length,0);
 assert.equal(one.data.title,'Equal title');
 for(const url of ['/api/auth/login','https://example.test/api/items']){
  const response=await client.get(url);
  assert.equal(requests.at(-1).id,null);assert.equal(bind(response.data).dependencies.length,0);
 }
 const failure=Error('Original adapter failure');
 const failing=axios.create({adapter:async()=>{throw failure;}});
 await assert.rejects(failing.get('/api/failure'),error=>error===failure);
});

test('compiler registers Axios default and named default imports without requiring app hooks',async()=>{
 const {transformStudio}=await import('../adapters/tracing/vite.mjs');
 for(const source of ['import api from "axios"; export const client=api.create();','import {default as http} from "axios"; export const client=http.create();']){
  const output=transformStudio(source,path.resolve('client.js'),path.resolve('.'));
  assert.match(output,/__studioFlow.attachAxios\((api|http)\)/);
 }
});
