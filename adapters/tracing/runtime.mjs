import {resolveTraceResponse} from './managed-trace.mjs';
// Provenance is stored beside objects and DOM nodes. Customer values are not retained in traces.
const lineage=new WeakMap(),records=new WeakMap(),collectors=[],collectorDetails=new WeakMap();
const available=typeof window!=='undefined'&&!Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1');
if(available)Object.defineProperty(globalThis,'__studioElementFlowV1',{value:records,configurable:true});
const pendingTraces=new Map(),dependencyStates=new WeakMap();
if(available&&!Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowPendingV1'))Object.defineProperty(globalThis,'__studioElementFlowPendingV1',{value:pendingTraces,configurable:true});
const dependenciesFor=(source,key,value)=>{const entry=lineage.get(source)?.get(key);return entry&&Object.is(entry.value,value)?entry.dependencies:[];};
// Primitive keys coerce without side effects. Object keys must never run their
// conversion a second time just to look up tracing metadata.
const lineageKey=key=>key===null||!['object','function','symbol'].includes(typeof key)?String(key):key;
function reserveRow(state,row){if(state.rows.size>=12000){if(!state.truncated){state.truncated=true;for(const retained of state.rows)retained.truncated=true;}row.truncated=true;row.pending=false;return false;}if(state.truncated)row.truncated=true;dependencyStates.set(row,state);state.rows.add(row);return true;}
function collectionBackend(row,state){const captured=state.collectionBackend;if(!captured)return null;const path=row.field||'',witness=captured.collections.get(path);return {...captured.base,queries:witness?captured.queries.filter(query=>witness.queries.includes(query.id)):captured.queries,fields:{},collections:witness?{[path]:witness}:{}};}
function derivedDependency(row,changes){const copy={...row,...changes},state=dependencyStates.get(row);if(state){if(!state.settled){if(!reserveRow(state,copy))copy.backend=null;}else{dependencyStates.set(copy,state);if(copy.collection)copy.backend=collectionBackend(copy,state);}}return copy;}
const unique=rows=>{const distinct=[];let truncated=false;for(const row of rows){const index=distinct.findIndex(other=>other.field===row.field&&other.request.id===row.request.id&&!!other.collection===!!row.collection);if(index<0){if(distinct.length<12)distinct.push(row);else truncated=true;}else{const prior=distinct[index],preferred=prior.role==='control'&&row.role!=='control'?row:prior,changes={};if((prior.collectionUnknown||row.collectionUnknown)&&!preferred.collectionUnknown)changes.collectionUnknown=true;if((prior.truncated||row.truncated)&&!preferred.truncated)changes.truncated=true;distinct[index]=Object.keys(changes).length?derivedDependency(preferred,changes):preferred;}}return distinct.map(row=>truncated?derivedDependency(row,{truncated:true}):row);};
function collect(fn,isolate=false){const dependencies=[],details={locals:[],unknown:false},parents=isolate?collectors.splice(0):null;collectorDetails.set(dependencies,details);collectors.push(dependencies);try{return {value:fn(),dependencies,locals:details.locals,get unknown(){return details.unknown;}};}finally{collectors.pop();if(parents)collectors.push(...parents);}}
function emit(captured,control=false){for(const collector of collectors){collector.push(...(control?captured.dependencies.map(row=>derivedDependency(row,{role:'control'})):captured.dependencies));const details=collectorDetails.get(collector);if(details){details.locals.push(...(captured.locals||[]).map(local=>control?{...local,role:'control'}:local));if(!control&&captured.unknown)details.unknown=true;}}}
function capturedEntry(source,key,value){const entry=source&&typeof source==='object'?lineage.get(source)?.get(lineageKey(key)):null;return entry&&Object.is(entry.value,value)?entry:{value,dependencies:[],locals:[],unknown:true};}
function proof(captured,trusted){return {...captured,unknown:captured.unknown||trusted!==true};}
export function nullish(left,right,source,trustedLeft){const first=proof(collect(left,true),trustedLeft);if(first.value!==null&&first.value!==undefined){emit(first);return first.value;}emit(first,true);const chosen=collect(right,true);chosen.locals.push({source,role:'value'});emit(chosen);return chosen.value;}
// Cells belong to a lexical binding, never to an equal primitive elsewhere in
// the application. Values stay unboxed and a changed binding loses its origin.
export const capture=(fn,trusted)=>proof(collect(fn),trusted);
export function alias(value,cell){if(cell&&Object.is(value,cell.value)&&(value===null||!['object','function'].includes(typeof value)))emit(cell);return value;}
export function binding(value,source,key){return {value,...capturedEntry(source,key,value)};}
export function destructure(source){if(source==null)return source;const target=Object(source);return new Proxy(target,{get(object,key){const captured=collect(()=>Reflect.get(object,key,object),true),map=lineage.get(target)||new Map(),known=map.get(lineageKey(key));map.set(lineageKey(key),{...(known&&!known.dynamic&&Object.is(known.value,captured.value)?known:proof(captured,false)),dynamic:known?known.dynamic===true:true});lineage.set(target,map);return captured.value;}});}
export function mutation(source,fn){try{return fn();}finally{if(source&&typeof source==='object')lineage.delete(source);}}
export function rest(value,source){if(value&&source&&typeof value==='object'&&typeof source==='object'){const map=new Map();for(const [key,entry] of lineage.get(source)||[]){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor&&'value'in descriptor&&Object.is(entry.value,descriptor.value))map.set(key,entry);}lineage.set(value,map);}return value;}
const jsxFrames=[];
const nativeArrays=new WeakSet(),arrayCallbacks=new WeakMap(),callbackFrames=[],argumentFrames=[],appendFrames=[];
const nativeClone=globalThis.structuredClone;
export function clone(method,argumentsFor){
 const args=argumentsFor(),result=Reflect.apply(method,undefined,args);if(method!==nativeClone)return result;
 const visited=new WeakMap();let remaining=3000;
 function transfer(source,target,depth){
  if(!source||!target||typeof source!=='object'||typeof target!=='object'||depth>8||--remaining<0)return;
  if(visited.has(source))return;visited.set(source,target);
  const prototype=Object.getPrototypeOf(source);if(prototype!==Object.prototype&&prototype!==Array.prototype&&prototype!==null)return;
  const descriptors=Object.getOwnPropertyDescriptors(source),output=Object.getOwnPropertyDescriptors(target);if(Object.values(descriptors).some(descriptor=>!('value'in descriptor)))return;
  const map=new Map();for(const key of Object.keys(output)){const before=descriptors[key],after=output[key];if(!before||!('value'in after))continue;const object=before.value&&typeof before.value==='object';if(!object&&!Object.is(before.value,after.value))continue;const entry=lineage.get(source)?.get(key);if(entry&&Object.is(entry.value,before.value))map.set(key,{...entry,value:after.value});if(object)transfer(before.value,after.value,depth+1);}
  if(Array.isArray(target)){nativeArrays.add(target);const entry=lineage.get(source)?.get('length');if(entry&&Object.is(entry.value,source.length)&&source.length===target.length)map.set('length',{...entry,value:target.length});}
  lineage.set(target,map);
 }
 try{transfer(args[0],result,0);}catch{/* Optional clone metadata cannot change native clone results. */}return result;
}
const arrayMethods=Object.fromEntries(['map','filter','slice','find','push'].map(name=>[name,Array.prototype[name]])),arraySpecies=Object.getOwnPropertyDescriptor(Array,Symbol.species),arrayIterator=Array.prototype[Symbol.iterator];
export function array(value,knownStructure=true){nativeArrays.add(value);lineage.set(value,new Map([['length',{value:value.length,dependencies:[],unknown:!knownStructure}]]));return value;}
export function arrayCallback(value,token,trusted){if(typeof value==='function')arrayCallbacks.set(value,{token,trusted});return value;}
export function parameter(value,token){const frame=callbackFrames.at(-1);return frame?.token===token&&Object.is(value,frame.value)?{...frame,value}:{value,dependencies:[],locals:[],unknown:true};}
const collectionRows=(rows,operation,unknown=false)=>{
 const actual=new Map(),key=row=>JSON.stringify([row.request.id,row.field]);for(const row of rows)if(row.collection&&!actual.has(key(row)))actual.set(key(row),{unknown:false,truncated:false});
 for(const row of rows)if(!row.collection&&row.role!=='control'){const duplicate=actual.get(key(row));if(duplicate){duplicate.unknown||=row.collectionUnknown===true;duplicate.truncated||=row.truncated===true;}}
 return unique(rows.filter(row=>row.collection||row.role==='control'||!actual.has(key(row))).map(row=>{const duplicate=actual.get(key(row)),matched=typeof row.field==='string'?row.field.match(/^(.*?)\.\d+(?:\.|$)/):null,operations=[...new Set([...(row.operations||[]).filter(value=>value!=='length'),...(operation?[operation]:[]),'length'])].slice(0,8);return derivedDependency(row,{field:row.collection?row.field:matched?matched[1]:null,collection:true,operations,...(unknown||row.collectionUnknown||duplicate?.unknown?{collectionUnknown:true}:{}),...(duplicate?.truncated?{truncated:true}:{}),backend:row.backend?{...row.backend,fields:{}}:null});}));
};
export function arrayArgument(fn,trusted){const captured=proof(collect(fn,true),trusted),frame=argumentFrames.at(-1);if(frame){frame.dependencies.push(...captured.dependencies);if(frame.offset!==null)frame.slots.set(frame.offset++,captured);}return captured.value;}
export function arraySpread(fn){
 const captured=collect(fn,true),source=captured.value,frame=argumentFrames.at(-1);if(!frame)return source;
 if(source&&typeof source==='object'&&nativeArrays.has(source)){
  const map=lineage.get(source),length=Object.getOwnPropertyDescriptor(source,'length')?.value,entry=map?.get('length');
  if(Number.isSafeInteger(length)&&Object.getPrototypeOf(source)===Array.prototype&&!Object.getOwnPropertyDescriptor(source,Symbol.iterator)&&Object.getOwnPropertyDescriptor(Array.prototype,Symbol.iterator)?.value===arrayIterator){frame.dependencies.push(...captured.dependencies);if(entry&&entry.value===length){frame.dependencies.push(...entry.dependencies);frame.cardinality.push(...captured.dependencies,...entry.dependencies);frame.unknownSpread||=entry.unknown===true;}else frame.unknownSpread=true;if(frame.offset!==null){for(const [key,entry] of map||[])if(/^(?:0|[1-9]\d*)$/.test(String(key))&&Number(key)<length){const descriptor=Object.getOwnPropertyDescriptor(source,key);if(descriptor&&'value'in descriptor&&Object.is(descriptor.value,entry.value))frame.slots.set(frame.offset+Number(key),entry);}frame.offset+=length;}return source;}
 }
 frame.offset=null;frame.unknownSpread=true;return source;
}
function ordinaryArray(receiver){const species=Object.getOwnPropertyDescriptor(Array,Symbol.species);return Array.isArray(receiver)&&(nativeArrays.has(receiver)||lineage.has(receiver))&&Object.getPrototypeOf(receiver)===Array.prototype&&!Object.hasOwn(receiver,'constructor')&&Object.getOwnPropertyDescriptor(Array.prototype,'constructor')?.value===Array&&species?.get===arraySpecies?.get&&species?.set===arraySpecies?.set&&species?.value===arraySpecies?.value;}
export function conditionalAppend(test,append,receiverFor,trusted){const control=proof(collect(test,true),trusted),receiver=receiverFor(),frame={receiver,dependencies:control.dependencies.map(row=>derivedDependency(row,{role:'control'})),unknown:control.unknown};if(control.value){appendFrames.push(frame);try{return append();}finally{appendFrames.pop();}}if(ordinaryArray(receiver)){const length=receiver.length,map=new Map(lineage.get(receiver)||[]),prior=map.get('length'),unknown=frame.unknown||prior?.unknown===true;map.set('length',{value:length,dependencies:collectionRows([...(prior&&prior.value===length?prior.dependencies:[]),...frame.dependencies],undefined,unknown),unknown});lineage.set(receiver,map);}return undefined;}
export function arrayCall(receiverFor,name,argumentsFor,unknownControl=false){
 const received=collect(receiverFor,true),receiver=received.value,method=collect(()=>receiver[name],true).value,argumentsFrame={dependencies:[],cardinality:[],slots:new Map(),offset:0,unknownSpread:false};argumentFrames.push(argumentsFrame);let capturedArgs;try{capturedArgs=collect(argumentsFor,true);}finally{argumentFrames.pop();}const args=capturedArgs.value;
 if(method!==arrayMethods[name]||!Array.isArray(receiver)){for(const collector of collectors)collector.push(...received.dependencies,...capturedArgs.dependencies,...argumentsFrame.dependencies);if(name==='push'&&receiver&&typeof receiver==='object')lineage.delete(receiver);return Reflect.apply(method,receiver,args);}
 // Only registered JSON/literal/native-result arrays can carry metadata. A
 // proxy or custom species must not gain proof from equal returned values.
 if(!ordinaryArray(receiver))return Reflect.apply(method,receiver,args);
 const map=new Map(),collection=[...(lineage.get(receiver)?.get('length')?.dependencies||[]),...capturedArgs.dependencies,...argumentsFrame.dependencies],callback=args[0];let matched=null,next=0,result,collectionUnknown=lineage.get(receiver)?.get('length')?.unknown===true;
 if(name==='push'){
  const priorLength=receiver.length,previous=lineage.get(receiver),lengthEntry=previous?.get('length');if(lengthEntry&&lengthEntry.value!==priorLength)collection.splice(0,lengthEntry.dependencies.length);
  const controlled=appendFrames.findLast(frame=>frame.receiver===receiver),cardinality=[...(lengthEntry&&lengthEntry.value===priorLength?lengthEntry.dependencies:[]),...argumentsFrame.cardinality,...(controlled?.dependencies||[])];
  result=Reflect.apply(method,receiver,args);for(const [key,entry] of previous||[])if(key!=='length')map.set(key,entry);
  for(let index=0;index<args.length;index++){const entry=argumentsFrame.slots.get(index);if(entry&&Object.is(entry.value,args[index]))map.set(String(priorLength+index),entry);}
  const unknown=argumentsFrame.unknownSpread||unknownControl||controlled?.unknown||lengthEntry?.unknown===true;map.set('length',{value:result,dependencies:collectionRows(cardinality,'append',unknown),unknown});lineage.set(receiver,map);for(const collector of collectors)collector.push(...map.get('length').dependencies);return result;
 }else if(name==='slice'){
  result=Reflect.apply(method,receiver,args);if(args.some(value=>value!==undefined&&typeof value!=='number'))return result;
  const length=receiver.length,integer=value=>Number.isNaN(value)||value===0?0:Math.trunc(value),start=args[0]===undefined?0:integer(args[0]),from=start<0?Math.max(length+start,0):Math.min(start,length),end=args[1]===undefined?length:integer(args[1]),to=end<0?Math.max(length+end,0):Math.min(end,length);
  for(const [key,entry] of lineage.get(receiver)||[])if(/^(?:0|[1-9]\d*)$/.test(String(key))&&Number(key)>=from&&Number(key)<to)map.set(String(Number(key)-from),entry);
 }else{
  if(typeof callback!=='function')return Reflect.apply(method,receiver,args);
  const callbackPlan=arrayCallbacks.get(callback),token=callbackPlan?.token,wrapped=function(value,index,source){const entry=capturedEntry(receiver,String(index),value),input=entry.dependencies;callbackFrames.push({...entry,token,value});let captured;try{captured=proof(collect(()=>Reflect.apply(callback,this,[value,index,source]),true),callbackPlan?.trusted);}finally{callbackFrames.pop();}
   if(name!=='map')collection.push(...input,...captured.dependencies);
   if(name==='filter'&&captured.unknown)collectionUnknown=true;
   if(name==='map')map.set(String(index),captured);else if(name==='filter'&&captured.value)map.set(String(next++),entry);else if(name==='find'&&captured.value)matched=entry;return captured.value;};
  result=Reflect.apply(method,receiver,[wrapped,...args.slice(1)]);
 }
 if(name==='find'){if(matched&&(matched.value===null||!['object','function'].includes(typeof matched.value)))emit(matched);return result;}
 nativeArrays.add(result);map.set('length',{value:result.length,dependencies:collectionRows(collection,name,collectionUnknown),unknown:collectionUnknown});lineage.set(result,map);return result;
}
export function prop(key,fn,trusted){const captured=proof(collect(fn,true),trusted),frame=jsxFrames.at(-1);if(frame)frame.properties.set(key,captured);return captured.value;}
export function child(slot,fn,trusted){const captured=proof(collect(fn,true),trusted),frame=jsxFrames.at(-1);if(frame)frame.children.set(slot,captured);return captured.value;}
export function spread(fn){
 const source=fn(),copy={},frame=jsxFrames.at(-1);if(source==null)return source;
 // CopyDataProperties reads each original getter once. The JSX compiler only
 // reads this plain copy afterwards; unknown overrides erase earlier origins.
 for(const key of Reflect.ownKeys(Object(source))){if(!Object.getOwnPropertyDescriptor(Object(source),key)?.enumerable)continue;const captured=collect(()=>source[key],true),known=typeof source==='object'?lineage.get(source)?.get(key):null,entry=known&&!known.dynamic&&Object.is(known.value,captured.value)?known:proof(captured,false);Object.defineProperty(copy,key,{value:captured.value,enumerable:true,writable:true,configurable:true});if(frame)frame.properties.set(key,entry);}
 return copy;
}
export function jsx(render){
 const frame={properties:new Map(),children:new Map()};jsxFrames.push(frame);let result;try{result=render();}finally{jsxFrames.pop();}
 const props=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,'props')?.value:null;
 if(props&&typeof props==='object'){
  const map=new Map();for(const [key,entry] of frame.properties){const descriptor=Object.getOwnPropertyDescriptor(props,key);if(descriptor&&'value'in descriptor&&Object.is(entry.value,descriptor.value))map.set(key,entry);}
  const descriptor=Object.getOwnPropertyDescriptor(props,'children');if(descriptor&&'value'in descriptor){const value=descriptor.value;if(Array.isArray(value)){
   // A single children expression can pass the very same React children array
   // through several components. It is not a new variadic children array.
   const passed=frame.children.size===1?frame.children.get(0):frame.children.size===0?map.get('children'):null,single=passed?.value===value,children=new Map();
   for(const [slot,entry] of single?lineage.get(value)||[]:frame.children){const key=String(slot),actual=Object.getOwnPropertyDescriptor(value,key);if(actual&&'value'in actual&&Object.is(actual.value,entry.value))children.set(key,entry);}
   if(!single)lineage.set(value,children);const entries=[...children.values()],dependencies=entries.flatMap(entry=>entry.dependencies),locals=entries.flatMap(entry=>entry.locals||[]);map.set('children',{value,dependencies,locals,unknown:single&&passed.unknown||entries.some(entry=>entry.unknown||entry.value&&typeof entry.value==='object')});
  }else{const entry=frame.children.get(0);if(entry&&Object.is(value,entry.value))map.set('children',entry);}}
  lineage.set(props,map);
  for(const entry of map.values())emit(entry);
 }
 return result;
}
export function jsxRef(traced){return composeRef(jsxFrames.at(-1)?.properties.get('ref')?.value,traced);}
export function read(object,property){const value=object[property];emit(capturedEntry(object,property,value));return value;}
export function optionalChain(value,steps){
 let entry={dependencies:[],locals:[],unknown:true};
 for(const [optional,key] of steps){
  if(optional&&(value===null||value===undefined)){value=undefined;break;}
  const selected=collect(key,true),property=selected.value;emit(selected,true);const next=value[property];
  entry=capturedEntry(value,property,next);value=next;
 }
 // Only the selected leaf is a field origin. Intermediate containers do not
 // imply extra database columns. Independently evaluated keys still collect.
 emit(entry);
 return value;
}
export function object(fields){const result={},map=new Map();for(const [key,fn,trusted] of fields){const captured=proof(collect(fn,true),trusted);Object.defineProperty(result,key,{value:captured.value,enumerable:true,writable:true,configurable:true});map.set(key,captured);emit(captured);}lineage.set(result,map);return result;}
export function merge(parts){const result={},map=new Map();for(const part of parts){const value=part();if(value==null)continue;const source=Object(value);for(const key of Reflect.ownKeys(source)){if(!Object.getOwnPropertyDescriptor(source,key)?.enumerable)continue;const captured=collect(()=>source[key],true),known=typeof key==='string'?capturedEntry(source,key,captured.value):null,entry=known&&!known.dynamic?known:proof(captured,false);Object.defineProperty(result,key,{value:captured.value,enumerable:true,writable:true,configurable:true});if(typeof key==='string')map.set(key,entry);emit(entry);}}lineage.set(result,map);return result;}
export function composeRef(original,traced){return node=>{traced(node);if(typeof original==='function'){const cleanup=original(node);if(typeof cleanup==='function')return ()=>{traced(null);cleanup();};}else if(original)original.current=node;};}
export function element(source,render,isStatic){let current=null;const ref=node=>{if(current)records.delete(current);current=node;if(node&&available){const dependencies=unique(captured.dependencies),props=Object.getOwnPropertyDescriptor(captured.value||{},'props')?.value,map=props&&lineage.get(props),entry=map?.get('children')||map?.get('value'),locals=(entry?.locals||[]).filter((local,index,all)=>all.findIndex(other=>other.source.path===local.source.path&&other.source.line===local.source.line&&other.role===local.role)===index).slice(0,12),local=entry&&!entry.unknown&&(entry.value===null||typeof entry.value!=='object'||Array.isArray(entry.value))&&locals.some(value=>value.role==='value')&&dependencies.every(row=>row.role==='control');records.set(node,{version:1,url:location.href,source,mode:isStatic?'static':'data',dependencies,...(locals.length?{localValues:locals}:{}),...(local?{valueOrigin:'local'}:{})});}};const captured=collect(()=>render(ref));return captured.value;}
async function backendTrace(response,id){
 return resolveTraceResponse(response,id);
}
export async function recordResponse(value,response,id,method,url=response.url,durationMs){
 try{
  const request={id,method,url,status:response.status,...(Number.isFinite(durationMs)&&durationMs>=0&&durationMs<=86400000?{durationMs}:{})},state={settled:false,rows:new Set()},hasHeader=!!response.headers.get('Studio-Trace');let count=0;
  function dependency(field,collection=false){const row={field,request,backend:null,pending:hasHeader,...(collection?{collection:true}:{})};return reserveRow(state,row)?row:null;}
  function visit(item,prefix,depth){
   if(!item||typeof item!=='object'||depth>8||++count>3000)return;
   const map=new Map();for(const key of Object.keys(item)){
    const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!('value'in descriptor))continue;
    const field=prefix?prefix+'.'+key:key;if(field.length>200)continue;
    const row=dependency(field);if(!row)break;map.set(key,{value:descriptor.value,dependencies:[row]});visit(descriptor.value,field,depth+1);
   }if(Array.isArray(item)){nativeArrays.add(item);const row=dependency(prefix||null,true);if(row){row.operations=['length'];map.set('length',{value:item.length,dependencies:[row]});}}lineage.set(item,map);
  }visit(value,'',0);
  const finish=backend=>{
   state.settled=true;const queries=(Array.isArray(backend?.queries)?backend.queries.filter(query=>query&&typeof query==='object'):[]).slice(0,256);
   if(backend?.id===id){
    const base={...backend};delete base.fields;delete base.collections;delete base.queries;const collections=new Map(),queryIds=new Set(queries.map(query=>query.id));
    for(const [path,witness] of Object.entries(backend.collections||{}).slice(0,256)){
     const source=witness?.source,ids=witness?.queries;
     if(path.length>200||!Number.isSafeInteger(witness?.count)||witness.count<0||!Array.isArray(ids)||!ids.length||ids.length>256||ids.some(query=>typeof query!=='string'||!queryIds.has(query))||!source||typeof source.path!=='string'||source.path.length>500||!Number.isSafeInteger(source.line)||source.line<1||typeof source.hash!=='string'||!/^[a-f0-9]{64}$/i.test(source.hash)||source.name!==undefined&&(typeof source.name!=='string'||source.name.length>200))continue;
     collections.set(path,{queries:[...new Set(ids)],count:witness.count,source:{path:source.path,line:source.line,hash:source.hash,...(source.name!==undefined?{name:source.name}:{})}});
    }
    state.collectionBackend={base,queries,collections};
   }
   for(const row of state.rows){try{const origin=!row.collection&&row.field?backend?.fields?.[row.field]:null;row.backend=row.collection?collectionBackend(row,state):backend?.id===id?{...backend,collections:{},fields:origin?{[row.field]:origin}:{},queries:origin&&Array.isArray(origin.queries)?queries.filter(query=>origin.queries.includes(query.id)):queries}:null;row.pending=false;}catch{/* A modified capture row cannot interfere with the app or other fields. */}}state.rows.clear();
  };
  if(!hasHeader){finish(null);return value;}
  const completed=backendTrace(response,id).then(finish,()=>finish(null)),previous=pendingTraces.get(id),waiting=previous?Promise.allSettled([previous,completed]).then(()=>{}):completed;
  pendingTraces.set(id,waiting);waiting.finally(()=>{if(pendingTraces.get(id)===waiting)pendingTraces.delete(id);});await completed;
 }catch{/* An optional capture failure preserves the application response. */}
 return value;
}
function traceResponse(response,id,method,url,durationMs){
 // Response.clone() creates a fresh native Response, so it needs its own
 // readers. Keep native receiver checks, synchronous clone errors and body
 // consumption intact; borrowed methods must not inherit another request.
 try{
  const json=response.json,clone=response.clone;
  Object.defineProperty(response,'json',{configurable:true,writable:true,value:async function(){const value=await json.call(this);if(this===response)void recordResponse(value,response,id,method,url,durationMs).catch(()=>{});return value;}});
  Object.defineProperty(response,'clone',{configurable:true,writable:true,value:function(){const copy=clone.call(this);if(this===response)traceResponse(copy,id,method,url,durationMs);return copy;}});
 }catch{/* Instrumentation must not prevent the app from reading its response. */}
 return response;
}
// Axios parses JSON outside Response.json(). Observe its own response object
// before application interceptors run; never infer provenance from equal text.
const axiosClients=new WeakSet(),axiosRequests=new WeakMap();
export function attachAxios(client){
 if(!available||!client||axiosClients.has(client)||!client.interceptors?.request?.use||!client.interceptors?.response?.use)return client;
 axiosClients.add(client);
 client.interceptors.request.use(config=>{
  try{
   const address=new URL(client.getUri(config),location.href);
   if(address.origin!==location.origin||['/auth','/api/auth','/api/v1/auth'].some(prefix=>address.pathname===prefix||address.pathname.startsWith(prefix+'/')))return config;
   const headers=new Headers(config.headers?.toJSON?.()||config.headers),id=headers.get('X-Studio-Trace')||crypto.randomUUID();
   if(config.headers?.set)config.headers.set('X-Studio-Trace',id);else config.headers={...config.headers,'X-Studio-Trace':id};
   axiosRequests.set(config,{id,url:address.href,method:String(config.method||'GET').toUpperCase(),started:performance.now()});
  }catch{/* Optional tracing must preserve client configuration. */}
  return config;
 });
 client.interceptors.response.use(response=>{
  try{
   const request=axiosRequests.get(response.config);axiosRequests.delete(response.config);
   const finalUrl=response.request?.responseURL||response.request?.url;
   if(finalUrl&&new URL(finalUrl,location.href).origin!==location.origin)return response;
   if(request&&response.data&&typeof response.data==='object'){
    const headers=new Headers(response.headers?.toJSON?.()||response.headers);
    const metadata={status:response.status,headers};
    void recordResponse(response.data,metadata,request.id,request.method,request.url,performance.now()-request.started).catch(()=>{});
   }
  }catch{/* Response values, errors and interceptor ordering stay native. */}
  return response;
 });
 if(typeof client.create==='function'){
  const create=client.create;
  client.create=function(...args){return attachAxios(Reflect.apply(create,this,args));};
 }
 return client;
}
let uninstall=null;
export function installFetch({exclude=['/auth','/api/auth','/api/v1/auth']}={}){
 if(!available||uninstall)return uninstall||(()=>{});
 const original=globalThis.fetch;
 const wrapped=async function(input,options){
  let address,id,method,next=options;
  try{
   address=new URL(input instanceof Request?input.url:String(input),location.href);
   if(address.origin!==location.origin||exclude.some(prefix=>address.pathname===prefix||address.pathname.startsWith(prefix+'/')))return original.call(this,input,options);
   method=String(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
   const headers=new Headers(options?.headers||(input instanceof Request?input.headers:undefined));
   id=headers.get('X-Studio-Trace')||crypto.randomUUID();headers.set('X-Studio-Trace',id);next={...options,headers};
  }catch{return original.call(this,input,options);}
  const started=performance.now(),response=await original.call(this,input,next),durationMs=performance.now()-started;
  try{if(new URL(response.url||address.href).origin!==location.origin)return response;traceResponse(response,id,method,address.href,durationMs);}catch{}
  return response;
 };
 globalThis.fetch=wrapped;
 uninstall=()=>{if(globalThis.fetch===wrapped)globalThis.fetch=original;uninstall=null;};return uninstall;
}
