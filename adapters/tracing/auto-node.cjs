'use strict';
// Development-only process preload. No application files are changed. Only the
// managed process, one HTTP listener and correlated requests are instrumented.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {AsyncLocalStorage} = require('node:async_hooks');
const {createHash,randomUUID} = require('node:crypto');
const {fileURLToPath} = require('node:url');
const {deflateSync} = require('node:zlib');
const {isMainThread} = require('node:worker_threads');
const Module = require('node:module');
const {isProxy} = require('node:util').types;
const originalStringify = JSON.stringify;
const {ManagedTraceStore}=require('./managed-trace-store.cjs');
const configFile = process.env.ORIVO_AUTO_NODE_CONFIG || process.env.ORIVO_ATTACH_CONFIG;

function install(config) {
  if (!isMainThread || config.parentPid && config.parentPid !== process.ppid) return;
  const root = fs.realpathSync(config.root), port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || config.host && config.host !== '127.0.0.1' || typeof config.readyToken !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(config.readyToken)) throw Error('Invalid managed Node tracing configuration');
  const storage = new AsyncLocalStorage(), pgCalls = new AsyncLocalStorage(), rowOrigins = new WeakMap(), snapshots = new Map(), queryStarts = new WeakMap();
  const managedTraces=config.traceTransport==='memory-v1'?new ManagedTraceStore():null;
  const skip = new Set(['node_modules','dist','build','out','coverage','target','vendor','venv','__pycache__','archive','archives','evidence']);
  let visited = 0, bytesTotal = 0, snapshotTruncated = false, managedServer = null;
  const managedSockets=new Set();
  // An IPC disconnect also occurs if the desktop host crashes. Do not leave an
  // owned backend alive merely because the normal Stop/close path could not run.
  if(process.connected&&typeof process.send==='function')process.once('disconnect',()=>{
    const timeout=setTimeout(()=>{for(const socket of managedSockets)socket.destroy();process.exit(0);},750);
    timeout.unref();
    if(managedServer)managedServer.close(()=>process.exit(0));else process.exit(0);
  });
  function inside(file) {const rel = path.relative(root,file); return rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);}
  function sourceBytes(file) {try {const stat=fs.statSync(file); if (!stat.isFile() || stat.size>262144) return null; return fs.readFileSync(file);} catch {return null;}}
  function visit(directory, depth) {
    if (depth > 16) {snapshotTruncated = true; return;}
    let entries; try {entries=fs.readdirSync(directory,{withFileTypes:true});} catch {return;}
    for (const entry of entries) {
      if (++visited>30000 || snapshots.size>=5000 || bytesTotal>=33554432) {snapshotTruncated=true; return;}
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file=path.join(directory,entry.name);
      if (entry.isDirectory()) {if (!skip.has(entry.name.toLowerCase())) visit(file,depth+1); continue;}
      if (!entry.isFile() || !/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(entry.name) || /(?:^|[._-])(?:secrets?|credentials)(?:[._-]|$)/i.test(entry.name)) continue;
      const bytes=sourceBytes(file); if (!bytes) continue;
      bytesTotal+=bytes.length;
      snapshots.set(file,{path:path.relative(root,file).replaceAll('\\','/'),hash:createHash('sha256').update(bytes).digest('hex'),lines:bytes.toString('utf8').split('\n').length});
    }
  }
  visit(root,0);
  function site(file,line,name='') {
    try {file=fs.realpathSync(file); const expected=snapshots.get(file), bytes=expected && sourceBytes(file); if (!expected || !bytes || createHash('sha256').update(bytes).digest('hex')!==expected.hash || !Number.isInteger(line) || line<1 || line>expected.lines) return null; return {path:expected.path,line,name:String(name).slice(0,100),hash:expected.hash};} catch {return null;}
  }
  function frames() {
    const previous=Error.stackTraceLimit; let lines;
    try {Error.stackTraceLimit=40; lines=new Error().stack.split('\n').slice(2);} finally {Error.stackTraceLimit=previous;}
    const result=[]; let invalid=false;
    for (const line of lines) {
      let value=line.trim().replace(/^at\s+/,''), name='';
      if (value.endsWith(')') && value.includes(' (')) {const i=value.lastIndexOf(' ('); name=value.slice(0,i); value=value.slice(i+2,-1);}
      const match=value.match(/^(.+):(\d+):(\d+)$/); if (!match) continue;
      let file=match[1]; try {if (file.startsWith('file:')) file=fileURLToPath(file);} catch {continue;}
      if (!path.isAbsolute(file) || !inside(file) || file===__filename || file.startsWith(__dirname+path.sep)) continue;
      const parts=path.relative(root,file).split(path.sep);
      if (parts.some(part=>part==='node_modules')) continue;
      const verified=site(file,Number(match[2]),name); if (!verified) invalid=true; else result.push(verified);
    }
    return invalid ? [] : result.reverse().slice(-12);
  }
  function sanitize(sql) {
    sql=String(sql||'');let output='',index=0;
    while(index<sql.length) {
      if(sql.startsWith('--',index)) {const end=sql.indexOf('\n',index+2);index=end<0?sql.length:end;output+=' ';continue;}
      if(sql.startsWith('/*',index)) {let depth=1;index+=2;while(index<sql.length&&depth) {if(sql.startsWith('/*',index)){depth++;index+=2;}else if(sql.startsWith('*/',index)){depth--;index+=2;}else index++;}output+=' ';continue;}
      if(sql[index]==="'") {index++;while(index<sql.length) {if(sql[index]==='\\'){index+=2;continue;}if(sql[index]==="'"){if(sql[index+1]==="'"){index+=2;continue;}index++;break;}index++;}output+="'?'";continue;}
      if(sql[index]==='$') {const marker=sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];if(marker){const end=sql.indexOf(marker,index+marker.length);index=end<0?sql.length:end+marker.length;output+="'?'";continue;}}
      if(sql[index]==='"') {const start=index++;while(index<sql.length){if(sql[index]==='"'){if(sql[index+1]==='"'){index+=2;continue;}index++;break;}index++;}output+=sql.slice(start,index);continue;}
      if(!/[$?\w]/.test(sql[index-1]||' ')&&/[\d.]/.test(sql[index])) {const number=sql.slice(index).match(/^(?:0x[\da-f]+|0b[01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?!\w)/i)?.[0];if(number){output+='?';index+=number.length;continue;}}
      output+=sql[index++];
    }
    return output.slice(0,6000);
  }
  function record(context,sql) {
    if (!context || context.closed) return null;
    if (context.trace.queries.length>=(managedTraces?256:20) || typeof sql!=='string' || sql.length>6000) {context.trace.truncated=true; return null;}
    const stack=frames(), query={id:randomUUID(),sql:sanitize(sql),site:stack.at(-1)||null,frames:stack,tables:[]};
    context.trace.route ||= stack[0] || null;
    context.trace.queries.push(query); return query;
  }
  function startQuery(context,query) {
    if (!query || queryStarts.has(query)) return;
    const started=performance.now(); queryStarts.set(query,started); query.startOffsetMs=started-context.started;
  }
  function finishQuery(query) {
    if(!query)return;
    const started=queryStarts.get(query);
    if(started!==undefined && query.durationMs===undefined) query.durationMs=performance.now()-started;
  }
  function remember(rows,columns,query,context) {
    if (!query || !Array.isArray(rows) || !Array.isArray(columns)) return;
    const names=new Map(); for (const column of columns) names.set(column.name,(names.get(column.name)||0)+1);
    for (const row of rows.slice(0,2000)) {
      if (!row || typeof row!=='object' || Array.isArray(row)) continue;
      const origins=new Map();
      for (const column of columns) {
        if (names.get(column.name)!==1 || !column.table || !column.column) continue;
        const descriptor=Object.getOwnPropertyDescriptor(row,column.name);
        if (!descriptor || !Object.hasOwn(descriptor,'value') || descriptor.value!==null && !['string','number','boolean','bigint'].includes(typeof descriptor.value) || typeof descriptor.value==='number'&&!Number.isFinite(descriptor.value)) continue;
        origins.set(column.name,{value:descriptor.value,table:column.table,column:column.column,queries:[query.id]});
      }
      rowOrigins.set(row,{origins,context});
    }
  }
  try {
    const {DatabaseSync}=require('node:sqlite'), prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql,...args) {
      const statement=prepare.call(this,sql,...args);
      for (const method of ['all','get','run']) {
        const original=statement[method];
        statement[method]=function(...parameters) {
          const context=storage.getStore(), query=record(context,sql);
          startQuery(context,query);
          let result; try {result=original.apply(this,parameters); finishQuery(query);} catch(error) {finishQuery(query); if(query) query.failed=true; throw error;}
          if (query && method!=='run') {
            try {const columns=this.columns(); query.tables=[...new Set(columns.map(column=>column.table).filter(Boolean))]; remember(method==='get'?[result]:result,columns,query,context);} catch {}
          }
          return result;
        };
      }
      return statement;
    };
  } catch { /* The runtime may support HTTP/pg while lacking built-in SQLite. */ }
  // pg result fields are actual wire metadata. A catalog lookup resolves their
  // relation/attribute IDs; SQL parsing or coincidentally equal values never do.
  const patchedPg=new WeakSet();
  function patchPg(exports) {
    const Client=exports?.Client;
    if (!Client?.prototype) return;
    const Pool=exports?.Pool;
    if (Pool?.prototype && !patchedPg.has(Pool.prototype)) {
      patchedPg.add(Pool.prototype);
      const poolQuery=Pool.prototype.query;
      Pool.prototype.query=function(...args) {
        const context=storage.getStore(), sql=typeof args[0]==='string'?args[0]:args[0]?.text;
        if(!context||context.closed||args[0]?.rowMode==='array'||args[0]?.submit||args[0]?.callback)return poolQuery.apply(this,args);
        const query=record(context,sql); if(!query)return poolQuery.apply(this,args);
        startQuery(context,query);
        const callback=typeof args.at(-1)==='function'?args.pop():null;
        if(callback)args.push((error,result)=>{finishQuery(query);if(error)query.failed=true;return callback(error,result);});
        let result;try{result=pgCalls.run({query,context,sql},()=>poolQuery.apply(this,args));}catch(error){finishQuery(query);query.failed=true;throw error;}
        return result&&typeof result.then==='function'?result.then(value=>{finishQuery(query);return value;},error=>{finishQuery(query);query.failed=true;throw error;}):result;
      };
    }
    if(patchedPg.has(Client.prototype))return;
    patchedPg.add(Client.prototype);
    const original=Client.prototype.query;
    Client.prototype.query=function(...args) {
      const context=storage.getStore(), sql=typeof args[0]==='string'?args[0]:args[0]?.text;
      if (!context || context.closed || args[0]?.rowMode==='array' || args[0]?.submit || args[0]?.callback) return original.apply(this,args);
      const pending=pgCalls.getStore(),query=pending?.context===context&&pending.sql===sql?pending.query:record(context,sql); if (!query) return original.apply(this,args);
      startQuery(context,query);
      const callback=typeof args.at(-1)==='function'?args.pop():null, client=this;
      async function capture(result) {
        finishQuery(query);
        if (!result || Array.isArray(result) || !Array.isArray(result.fields) || !Array.isArray(result.rows)) return result;
        const identifiers=[...new Set(result.fields.filter(field=>Number.isInteger(field.tableID)&&field.tableID>0&&Number.isInteger(field.columnID)&&field.columnID>0).map(field=>field.tableID))].slice(0,64);
        if (!identifiers.length) return result;
        try {
          const catalog=await original.call(client,'SELECT a.attrelid::text AS relation_id, a.attnum AS column_id, n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped',[identifiers]);
          const columns=result.fields.map(field=>{const row=catalog.rows?.find(row=>String(row.relation_id)===String(field.tableID)&&Number(row.column_id)===field.columnID); return {name:field.name,table:row?row.schema_name+'.'+row.table_name:null,column:row?.column_name};});
          query.tables=[...new Set(columns.map(column=>column.table).filter(Boolean))]; remember(result.rows,columns,query,context);
        } catch { /* Query execution remains visible if catalog access is denied. */ }
        return result;
      }
      if (callback) {
        args.push((error,result)=>{if(error) {finishQuery(query);query.failed=true; return callback(error,result);} capture(result).then(value=>callback(null,value),()=>callback(null,result));});
        try{return original.apply(client,args);}catch(error){finishQuery(query);query.failed=true;throw error;}
      }
      let result; try {result=original.apply(client,args);} catch(error) {finishQuery(query);query.failed=true; throw error;}
      return result && typeof result.then==='function'?result.then(capture,error=>{finishQuery(query);query.failed=true;throw error;}):result;
    };
  }
  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain) {const exports=originalLoad.apply(this,arguments); if(request==='pg'||/[\\/]pg[\\/]lib[\\/]index\.js$/.test(request)) {try {patchPg(exports);} catch {}} return exports;};
  function mappedFields(value,context) {
    const fields=Object.create(null), active=new WeakSet(); let count=0;
    function walk(item,prefix,depth) {
      if (!item || typeof item!=='object' || isProxy(item) || depth>16 || ++count>10000 || active.has(item)) return;
      const prototype=Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype!==Object.prototype && prototype!==null) return;
      for (let current=item;current;current=Object.getPrototypeOf(current)) if(Object.getOwnPropertyDescriptor(current,'toJSON')) return;
      active.add(item);
      const known=rowOrigins.get(item), descriptors=Object.getOwnPropertyDescriptors(item);
      for (const [key,descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(item) && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key)>=item.length)) continue;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value') || !key || /[.\x00-\x1f\x7f]/.test(key) || ['__proto__','constructor','prototype'].includes(key)) continue;
        const target=prefix?prefix+'.'+key:key;
        if (target.length>200) continue;
        const origin=known?.context===context?known.origins.get(key):null;
        if (origin && Object.is(origin.value,descriptor.value) && Object.keys(fields).length<200) fields[target]={table:origin.table,column:origin.column,model:null,queries:origin.queries};
        walk(descriptor.value,target,depth+1);
      }
      active.delete(item);
    }
    walk(value,'',0); return fields;
  }
  JSON.stringify=function(value,replacer,space) {
    const result=originalStringify.apply(this,arguments), context=storage.getStore();
    if (context && !context.closed && !context.serializing && replacer===undefined && typeof result==='string' && result.length<=2097152) {
      context.serializing=true;
      try {const fields=mappedFields(value,context); if(Object.keys(fields).length) {if(context.serializations.size>=8) context.serializations.delete(context.serializations.keys().next().value); context.serializations.set(result,fields);}} catch {} finally {context.serializing=false;}
    }
    return result;
  };
  function header(context,body) {
    const trace=context.trace;
    function fresh(source) {return source && site(path.join(root,source.path),source.line,source.name)?.hash===source.hash?source:null;}
    const route=fresh(trace.route), queries=trace.queries.map(query=>{const intact=query.frames.every(fresh);return {...query,site:intact?fresh(query.site):null,frames:intact?query.frames:[]};});
    const fields=Object.create(null), claims=body!==null?context.serializations.get(body):null;
    if(route && claims) for(const [name,origin] of Object.entries(claims)) if(origin.queries.every(id=>queries.some(query=>query.id===id&&!query.failed&&query.site))) fields[name]=origin;
    function encode(value) {const bytes=Buffer.from(originalStringify(value));if(bytes.length>300000)return null;const plain=bytes.toString('base64');return plain.length>3072?'z1.'+deflateSync(bytes).toString('base64'):plain;}
    const payload={...trace,durationMs:performance.now()-context.started,route,queries,fields};
    const full=encode(payload); if(full && full.length<=6144)return full;
    if(managedTraces){const key=managedTraces.publish(originalStringify(payload));if(key)return Buffer.from(originalStringify({id:trace.id,ref:'orivo-managed-v1',key})).toString('base64');}
    return encode({id:trace.id,route:null,queries:[],fields:{},truncated:true});
  }
  const originalListen=http.Server.prototype.listen;
  http.Server.prototype.listen=function(...args) {
    const option=args[0], declared=typeof option==='object'?option?.port:Number(option), expected=Number(config.originalPort);
    if (!managedServer && (!expected || expected===declared)) {
      managedServer=this;
      this.on('connection',socket=>{managedSockets.add(socket);socket.once('close',()=>managedSockets.delete(socket));});
      const callback=typeof args.at(-1)==='function'?args.at(-1):undefined;
      const options=typeof option==='object'&&option?{...option}:{};
      delete options.path; delete options.fd; options.port=port; options.host='127.0.0.1'; options.exclusive=true;
      return originalListen.call(this,options,...(callback?[callback]:[]));
    }
    return originalListen.apply(this,args);
  };
  const originalEmit=http.Server.prototype.emit;
  http.Server.prototype.emit=function(event,request,response,...args) {
    if(event!=='request'||this!==managedServer)return originalEmit.apply(this,arguments);
    if(request.url?.startsWith('/__orivo_trace/')){const match=new RegExp('^/__orivo_trace/'+config.readyToken+'/([a-f0-9]{32})$').exec(request.url);const raw=managedTraces&&request.method==='GET'&&match?managedTraces.get(match[1]):null;response.writeHead(raw===null?404:200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(raw||'{}');return true;}
    if(request.url==='/__orivo_managed_ready/'+config.readyToken) {response.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end(config.readyToken);return true;}
    const id=request?.headers?.['x-studio-trace'];
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(id))return originalEmit.apply(this,arguments);
    const context={started:performance.now(),trace:{id,route:null,queries:[],truncated:snapshotTruncated},serializations:new Map(),closed:false,serializing:false};
    const end=response.end, write=response.write, writeHead=response.writeHead;
    let streamed=false;
    function publish(body) {if(context.closed||response.headersSent)return;try {response.setHeader('Studio-Trace',header(context,body));}catch {}}
    response.write=function(...chunks) {streamed=true;publish(null);return write.apply(this,chunks);};
    response.writeHead=function(...values) {publish(null);return writeHead.apply(this,values);};
    response.end=function(...chunks) {
      const body=!streamed&&typeof chunks[0]==='string'?chunks[0]:!streamed&&Buffer.isBuffer(chunks[0])?chunks[0].toString('utf8'):null;
      publish(body);context.closed=true;context.serializations.clear();return end.apply(this,chunks);
    };
    response.once('close',()=>{context.closed=true;context.serializations.clear();});
    return storage.run(context,()=>originalEmit.call(this,event,request,response,...args));
  };
}
if(configFile) {
  try {const stat=fs.statSync(configFile);if(!stat.isFile()||stat.size>65536)throw Error('Invalid tracing configuration file');install(JSON.parse(fs.readFileSync(configFile,'utf8')));} catch(error) {process.stderr.write('Orivo automatic Node tracing could not start: '+String(error.message).slice(0,180)+'\n');process.exit(1);}
}
