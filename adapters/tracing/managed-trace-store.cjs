'use strict';
// Owned-process memory only. Entries expire and are never written to the app.
class ManagedTraceStore {
 constructor(){this.entries=new Map();this.bytes=0;}
 expire(){const now=Date.now();for(const [key,entry]of this.entries){if(now-entry.created<90000)continue;this.entries.delete(key);this.bytes-=entry.bytes;}}
 publish(raw){
  if(typeof raw!=='string')return null;
  const size=Buffer.byteLength(raw);if(size>2*1024*1024)return null;
  try{if(!/^[A-Za-z0-9_-]{8,80}$/.test(JSON.parse(raw)?.id||''))return null;}catch{return null;}
  this.expire();while(this.entries.size>=256||this.bytes+size>64*1024*1024){const [key,entry]=this.entries.entries().next().value;this.entries.delete(key);this.bytes-=entry.bytes;}
  const key=require('node:crypto').randomBytes(16).toString('hex');this.entries.set(key,{raw,bytes:size,created:Date.now()});this.bytes+=size;return key;
 }
 get(key){this.expire();return /^[a-f0-9]{32}$/.test(key||'')?this.entries.get(key)?.raw||null:null;}
 close(){this.entries.clear();this.bytes=0;}
}
module.exports={ManagedTraceStore};
