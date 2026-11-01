import {decodeTraceHeader} from './trace-codec.mjs';
// Opt-in development instrumentation. Nothing is installed in a reviewed app by Studio.
const records=new WeakMap();
if(Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1'))throw Error('Studio tracing is already registered.');
Object.defineProperty(globalThis,'__studioElementFlowV1',{value:records,configurable:true});
const cleanUrl=value=>{const url=new URL(value,location.href);if(url.origin!==location.origin||url.username||url.password)throw Error('Studio tracing supports the reviewed origin only.');return url;};
export function bind(element,source,values=[],mode='data'){
 if(!element)return;
 const dependencies=values.flatMap(value=>value?.dependencies||[]);
 records.set(element,{version:1,url:location.href,source,mode,dependencies});
}
export function unbind(element){records.delete(element);}
export function local(value){return {value,dependencies:[]};}
export function derive(inputs,transform){return {value:transform(...inputs.map(input=>input.value)),dependencies:inputs.flatMap(input=>input.dependencies)};}
export async function request(input,options={}){
 const url=cleanUrl(input),id=crypto.randomUUID(),method=(options.method||'GET').toUpperCase();
 const headers=new Headers(options.headers);headers.set('X-Studio-Trace',id);
 const started=performance.now(),response=await fetch(url,{...options,headers}),durationMs=performance.now()-started;let data=null;if(response.status!==204&&method!=='HEAD'){try{data=await response.json();}catch{}}
 const backend=await decodeTraceHeader(response.headers.get('Studio-Trace'),id);
 const captured={id,url:url.href,method,status:response.status,...(Number.isFinite(durationMs)&&durationMs>=0&&durationMs<=86400000?{durationMs}:{})};
 // Carry only the selected field's origin into the DOM capture. A large list
 // can have a small compressed header but otherwise exceed the page's bounded
 // reader once its ORM definitions are expanded. Keep request/query evidence
 // intact so the entire-request view remains available.
 const selectedBackend=field=>backend?{...backend,fields:field&&Object.hasOwn(backend.fields||{},field)?{[field]:backend.fields[field]}:{}}:null;
 return {data,response,field(path){if(typeof path!=='string'||path.length>200)throw Error('Invalid response field');let value=data;for(const key of path.split('.')){if(['__proto__','constructor','prototype'].includes(key)||!Object.hasOwn(value??{},key))throw Error('Response field missing');value=value[key];}return {value,dependencies:[{field:path,request:captured,backend:selectedBackend(path)}]};},dependency(){return {dependencies:[{field:null,request:captured,backend:selectedBackend(null)}]};}};
}
export function action(element,source,handler){
 bind(element,source,[],'action');
 return async function(...args){const used=[];const capture=async(input,options)=>{const result=await request(input,options);used.push(result.dependency());return result;};try{return await handler(capture,...args);}finally{bind(element,source,used,'action');}};
}
