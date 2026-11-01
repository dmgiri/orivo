// Compact transport only: expanding references never establishes trace evidence.
// The same decoder is used by manual and automatically attached browser adapters.
const WIRE_BYTES=300000,TRACE_BYTES=1048576,TRACE_NODES=50000,TRACE_DEPTH=18,POOL_ENTRIES=20000;
const forbidden=new Set(['__proto__','constructor','prototype']);
const encoder=new TextEncoder();
const bytes=value=>encoder.encode(JSON.stringify(value)).length;
const invalid=()=>{throw Error('Invalid or oversized trace metadata');};
const own=(value,key)=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor))invalid();return descriptor.value;};
function objectKeys(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
 const keys=Object.keys(value);for(const key of keys)if(forbidden.has(key))invalid();return keys;
}
function arrayLength(value){
 if(!Array.isArray(value))invalid();const length=own(value,'length');
 if(!Number.isSafeInteger(length)||length<0||length>TRACE_NODES||Object.keys(value).length!==length)invalid();return length;
}
function bounded(value,size,nodes,depth){
 if(size>TRACE_BYTES||nodes>TRACE_NODES||depth>TRACE_DEPTH)invalid();return {value,size,nodes,depth};
}
function primitive(value){
 if(value!==null&&!['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))invalid();
 return bounded(value,bytes(value),1,0);
}
function container(body,kind,child){
 const output=kind===1?[]:{},keys=kind===1?Array.from({length:arrayLength(body)},(_,index)=>String(index)):objectKeys(body);
 let size=2,nodes=1,depth=0;
 for(const key of keys){
  const decoded=child(own(body,key));size+=decoded.size+(kind===0?bytes(key)+1:0)+(nodes===1?0:1);nodes+=decoded.nodes;depth=Math.max(depth,decoded.depth+1);
  bounded(null,size,nodes,depth);output[key]=decoded.value;
 }
 return bounded(output,size,nodes,depth);
}
export function unpackTracePayload(payload){
 const keys=objectKeys(payload),encoding=Object.hasOwn(payload,'encoding')?own(payload,'encoding'):undefined;
 if(encoding!==undefined){
  if(encoding!=='orivo-pool-v1'||keys.length!==3||!keys.includes('root')||!keys.includes('pool'))invalid();
  const pool=own(payload,'pool'),length=arrayLength(pool),root=own(payload,'root');
  if(length<1||length>POOL_ENTRIES||root!==length-1)invalid();
  const decoded=[];
  for(let index=0;index<length;index++){
   const entry=own(pool,String(index));if(arrayLength(entry)!==2)invalid();
   const kind=own(entry,'0'),body=own(entry,'1');if(kind!==0&&kind!==1)invalid();
   decoded.push(container(body,kind,value=>{
    if(value!==null&&typeof value==='object'){
     if(arrayLength(value)!==1)invalid();const reference=own(value,'0');
     if(!Number.isSafeInteger(reference)||reference<0||reference>=index)invalid();return decoded[reference];
    }
    return primitive(value);
   }));
  }
  if(own(own(pool,String(root)),'0')!==0)invalid();return decoded[root].value;
 }
 const ancestors=new Set();
 function copy(value,depth=0){
  if(depth>TRACE_DEPTH)invalid();if(value===null||typeof value!=='object')return primitive(value);
  if(ancestors.has(value))invalid();ancestors.add(value);
  try{return container(value,Array.isArray(value)?1:0,child=>copy(child,depth+1));}finally{ancestors.delete(value);}
 }
 const decoded=copy(payload);if(decoded.size>WIRE_BYTES)invalid();return decoded.value;
}
export async function decodeTraceHeader(encoded,id){
 try{
  if(typeof encoded!=='string'||!encoded||encoded.length>24000)return null;
  const packed=encoded.startsWith('z1.'),input=Uint8Array.from(atob(packed?encoded.slice(3):encoded),character=>character.charCodeAt(0));
  let output=input;
  if(packed){
   const reader=new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(),chunks=[];let size=0;
   try{
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>WIRE_BYTES){await reader.cancel();return null;}chunks.push(value);}
    output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
   }finally{reader.releaseLock();}
  }
  if(output.length>WIRE_BYTES)return null;
  const trace=unpackTracePayload(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output)));
  return trace.id===id?trace:null;
 }catch{return null;}
}
