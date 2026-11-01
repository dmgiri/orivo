'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {redact} = require('./source-context.cjs');
const {readElementFlow, buildElementFlow} = require('./element-flow.cjs');
const {readComponentHierarchy} = require('./component-hierarchy.cjs');

const LIMITS = Object.freeze({files: 5000, bytes: 40 * 1024 * 1024, fileBytes: 262144, depth: 16, entries: 40000});
const INDEX_PROFILES = Object.freeze({standard: LIMITS, large: Object.freeze({files: 25000, bytes: 256 * 1024 * 1024, fileBytes: 1024 * 1024, depth: 32, entries: 200000})});
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sql', '.html', '.css', '.scss', '.sass', '.vue', '.svelte', '.json', '.toml', '.yaml', '.yml', '.graphql', '.gql', '.prisma', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php']);
const OMIT_DIR = /^(?:node_modules|vendor|dist|build|out|target|coverage|logs?|data|databases?|uploads?|storage|archives?|backups?|tmp|temp|cache|__pycache__|venv|env|site-packages|release)$/i;
const OMIT_FILE = /(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?|service[-_]?accounts?|tokens?|passwords?|sessions?|cookies?)(?:[._-]|$)|(?:^|[._-])(?:package-lock|pnpm-lock|yarn\.lock|npm-shrinkwrap)|\.(?:pem|key|p12|pfx|db|sqlite\d*|log|csv|tsv|parquet|zip|map)$/i;

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function safeName(value) {
  return typeof value === 'string' && value.length <= 512 && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !path.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || OMIT_DIR.test(part) || OMIT_FILE.test(part));
}

async function indexRepository(folder, options = {}) {
  const profile = options.profile ?? 'standard';
  if (!Object.hasOwn(INDEX_PROFILES, profile)) throw Error('Choose a supported source index profile.');
  const limits = INDEX_PROFILES[profile];
  if (typeof folder !== 'string' || !folder || folder.length > 4096) throw Error('Choose a repository folder.');
  const root = await fsp.realpath(path.resolve(folder));
  if (!(await fsp.stat(root)).isDirectory()) throw Error('The selected repository is not a folder.');
  const files = [], skipped = {excluded: 0, tooLarge: 0, binary: 0, unreadable: 0, symlinks: 0};
  let totalBytes = 0, entries = 0, truncated = false;
  async function walk(directory, depth) {
    if (depth > limits.depth) {truncated = true; return;}
    let children;
    try { children = await fsp.readdir(directory, {withFileTypes: true}); } catch {skipped.unreadable++; return;}
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      if (++entries > limits.entries || files.length >= limits.files || totalBytes >= limits.bytes) {truncated = true; return;}
      if (entry.isSymbolicLink()) {skipped.symlinks++; continue;}
      if (entry.name.startsWith('.') || OMIT_FILE.test(entry.name)) {skipped.excluded++; continue;}
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {if (OMIT_DIR.test(entry.name)) skipped.excluded++; else await walk(filename, depth + 1); continue;}
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {skipped.excluded++; continue;}
      try {
        const actual = await fsp.realpath(filename), stat = await fsp.lstat(filename);
        if (!within(root, actual) || stat.isSymbolicLink() || !stat.isFile()) {skipped.symlinks++; continue;}
        if (stat.size > limits.fileBytes || stat.size + totalBytes > limits.bytes) {skipped.tooLarge++; continue;}
        const bytes = await fsp.readFile(actual);
        if (bytes.length > limits.fileBytes || bytes.length + totalBytes > limits.bytes) {skipped.tooLarge++; continue;}
        if (bytes.includes(0)) {skipped.binary++; continue;}
        files.push({path: path.relative(root, actual).replaceAll('\\', '/'), hash: hash(bytes), text: redact(bytes.toString('utf8')), bytes: bytes.length});
        totalBytes += bytes.length;
      } catch {skipped.unreadable++;}
    }
  }
  await walk(root, 0);
  return {root, files, indexedAt: new Date().toISOString(), totalBytes, skipped, truncated, limits, profile};
}

function currentFile(index, name) {
  if (!index || typeof index.root !== 'string' || !Array.isArray(index.files) || !safeName(name)) return null;
  const row = index.files.find(file => file.path === name);
  if (!row || !/^[a-f0-9]{64}$/.test(row.hash || '')) return null;
  try {
    const candidate = path.resolve(index.root, name), actual = fs.realpathSync(candidate);
    if (!within(index.root, actual)) return null;
    // Reject symlinked path segments even when they resolve inside the root.
    let segment = index.root;
    for (const part of name.split('/')) {segment = path.join(segment, part); if (fs.lstatSync(segment).isSymbolicLink()) return null;}
    const stat = fs.statSync(actual);
    const limits = INDEX_PROFILES[index.profile] || LIMITS;
    if (!stat.isFile() || stat.size > limits.fileBytes) return null;
    const bytes = fs.readFileSync(actual);
    if (bytes.includes(0) || hash(bytes) !== row.hash) return null;
    return {...row, text: redact(bytes.toString('utf8'))};
  } catch {return null;}
}

