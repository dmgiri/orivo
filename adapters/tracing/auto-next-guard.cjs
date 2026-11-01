'use strict';
// Framework-integrity protection for managed Next processes, not a security
// sandbox against deliberately malicious application code or native addons.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {syncBuiltinESMExports}=require('node:module');
const stateKey=Symbol.for('orivo.next.sourceGuard');

function installSourceGuard(folder) {
  const state=globalThis[stateKey]??={roots:new Map(),patches:[],descriptors:new Map(),installed:false};
  const root=fs.realpathSync(folder);
  if(!fs.statSync(root).isDirectory())throw Error('The protected source root must be a directory.');
  state.roots.set(root,(state.roots.get(root)||0)+1);
  if(!state.installed) {
    state.installed=true;
    const realpath=fs.realpathSync,stat=fs.statSync,lstat=fs.lstatSync,readlink=fs.readlinkSync;
    function within(parent,file) {const relative=path.relative(parent,file);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
    function filename(value) {
      if(typeof value==='string'||Buffer.isBuffer(value))return path.resolve(String(value));
      if(value instanceof URL)return path.resolve(fileURLToPath(value));
      return null;
    }
    function physical(file,depth=0) {
      if(depth>40){const error=Error('Too many source-path symbolic links.');error.code='ELOOP';throw error;}
      let ancestor=file;const suffix=[];
      while(true) {
        try{return path.resolve(realpath(ancestor),...suffix);}
        catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
        // realpath cannot resolve a link to a not-yet-created target. Resolve
        // that target's existing ancestors before allowing a creating write.
        try{if(lstat(ancestor).isSymbolicLink())return path.resolve(physical(path.resolve(path.dirname(ancestor),readlink(ancestor)),depth+1),...suffix);}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
        const parent=path.dirname(ancestor);if(parent===ancestor)return file;
        suffix.unshift(path.basename(ancestor));ancestor=parent;
      }
    }
    function guarded(value,ancestors=false) {
      if(typeof value==='number')value=state.descriptors.get(value);
      else if(value&&typeof value==='object'&&typeof value.fd==='number')value=state.descriptors.get(value.fd);
      const lexical=filename(value);if(!lexical)return false;
      const actual=physical(lexical);
      return [...state.roots.keys()].some(protectedRoot=>within(protectedRoot,lexical)||within(protectedRoot,actual)||ancestors&&(within(lexical,protectedRoot)||within(actual,protectedRoot)));
    }
    function deny(value,ancestors=false) {if(guarded(value,ancestors)){const error=Error('Automatic Next.js attachment protects the original project. A development tool requested a source-file change; complete its normal setup before attaching.');error.code='ORIVO_SOURCE_READ_ONLY';throw error;}}
    function writeFlags(flags) {return typeof flags==='number'?!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wa+]/.test(flags||'');}
    function copyTargets(source,target,options) {
      if(!options?.recursive)return;
      const pending=[[filename(source),filename(target),0]];let entries=0;
      while(pending.length) {
        const [from,to,depth]=pending.pop();if(!from||!to)return;
        if(++entries>50000||depth>32){const error=Error('A recursive copy exceeds the managed source-guard inspection limit.');error.code='ORIVO_SOURCE_GUARD_LIMIT';throw error;}
        deny(to);
        let info=lstat(from);if(info.isSymbolicLink()&&options.dereference)info=stat(from);
        if(!info.isDirectory())continue;
        for(const name of fs.readdirSync(from))pending.push([path.join(from,name),path.join(to,name),depth+1]);
      }
    }
    function record(fd,file) {const value=filename(file);if(typeof fd==='number'&&value)state.descriptors.set(fd,value);}
    function patch(owner,name,wrap) {if(typeof owner[name]!=='function')return;const previous=owner[name],replacement=wrap(previous);owner[name]=replacement;state.patches.push({owner,name,previous,replacement});}
    function callbackFailure(args,error) {const callback=args.at(-1);if(typeof callback!=='function')throw error;queueMicrotask(()=>callback(error));}
    function mutation(owner,name,check,promise=false,sync=false) {
      patch(owner,name,previous=>promise?async function(...args){check(args);return previous.apply(this,args);}:function(...args){try{check(args);}catch(error){if(sync)throw error;return callbackFailure(args,error);}return previous.apply(this,args);});
    }
    const simple=['writeFile','appendFile','truncate','chmod','chown','utimes','lchmod','lchown','lutimes'];
    for(const name of simple) {
      mutation(fs,name,args=>deny(args[0]));mutation(fsp,name,args=>deny(args[0]),true);
      mutation(fs,name+'Sync',args=>deny(args[0]),false,true);
    }
    for(const name of ['unlink','rm','rmdir']) {
      const check=args=>deny(args[0],name!=='unlink');
      mutation(fs,name,check);mutation(fsp,name,check,true);mutation(fs,name+'Sync',check,false,true);
    }
    for(const name of ['rename','copyFile','cp','link','symlink']) {
      const check=args=>{if(name==='rename'||name==='link')deny(args[0],name==='rename');deny(args[1],name==='rename'||name==='cp');if(name==='cp')copyTargets(args[0],args[1],args[2]);};
      mutation(fs,name,check);mutation(fsp,name,check,true);mutation(fs,name+'Sync',check,false,true);
    }
    function mkdirCheck(args) {
      // Recursive mkdir on an existing directory is a read-only ensure step.
      if(args[1]?.recursive===true){try{if(stat(args[0]).isDirectory())return;}catch{}}
      deny(args[0]);
    }
    mutation(fs,'mkdir',mkdirCheck);mutation(fsp,'mkdir',mkdirCheck,true);mutation(fs,'mkdirSync',mkdirCheck,false,true);
    mutation(fs,'mkdtemp',args=>deny(args[0]));mutation(fsp,'mkdtemp',args=>deny(args[0]),true);mutation(fs,'mkdtempSync',args=>deny(args[0]),false,true);
    mutation(fsp,'mkdtempDisposable',args=>deny(args[0]),true);mutation(fs,'mkdtempDisposableSync',args=>deny(args[0]),false,true);
    patch(fs,'openSync',previous=>function(file,flags,...args){if(writeFlags(flags))deny(file);const descriptor=previous.call(this,file,flags,...args);record(descriptor,file);return descriptor;});
    patch(fs,'open',previous=>function(file,flags,...args){
      const callback=args.at(-1);try{if(writeFlags(flags))deny(file);}catch(error){return callbackFailure(args,error);}
      if(typeof callback==='function')args[args.length-1]=function(error,descriptor){if(!error)record(descriptor,file);return callback.apply(this,arguments);};
      return previous.call(this,file,flags,...args);
    });
    const patchedHandles=new WeakSet();
    patch(fsp,'open',previous=>async function(file,flags,...args){
      if(writeFlags(flags))deny(file);
      const handle=await previous.call(this,file,flags,...args);record(handle.fd,file);
      if(!patchedHandles.has(handle)) {
        patchedHandles.add(handle);
        for(const name of ['write','writev','writeFile','appendFile','truncate','chmod','chown','utimes'])if(typeof handle[name]==='function') {
          const original=handle[name];handle[name]=async function(...values){deny(this);return original.apply(this,values);};
        }
        if(typeof handle.createWriteStream==='function'){const original=handle.createWriteStream;handle.createWriteStream=function(...values){deny(this);return original.apply(this,values);};}
        const close=handle.close,descriptor=handle.fd;handle.close=async function(...values){const result=await close.apply(this,values);state.descriptors.delete(descriptor);return result;};
      }
      return handle;
    });
    patch(fs,'createWriteStream',previous=>function(file,options,...args){deny(options?.fd??file);return previous.call(this,file,options,...args);});
    for(const name of ['write','writev','ftruncate','fchmod','fchown','futimes']) {
      mutation(fs,name,args=>deny(args[0]));mutation(fs,name+'Sync',args=>deny(args[0]),false,true);
    }
    patch(fs,'closeSync',previous=>function(descriptor,...args){const result=previous.call(this,descriptor,...args);state.descriptors.delete(descriptor);return result;});
    patch(fs,'close',previous=>function(descriptor,...args){const callback=args.at(-1);if(typeof callback==='function')args[args.length-1]=function(error){if(!error)state.descriptors.delete(descriptor);return callback.apply(this,arguments);};return previous.call(this,descriptor,...args);});
    syncBuiltinESMExports();
  }
  let detached=false;
  return function detachSourceGuard() {
    if(detached)return;detached=true;
    const references=(state.roots.get(root)||0)-1;if(references>0)state.roots.set(root,references);else state.roots.delete(root);
    if(state.roots.size)return;
    for(const {owner,name,previous,replacement} of state.patches.reverse())if(owner[name]===replacement)owner[name]=previous;
    state.patches=[];state.descriptors.clear();state.installed=false;syncBuiltinESMExports();
  };
}
module.exports={installSourceGuard};
if(process.env.ORIVO_SOURCE_GUARD_ROOT)installSourceGuard(process.env.ORIVO_SOURCE_GUARD_ROOT);
