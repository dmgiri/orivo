import {decodeTraceHeader} from './trace-codec.mjs';

// Managed sessions retrieve metadata from their own same-origin development
// server. Full SQL/ORM evidence no longer has to fit in an HTTP header.
const nativeFetch=typeof fetch==='function'?fetch.bind(globalThis):null;
const MAX_BYTES=2*1024*1024,MAX_VALUES=100000;
// Metadata shares the application's origin. Leave browser connections free for
// application traffic even when a dashboard starts many requests together.
let activeLookups=0;const queuedLookups=[];
function releaseLookup(){const next=queuedLookups.shift();if(next){clearTimeout(next.timer);next.resolve(releaseLookup);}else activeLookups--;}
function acquireLookup(){if(activeLookups<2){activeLookups++;return Promise.resolve(releaseLookup);}if(queuedLookups.length>=256)return Promise.resolve(null);return new Promise(resolve=>{const entry={resolve,timer:null};entry.timer=setTimeout(()=>{const index=queuedLookups.indexOf(entry);if(index>=0){queuedLookups.splice(index,1);resolve(null);}},15000);queuedLookups.push(entry);});}
export function validateManagedTrace(value,id){
 let remaining=MAX_VALUES;
 function walk(item,depth=0){
  if(--remaining<0||depth>18)throw Error('Trace metadata exceeds its budget');
  if(item===null||['string','boolean'].includes(typeof item)||typeof item==='number'&&Number.isFinite(item))return;
  if(!item||typeof item!=='object'||!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype)throw Error('Invalid trace metadata');
  for(const key of Object.keys(item)){
   if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid trace key');
   const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!('value'in descriptor))throw Error('Invalid trace property');
   walk(descriptor.value,depth+1);
  }
 }
 walk(value);
 if(!value||Array.isArray(value)||value.id!==id||new TextEncoder().encode(JSON.stringify(value)).length>MAX_BYTES)throw Error('Trace correlation or size mismatch');
 return value;
}
export async function resolveTraceResponse(response,id,{fetcher=nativeFetch}={}){
 const trace=await decodeTraceHeader(response.headers.get('Studio-Trace'),id);
 if(trace?.ref!=='orivo-managed-v1')return trace;
 if(!/^[a-f0-9]{32}$/.test(trace.key||'')||!fetcher)return null;
 const release=await acquireLookup();if(!release)return null;
 try{
  const address=new URL('/__orivo_trace/'+trace.key,location.href);
  const received=await fetcher(address.href,{method:'GET',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store',priority:'low',signal:AbortSignal.timeout(15000)});
  if(!received.ok||received.url&&new URL(received.url).origin!==location.origin)return null;
  const reader=received.body.getReader(),chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();return null;}chunks.push(value);}}
  finally{reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return validateManagedTrace(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),id);
 }catch{return null;}finally{release();}
}