function language(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ({mjs:'javascript', cjs:'javascript', js:'javascript', jsx:'jsx', ts:'typescript', tsx:'tsx', py:'python', gql:'graphql'})[ext] || ext || 'text';
}

function readSource(index, name, requestedLine = 1) {
  const file = currentFile(index, name);
  if (!file) throw Error('Source is excluded, outside this repository, or changed since indexing. Refresh the repository and recapture.');
  const all = file.text.split('\n'), line = Math.max(1, Math.min(all.length, Number.isInteger(requestedLine) ? requestedLine : 1));
  const startLine = Math.max(1, line - 5), endLine = Math.min(all.length, line + 10);
  const lines = all.slice(startLine - 1, endLine).map((text, offset) => ({number: startLine + offset, text, highlight: startLine + offset === line}));
  return {path: name, line, startLine, endLine, code: lines.map(row => row.text).join('\n'), lines, language: language(name), hash: file.hash};
}

// The page is untrusted. Copy only bounded own data properties; never execute a
// getter, prototype method, application callback, or a deserialized function.
function plainCopy(value, state = {budget: 100000, characters: 0}, depth = 0) {
  if (--state.budget < 0 || depth > 18 || (state.characters += 2) > 2097152) throw Error('Trace exceeds the capture limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {if (value.length > 12000 || (state.characters += value.length) > 2097152) throw Error('Trace text exceeds the capture limit.'); return value;}
  if (typeof value !== 'object') throw Error('Trace contains unsupported data.');
  if (Array.isArray(value) && value.length > 512) throw Error('Trace list exceeds the capture limit.');
  const out = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || (state.characters += key.length + 4) > 2097152) throw Error('Unsafe or oversized trace key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Trace accessors are unsupported.');
    out[key] = plainCopy(descriptor.value, state, depth + 1);
  }
  return out;
}

function resolveTrace(options = {}) {
  const index = options.index || options.repository;
  if (!index || !Array.isArray(index.files) || !index.root) throw Error('Connect and index a repository first.');
  const capture = options.capture || {};
  const url = options.url || capture.url;
  const address = new URL(url);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw Error('Only HTTP or HTTPS application pages are supported.');
  let trace = null, frames = [], invalid = null;
  try {trace = options.trace || capture.trace ? plainCopy(options.trace || capture.trace) : null; frames = plainCopy(options.frames || capture.frames || []);} catch (error) {invalid = error.message;}
  const inputTarget = options.target || capture.target || {};
  const target = typeof inputTarget === 'string' ? {selector: inputTarget} : inputTarget;
  const selector = typeof target.selector === 'string' ? target.selector.slice(0, 512) : '';
  const label = redact(typeof target.label === 'string' ? target.label.slice(0, 100) : target.tag || 'Selected element');
  const requested = new Set();
  function want(site) {if (site && typeof site.path === 'string') requested.add(site.path);}
  function wantModel(value,depth=0){
    if(!value||depth>5)return;
    want(value.modelSource);want(value.fieldSource);
    if(value.kind==='computed')wantModel(value.operation,depth+1);
    else if(value.op){wantModel(value.left,depth+1);wantModel(value.right,depth+1);}
  }
  if (trace) {
    want(trace.source);
    for (const dependency of Array.isArray(trace.dependencies) ? trace.dependencies : []) {
      want(dependency?.backend?.route);
      const origin=dependency?.backend?.fields?.[dependency?.field];
      want(origin?.projection);wantModel(origin);
      for (const query of Array.isArray(dependency?.backend?.queries) ? dependency.backend.queries : []) {want(query?.site); for (const frame of Array.isArray(query?.frames) ? query.frames : []) want(frame); for(const model of Array.isArray(query?.models)?query.models.slice(0,12):[])want(model?.modelSource);}
    }
  }
  // Trace source claims are validated against fresh disk bytes on every capture,
  // rather than accepting the index's earlier snapshot as current evidence.
  const verified = new Map();
  for (const name of requested) {const file = currentFile(index, name); if (file) verified.set(name, file);}
  const liveIndex = {...index, files: index.files.filter(file => !requested.has(file.path) || verified.has(file.path)).map(file => verified.get(file.path) || file)};
  let flow;
  try {flow = buildElementFlow(liveIndex, index.root, frames, url, trace, target, Boolean(options.runtimeAvailable ?? capture.runtimeAvailable));}
  catch (error) {flow = {captured:false, mode:null, source:null, dependencies:[], gaps:[error.message], hierarchy:{frames:[], note:'Runtime hierarchy could not be validated.'}};}
  if (invalid) flow.gaps.push(invalid);
  const graph = {id:'trace-' + hash(Buffer.from([url, selector, trace?.source?.hash || '', new Date().toISOString()].join('|'))).slice(0, 16), title:label, url:address.origin + address.pathname, selector, mode:flow.mode || 'unavailable', captured:flow.captured, coverage:'unavailable', capturedAt:new Date().toISOString(), nodes:[], edges:[], gaps:[...new Set(flow.gaps)], files:[], summary:{requests:0,queries:0,tables:0}, diagnostics:[], hierarchy:flow.hierarchy, reason:flow.reason || null};
  const files = new Set(), tables = new Set(), edgeKeys = new Set();
  const browserTimings = new Map(), backendTimings = new Map(), queryTimings = new Map();
  function node(kind, label, subtitle, detail, extra = {}) {
    const row = {id:`${kind}-${graph.nodes.length + 1}`, kind, label:redact(label), subtitle:redact(subtitle || ''), status:kind === 'gap' ? 'missing' : 'captured', detail:redact(detail || ''), ...extra};
    if (row.file) files.add(row.file);
    graph.nodes.push(row); return row;
  }
  function edge(from, to, label) {
    const key = JSON.stringify([from.id, to.id, label]);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    graph.edges.push({id:`edge-${graph.edges.length + 1}`, from:from.id, to:to.id, label});
  }
  function gap(from, message) {if (!graph.gaps.includes(message)) graph.gaps.push(message); const title={not_running:'Tracing is off',unsupported_element:'Element binding missing',source_changed:'Source needs refresh',invalid_trace:'Trace could not be verified'}[graph.reason]||'Connection not captured'; const row = node('gap', title, message, message); if (from) edge(from, row, 'missing evidence'); return row;}
  function sourceNode(site, kind, label, detail, meta = {}) {
    let window; try {window = readSource(index, site.path, site.line);} catch {return null;}
    return node(kind, label || path.basename(site.path), `${site.path}:${site.line}`, detail, {file:site.path,line:site.line,code:window.code,startLine:window.startLine,language:window.language,meta:{sourceHash:site.hash,...meta}});
  }
  const element = node('element', label, selector || target.tag || 'DOM selection', 'Selected from the running application. No application handlers are invoked to select it.', {meta:{tag:typeof target.tag === 'string' ? target.tag.slice(0, 30) : '', selector}});
  let binding = element;
  if (flow.source) {
    binding = sourceNode(flow.source, 'source', flow.source.name || path.basename(flow.source.path), 'Captured original frontend binding. The SHA-256 hash matches current repository bytes.', {expression:flow.source.expression, bindingKind:flow.source.kind,sourceRole:'frontend'}) || element;
    if (binding !== element) edge(element, binding, 'rendered by');
  }
  for(const value of flow.localValues||[]){
    const fallback=sourceNode(value.source,'source','Local literal fallback',value.role==='value'?'The running frontend selected this literal fallback. Its source is verified; the visible fallback is not a value returned by a database query.':'This observed local fallback participates in a lookup or branch condition.',{sourceRole:'frontend-local',localValue:true,dependencyRole:value.role});
    if(fallback)edge(binding,fallback,value.role==='value'?'uses local fallback':'uses local branch input');
  }
  if(flow.valueOrigin==='local')graph.valueOrigin='local';
  if (!flow.captured) {
    for (const message of graph.gaps.length ? [...graph.gaps] : ['No captured binding is available for this element.']) gap(element, message);
  } else {
    // A JSX expression may read several fields from one response. Those fields
    // share one request/execution graph; they do not create new HTTP/SQL work.
    // Conflicting captures for the same ID cannot be silently joined.
    const contexts=new Map();
    for(const dependency of flow.dependencies){
      const id=dependency.request.id;let context=contexts.get(id);
      if(!context){context={request:{...dependency.request},backend:dependency.backend,queries:new Map(),dependencies:[],fields:new Map(),conflict:false};contexts.set(id,context);}
      const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
      if(!same([context.request.method,context.request.url,context.request.status],[dependency.request.method,dependency.request.url,dependency.request.status]))context.conflict=true;
      for(const [target,input] of [[context.request,dependency.request],[context.backend,dependency.backend]])if(target&&input){
        if(target.durationMs!==undefined&&input.durationMs!==undefined&&target.durationMs!==input.durationMs)context.conflict=true;
        else if(input.durationMs!==undefined)target.durationMs=input.durationMs;
      }
      if(context.backend&&dependency.backend&&!same(context.backend.route,dependency.backend.route))context.conflict=true;
      context.backend ||= dependency.backend;
      for(const query of dependency.queries){
        const known=context.queries.get(query.id);
        if(known){
          const signature=value=>[value.sql,value.site,value.frames,value.sourceVerified,value.failed,[...new Set(value.tables)].sort(),value.models||[]];
          if(!same(signature(known),signature(query)))context.conflict=true;
          for(const key of ['durationMs','startOffsetMs'])if(known[key]!==undefined&&query[key]!==undefined&&known[key]!==query[key])context.conflict=true;else if(query[key]!==undefined)known[key]=query[key];
        }else context.queries.set(query.id,{...query});
      }
      if(context.fields.has(dependency.field)&&!same(context.fields.get(dependency.field),dependency.fieldOrigin))context.conflict=true;
      context.fields.set(dependency.field,dependency.fieldOrigin);
      context.dependencies.push(dependency);
    }
    for (const context of contexts.values()) {
      const dependency={...context.dependencies[0],request:context.request,backend:context.backend,queries:[...context.queries.values()]};
      graph.summary.requests++;
      const request = dependency.request;
      const responseFields=[...new Set(context.dependencies.map(item=>item.field).filter(Boolean))];
      const api = node('api', `${request.method} ${new URL(request.url).pathname}`, responseFields.length ? `Response · ${responseFields[0]}${responseFields.length>1?' + '+(responseFields.length-1)+' fields':''}` : `HTTP ${request.status}`, 'Same-origin request correlated to this selected binding. Browser duration measures fetch start to response headers, excluding JSON parsing.', {meta:{requestId:request.id,status:request.status,responseField:responseFields[0] || 'Not captured',responseFields,url:request.url,...(!context.conflict&&request.durationMs!==undefined?{durationMs:request.durationMs,timingScope:'browser-fetch-headers'}:{})}});
      for(const item of context.dependencies){
        if(item.collection){
          const calculation=sourceNode(flow.source,'source',item.role==='control'?'Collection condition':'Frontend collection calculation',item.collectionUnknown?'This collection calculation has untraced filtering inputs. Any captured input membership and query context remain visible, but the complete calculation is not proven.':item.collectionOrigin?item.role==='control'?'This observed response collection controls a frontend branch that can change the displayed count. Its query-result membership is captured. Its length is a condition input, not the displayed count or a stored column.':'The adapter observed this response collection through native JavaScript array operations. Its input array has captured query-result membership evidence. The resulting count is computed in the frontend; it is not a database column or a SQL COUNT result.':'The adapter observed this response collection through native JavaScript array operations. Its resulting count is computed in the frontend. Captured queries below are request context; a database column or query cardinality is not asserted.',{sourceRole:'frontend-collection',collection:true,dependencyRole:item.role,operations:item.operations,responseCollection:item.field,requestId:request.id,...(item.collectionOrigin?{membershipVerified:true}:{}),...(item.collectionUnknown?{unknownControls:true}:{})});
          if(calculation){edge(binding,calculation,item.role==='control'?'checks collection condition':'calculates collection value');edge(calculation,api,item.field?`${item.role==='control'?'checks':'reads'} array ${item.field}`:item.role==='control'?'checks response array':'reads response array');}
          else edge(binding,api,'reads response collection');
        }else edge(binding,api,item.field?`${item.role==='control'?'checks':'reads'} ${item.field}`:'triggered request');
      }
      if(context.conflict){gap(api,'Captures sharing this request ID disagree about the request, backend, query or field mapping. Recapture this request; conflicting evidence was not merged.');continue;}
      if(request.durationMs!==undefined)browserTimings.set(request.id,request.durationMs);
      let backend = null;
      if (dependency.backend) backend = sourceNode(dependency.backend.route, 'backend', dependency.backend.route.name || 'Request handler', 'Backend request ID matches the browser request. Handler source matches current repository bytes. Server duration measures the correlated request to response headers within its own process.', {requestId:request.id,...(dependency.backend.durationMs!==undefined?{durationMs:dependency.backend.durationMs,timingScope:'server-response-headers'}:{})});
      if(dependency.backend?.durationMs!==undefined)backendTimings.set(request.id,dependency.backend.durationMs);
      if (backend) edge(api, backend, 'handled by');
      else backend = gap(api, 'Backend execution/source evidence is unavailable or differs from current repository files.');
      // Keep each captured execution ID for field lineage, but share verified
      // call paths and matching SQL within this request's response dependency.
      // A source stack's queryCount is not a count of function invocations.
      const queryNodes = new Map(), callNodes = new Map(), queryGroups = new Map();
      for (const query of dependency.queries) {
        graph.summary.queries++;
        let previous = backend;
        const route = dependency.backend?.route;
        const seen = new Set(route ? [`${route.path}:${route.line}`] : []);
        for (const frame of query.frames) {
          const key = `${frame.path}:${frame.line}`;
          if (seen.has(key) || query.site && key === `${query.site.path}:${query.site.line}`) continue;
          seen.add(key);
          const frameKey = JSON.stringify([previous.id, frame.path, frame.line, frame.hash, frame.name]);
          let step = callNodes.get(frameKey);
          if (!step) {
            step = sourceNode(frame, 'source', frame.name || path.basename(frame.path), 'Captured backend call stack frame with matching current source. Shared by the listed SQL executions; this does not count function invocations.',{sourceRole:'backend-call',queryCount:0,queryIds:[],requestId:request.id});
            if (step) callNodes.set(frameKey, step);
          }
          if (step) {step.meta.queryCount++; step.meta.queryIds.push(query.id); edge(previous, step, 'calls'); previous = step;}
        }
        // Do not merge different statements, source sites, call paths, failure
        // outcomes, or requests. Unverified query sources cannot be grouped.
        const groupKey = query.sourceVerified ? JSON.stringify([true, previous.id, query.site, query.sql, query.failed, [...new Set(query.tables)].sort()]) : JSON.stringify([false, query.id]);
        let queryNode = queryGroups.get(groupKey);
        if (!queryNode) {
          queryNode = node('query', query.failed ? 'SQL execution failed' : 'SQL execution', query.site ? `${query.site.path}:${query.site.line}` : 'Source location unavailable', 'SQL was captured during this correlated request. Matching executions at the same verified source and call path share this block; execution IDs and counts are retained. Literal values are redacted. Executed tables alone do not prove a displayed field origin. Measured query offsets use the backend request clock; durations exclude optional result-column catalog lookups.', {code:query.sql,language:'sql',...(query.site ? {file:query.site.path,line:query.site.line} : {}),meta:{executionCount:0,queryIds:[],executions:[],queryId:query.id,requestId:request.id,failed:query.failed,...(query.site?{sourceHash:query.site.hash}:{}),executedTables:query.tables.join(', ') || 'Not captured'}});
          queryGroups.set(groupKey, queryNode);
        }
        queryNode.meta.executionCount++;
        queryNode.meta.queryIds.push(query.id);
        queryNode.meta.executions.push({id:query.id,...(query.durationMs!==undefined?{durationMs:query.durationMs}:{}),...(query.startOffsetMs!==undefined?{startOffsetMs:query.startOffsetMs}:{})});
        if(query.durationMs!==undefined){
          const meta=queryNode.meta;
          meta.measuredCount=(meta.measuredCount||0)+1;
          meta.totalDurationMs=(meta.totalDurationMs||0)+query.durationMs;
          meta.durationMs=meta.totalDurationMs;
          meta.minDurationMs=Math.min(meta.minDurationMs??Infinity,query.durationMs);
          meta.maxDurationMs=Math.max(meta.maxDurationMs??0,query.durationMs);
          queryTimings.set(request.id+':'+query.id,query.durationMs);
        }
        edge(previous, queryNode, 'executes'); queryNodes.set(query.id, queryNode);
      }
      for(const queryNode of queryGroups.values())if(queryNode.meta.executionCount>=3&&!queryNode.meta.failed&&/^(?:SELECT|WITH)\b/i.test(queryNode.code.trimStart()))graph.diagnostics.push({code:'potential_n_plus_one',severity:'info',title:'Potential N+1 query pattern',detail:`The same verified statement and source path executed ${queryNode.meta.executionCount} times in this request. Consider whether related records can be fetched together. Repeated execution alone does not prove an N+1 problem.`,nodeIds:[queryNode.id],requestId:request.id,count:queryNode.meta.executionCount});
      const originRows=new Set(),fieldModels=new Map();
      const modelKey=value=>JSON.stringify([value.model,value.modelSource.path,value.modelSource.line,value.modelSource.hash]);
      for(const selected of context.dependencies){
       const key=JSON.stringify([selected.field,selected.fieldOrigin]);if(originRows.has(key))continue;originRows.add(key);
       if (selected.fieldOrigin) {
        const origin = selected.fieldOrigin;
        const computed=origin.kind==='computed',formatted=['isoformat','enum-value'].includes(origin.transformation),inputs=computed?origin.inputs:[origin];
        const formattingDetail=origin.transformation==='enum-value'?'The captured response serializer converted the loaded ORM Enum to its primitive value. The executed query, ORM attribute and response mapping source establish this dependency.':'The running Python application formatted the loaded ORM date/time value with isoformat(). The query, ORM attribute and formatting source are captured; the displayed text is a formatted dependency of that column.';
        const projection=origin.projection?sourceNode(origin.projection,'source',computed?'Python calculated response':formatted?'Python response formatting':'Python response mapping',computed?'The captured frozen Pydantic DTO calculated this response field using the displayed numeric operations over loaded, unmodified ORM attributes. Constants are redacted. Every input has captured query and current source evidence.':formatted?formattingDetail:'The captured Python mapping maps this response field directly from the ORM attribute loaded by the captured query.',{sourceRole:'response-mapping',responseField:selected.field,...(computed?{computed:true,immutable:true,expression:origin.expression,inputColumns:inputs.map(input=>input.table+'.'+input.column),operation:origin.operation}:{table:origin.table,column:origin.column,...(formatted?{transformation:origin.transformation}:{})})}):null;
        for(const input of inputs){
          tables.add(input.table);
          const definition=input.modelSource?sourceNode(input.fieldSource||input.modelSource,'model',`${input.model}.${input.attribute}`,'The runtime ORM mapper links this model attribute to the captured result column. This block shows its verified source definition, not an executed function or an additional query.',{sourceRole:'model-definition',definitionOnly:true,model:input.model,attribute:input.attribute,table:input.table,column:input.column,responseField:selected.field,modelSource:input.modelSource,...(input.fieldSource?{fieldSource:input.fieldSource}:{}),...(input.type?{type:input.type}:{}),...(typeof input.nullable==='boolean'?{nullable:input.nullable}:{}),...(computed?{computedInput:true}:{})}):null;
          const database = node('database', `${input.table}.${input.column}`, input.model ? `Model · ${input.model}` : 'Verified result column', selected.role==='control'?'The adapter linked this lookup or branch input to a database result column. This is control context; it does not claim that the visible value is this column.':'The adapter explicitly linked this response field to a database result column. Related route and query source hashes match current files.', {meta:{table:input.table,column:input.column,responseField:selected.field,dependencyRole:selected.role,model:input.model || 'Direct result column',...(input.modelDefinitionStatus?{modelDefinitionStatus:input.modelDefinitionStatus}:{}),...(computed?{computedInput:true}:{})}});
          if(definition){
            files.add(input.modelSource.path);
            for(const id of input.queries){if(!fieldModels.has(id))fieldModels.set(id,new Set());fieldModels.get(id).add(modelKey(input));}
          }
          for (const id of input.queries) {const queryNode = queryNodes.get(id); if (queryNode) edge(queryNode, projection||definition||database, projection?'mapped to response':definition?'loads model field':'returns this column');}
          if(projection)edge(projection,definition||database,computed?'calculation input':formatted?'formatted from':definition?'mapped by':'field origin');
          if(definition)edge(definition,database,'maps to column');
        }
       } else if(selected.collection){
        if(selected.collectionOrigin){
          const witness=selected.collectionOrigin,collection=sourceNode(witness.source,'source','Query result collection','The adapter observed the native query result being collected into this exact response array. Supported list transformations and serialization retained its membership. The count is the response array length, not the displayed frontend count or a SQL aggregate.',{sourceRole:'response-collection',collection:true,membershipVerified:true,responseCollection:selected.field,count:witness.count,queryIds:witness.queries,requestId:request.id});
          if(collection)for(const id of witness.queries){const query=queryNodes.get(id);if(query){edge(query,collection,'produces response collection');for(const table of context.queries.get(id)?.tables||[])tables.add(table);}}
        }
       } else if (flow.mode === 'data' || selected.field) {
        gap(queryNodes.size ? [...queryNodes.values()].at(-1) : backend, 'Response field → database column lineage is not proven. An executed query is not sufficient evidence.');
       }
      }
      const loadedModels=new Map();
      for(const query of dependency.queries)for(const model of query.models||[]){
        const key=modelKey(model);if(fieldModels.get(query.id)?.has(key))continue;
        let definition=loadedModels.get(key);
        if(!definition){
          definition=sourceNode(model.modelSource,'model',model.model,model.evidence==='query-reference'?'The executed ORM statement referenced this actual mapped class. Its verified definition is shown without claiming that an instance was loaded or that a selected response field came from a particular column.':'The runtime SQLAlchemy mapper loaded this model class during the connected query. This block shows its verified class definition. It does not establish which response field or database column produced the selected value.',{sourceRole:'model-definition',definitionOnly:true,modelEvidence:model.evidence==='query-reference'?'query-reference':'query-loaded',model:model.model,modelSource:model.modelSource,requestId:request.id,queryIds:[],...(model.table?{table:model.table}:{})});
          if(definition)loadedModels.set(key,definition);
        }
        const queryNode=queryNodes.get(query.id);
        if(definition&&queryNode){if(!definition.meta.queryIds.includes(query.id))definition.meta.queryIds.push(query.id);if(model.evidence!=='query-reference'&&definition.meta.modelEvidence==='query-reference'){definition.meta.modelEvidence='query-loaded';definition.detail='The runtime SQLAlchemy mapper loaded this model class during a captured query. Its current source definition is verified independently of response-field lineage.';}edge(queryNode,definition,model.evidence==='query-reference'?'uses model':'loads model');}
      }
      if (!dependency.queries.length && !context.dependencies.some(item=>item.fieldOrigin)) gap(backend, 'No database execution evidence was supplied for this request.');
    }
    if (!flow.dependencies.length && ['data', 'action'].includes(flow.mode)) for (const message of [...graph.gaps]) gap(binding, message);
  }
  graph.summary.tables = tables.size;
  if(browserTimings.size||backendTimings.size||queryTimings.size){
    const timing={};
    for(const [rows,countKey,totalKey] of [[browserTimings,'browserRequestCount','browserDurationMs'],[backendTimings,'backendRequestCount','backendDurationMs'],[queryTimings,'queryMeasuredCount','queryDurationMs']])if(rows.size){timing[countKey]=rows.size;timing[totalKey]=[...rows.values()].reduce((sum,value)=>sum+value,0);}
    graph.summary.timing=timing;
  }
  graph.files = [...files];
  if(flow.valueOrigin==='local')graph.contextCoverage=graph.gaps.length?'partial':'complete';
  else if(!graph.gaps.length&&flow.dependencies.some(row=>row.collectionOrigin))graph.valueOrigin='collection';
  graph.coverage = !flow.captured ? 'unavailable' : ['local','static'].includes(flow.mode)||flow.valueOrigin==='local' ? 'frontend' : graph.gaps.length ? 'partial' : 'complete';
  return graph;
}

function getPageReaderScript(selector) {
  if (typeof selector !== 'string' || !selector || selector.length > 512) throw Error('A valid element selector is required.');
  return `(() => {
    const selector = ${JSON.stringify(selector)},selectedElement=document.querySelector(selector),read=()=>(${readElementFlow.toString()})(selector);
    let selectedMap,selectedBinding;try{selectedMap=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value;selectedBinding=WeakMap.prototype.get.call(selectedMap,selectedElement);}catch{selectedMap=null;}
    const snapshot=()=>{let sameSelection=document.querySelector(selector)===selectedElement;try{if(selectedMap)sameSelection=sameSelection&&Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value===selectedMap&&WeakMap.prototype.get.call(selectedMap,selectedElement)===selectedBinding;}catch{sameSelection=false;}const trace=sameSelection?read():null,hierarchy=sameSelection?(${readComponentHierarchy.toString()})(selector):{frames:[],note:'Selected element changed during capture.'};let runtimeAvailable=false;try{const map=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value;WeakMap.prototype.has.call(map,{});runtimeAvailable=true;}catch{}return {trace,frames:hierarchy.frames,runtimeAvailable,hierarchyNote:hierarchy.note,...(!sameSelection?{selectionChanged:true}:{})};};
    try{
      const trace=read(),pending=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowPendingV1')?.value,waits=[];
      for(const dependency of (trace?.dependencies||[]).slice(0,12)){
        const requestId=dependency?.request?.id;if(typeof requestId!=='string')continue;
        const promise=Map.prototype.get.call(pending,requestId);if(!promise)continue;
        // Observe genuine promises only. Tracing never invokes a page object's
        // arbitrary then getter, and metadata waiting cannot delay app requests.
        try{waits.push(new Promise(resolve=>{try{Promise.prototype.then.call(promise,()=>resolve(),()=>resolve());}catch{resolve();}}));}catch{}
      }
      if(waits.length)return new Promise(resolve=>{let finished=false;const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve(snapshot());},timer=setTimeout(done,2500);Promise.all(waits).then(done,done);});
    }catch{}
    return snapshot();
  })()`;
}

function pagePicker(enabled) {
  const key = '__traceAtlasPickerCleanupV1';
  try {const previous = Object.getOwnPropertyDescriptor(globalThis, key)?.value; if (typeof previous === 'function') previous(false);} catch {}
  if (!enabled) return {active:false};
  const overlay = document.createElement('div');
  overlay.setAttribute('data-trace-atlas-picker', '');
  Object.assign(overlay.style, {position:'fixed',zIndex:'2147483647',pointerEvents:'none',border:'2px solid #58a6ff',borderRadius:'5px',background:'rgba(56,139,253,.12)',boxShadow:'0 0 0 99999px rgba(5,12,24,.15)',display:'none',transition:'left 70ms ease,top 70ms ease,width 70ms ease,height 70ms ease'});
  const badge = document.createElement('div');
  badge.textContent = 'ORIVO · click an element · Esc to cancel';
  Object.assign(badge.style, {position:'fixed',top:'12px',left:'50%',transform:'translateX(-50%)',font:'600 12px system-ui,sans-serif',letterSpacing:'.04em',padding:'10px 15px',borderRadius:'9px',color:'#e6edf3',background:'#161b22',border:'1px solid #58a6ff',zIndex:'2147483647',pointerEvents:'none',whiteSpace:'nowrap'});
  document.documentElement.append(overlay,badge);
  function selectorFor(element) {
    if (!(element instanceof Element)) return null;
    if (element.id) {const id='#'+CSS.escape(element.id); if (document.querySelectorAll(id).length===1) return id;}
    const parts=[]; let node=element;
    while(node && node.nodeType===1 && parts.length<9) {
      let part=node.localName;
      if(node.id) {part+='#'+CSS.escape(node.id); parts.unshift(part); break;}
      const parent=node.parentElement;
      if(parent) {const siblings=[...parent.children].filter(sibling=>sibling.localName===node.localName); if(siblings.length>1) part+=`:nth-of-type(${siblings.indexOf(node)+1})`;}
      parts.unshift(part); const candidate=parts.join(' > ');
      if(candidate.length<=512 && document.querySelectorAll(candidate).length===1) return candidate;
      node=parent;
    }
    const result=parts.join(' > '); return result.length<=512 && document.querySelectorAll(result).length===1 ? result : null;
  }
  function move(event) {
    if(!event.isTrusted) return;
    const element=event.target;if(!(element instanceof Element)||element===overlay||element===badge)return;
    const box=element.getBoundingClientRect();
    Object.assign(overlay.style,{display:'block',left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px'});
  }
  function cleanup(cancelled) {document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',keydown,true);overlay.remove();badge.remove();try{delete globalThis[key];}catch{}if(cancelled)console.info('__TRACE_ATLAS_PICK__'+JSON.stringify({cancelled:true}));}
  function click(event) {
    if(!event.isTrusted||event.button!==0)return;
    const element=event.target;if(!(element instanceof Element))return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    const selector=selectorFor(element);if(!selector)return;
    const label=(element.getAttribute('aria-label')||element.innerText||element.textContent||element.localName).replace(/\s+/g,' ').trim().slice(0,100);
    cleanup(false);console.info('__TRACE_ATLAS_PICK__'+JSON.stringify({selector,label,tag:element.localName}));
  }
  function keydown(event) {if(event.isTrusted&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cleanup(true);}}
  Object.defineProperty(globalThis,key,{value:cleanup,configurable:true});
  document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',keydown,true);
  return {active:true};
}

function getPickerScript(enabled = true) { return `(${pagePicker.toString()})(${Boolean(enabled)})`; }

async function describeSetup(root) {
  const result = await require('../adapters/tracing/setup.cjs').describeProject(root);
  const existingTracing=[];
  for(const frontend of result.frontends){
    for(const name of ['vite.config.ts','vite.config.mts','vite.config.js','vite.config.mjs','next.config.ts','next.config.js','next.config.mjs']){
      const relative=path.posix.join(frontend.directory==='.'?'':frontend.directory,name);
      let handle;
      try{
        const filename=await fsp.realpath(path.join(result.root,relative));
        if(!within(result.root,filename)||(await fsp.lstat(path.join(result.root,relative))).isSymbolicLink())continue;
        handle=await fsp.open(filename,'r');
        const buffer=Buffer.alloc(65537),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if(bytesRead>65536)continue;
        const config=buffer.subarray(0,bytesRead).toString('utf8');
        if(!/studioTracing|withStudioTracing|@orivo\/tracing|studio-tracing/.test(config))continue;
        const flag=/\bVITE_STUDIO_TRACE\b/.test(config)?'VITE_STUDIO_TRACE':/\bSTUDIO_TRACE\b|@orivo\/tracing/.test(config)?'STUDIO_TRACE':null;
        existingTracing.push({directory:frontend.directory,configFile:relative,flag,value:flag?'1':null});
        break;
      }catch{}finally{await handle?.close();}
    }
  }
  return {...result, existingTracing, app:'Orivo', kit:path.resolve(__dirname,'../adapters/tracing'), package:'@orivo/tracing', readOnly:true, instructions:[
    'Install the local adapters/tracing package as a development dependency in your application. Read its README for complete integration examples.',
    'React/Vite 5–8: add studioTracing({repositoryRoot: YOUR_CONNECTED_ROOT}) from @orivo/tracing/vite to the existing configuration. Enable STUDIO_TRACE=1 and restart the dev server.',
    'Next.js 16: wrap the existing config with withStudioTracing from @orivo/tracing/next, set repositoryRoot, enable STUDIO_TRACE=1 and run next dev --webpack. Server components, server actions and Turbopack are unsupported.',
    'Other browser stacks: explicitly bind DOM elements with source path, original SHA-256 hash and response dependencies using @orivo/tracing/browser.',
    'Node.js: use @orivo/tracing/node-http middleware or handler with development:true, and its read(...).field(...) helper for SQLite result fields. It propagates each request ID and emits backend evidence without inspecting response bodies.',
    'Python: call studio_tracing.setup(app, root, development=True, engine=engine, sessions=Session, response_models=True) for direct ORM response fields. To follow direct DTO assignments such as Response(body=record.body), install studio_tracing.instrument_project(root, include=["backend/src"]) before importing the app. Backend-only setup generates this entry point for existing frontend integrations and application factories.',
    'Direct aliases, lists and DTO envelopes can retain column origins. Computations, custom validators/serializers, positional DTO arguments and **kwargs projections require explicit supported mappings. PostgreSQL SQL execution and the response mapping source are verified separately.',
    'Database origins require captured execution and direct field mappings. Node SQLite and Python SQLAlchemy/psycopg adapters are included; other drivers need their own execution adapters.',
    'Use the same repository root for frontend, backend and Orivo. Proxy API requests through the frontend origin.',
    'Restart the traced servers, refresh the repository, reload the app and pick an element. The map shows verified connections; coverage details explain any capture boundaries. Inspection and preview do not modify your project. Apply reviewed setup is a separate action.'
  ]};
}

module.exports = {indexRepository,resolveTrace,readSource,getPageReaderScript,getPickerScript,describeSetup,LIMITS,INDEX_PROFILES};
