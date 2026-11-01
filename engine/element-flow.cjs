// Captured element flow only. Static graphs and manual mappings never populate this view.
function readElementFlow(selector){
 try{
  const element=document.querySelector(selector);if(!element)return null;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1');
  const map=descriptor?.value;if(!map)return null;
  const value=WeakMap.prototype.get.call(map,element);if(!value)return null;
  let budget=100000,characters=0;
  function copy(value,depth=0){
   if(--budget<0||depth>18||(characters+=2)>2097152)throw Error('Oversized trace');
   if(value===null||typeof value==='boolean'||typeof value==='number')return value;
   if(typeof value==='string'){if(value.length>6000||(characters+=value.length)>2097152)throw Error('Oversized text');return value;}
   if(typeof value!=='object')throw Error('Unsupported trace');
   if(Array.isArray(value)){if(value.length>512)throw Error('Oversized list');return value.map((_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))throw Error('Accessor');return copy(d.value,depth+1);});}
   const out={};for(const key of Object.keys(value)){if(['__proto__','constructor','prototype'].includes(key)||(characters+=key.length+4)>2097152)throw Error('Unsafe or oversized key');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d))throw Error('Accessor');out[key]=copy(d.value,depth+1);}return out;
  }
  const result=copy(value);return JSON.stringify(result).length<=2097152?result:null;
 }catch{return null;}
}
function readElementFlowSnapshot(selector,reader){
 let runtimeAvailable=false;try{const map=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value;WeakMap.prototype.has.call(map,{});runtimeAvailable=true;}catch{}
 return {trace:reader(selector),runtimeAvailable};
}
function buildElementFlow(index,root,frames,url,trace,target,tracingActive=false){
 const {resolveHierarchy}=require('./component-hierarchy.cjs');
 const {redact}=require('./source-context.cjs');
 const hierarchy=resolveHierarchy(index,root,frames||[],url);
 const output={hierarchy,source:null,mode:null,dependencies:[],localValues:[],gaps:[],captured:false,reason:null,locatedSource:null};
 const located=[...hierarchy.frames].reverse().find(frame=>frame.path);if(located)output.locatedSource={path:located.path,line:located.line,name:located.component};
 const gap=text=>{if(!output.gaps.includes(text))output.gaps.push(text);};
 const text=(value,max=200)=>typeof value==='string'&&value.length<=max?value:null;
 const timing=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=86400000?value:undefined;
 function site(value){if(!value||!text(value.path,512)||!Number.isInteger(value.line)||value.line<1||!text(value.hash,64)||!/^[a-f0-9]{64}$/.test(value.hash))return null;const file=index.files.find(f=>f.path===value.path&&f.hash===value.hash);if(!file||value.line>file.text.split('\n').length)return null;return {path:file.path,line:value.line,name:text(value.name)||'',hash:value.hash};}
 const identifier=value=>text(value,120)&&/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/.test(value);
 if(!trace){output.reason=tracingActive?'unsupported_element':'not_running';gap(tracingActive?'Tracing is running, but this element has no captured binding.':'Start this app with tracing, reload it, then inspect the element again.');return output;}
 try{
  if(trace.version!==1||trace.url!==url||!['data','action','static','local'].includes(trace.mode))throw Error('Trace does not belong to this page.');
  if(!Array.isArray(trace.dependencies)||trace.dependencies.length>12)throw Error('Invalid dependencies.');
  const source=site(trace.source);if(!source)throw Error('Captured source differs from the connected files. Refresh source and reload the app.');
  if(!text(trace.source.expression,1200)||!text(trace.source.kind,40))throw Error('Invalid captured binding.');
  output.source={...source,expression:redact(trace.source.expression),kind:trace.source.kind};output.mode=trace.mode;output.captured=true;
  let localSourcesVerified=true;
  if(trace.localValues!==undefined){
   if(!Array.isArray(trace.localValues)||trace.localValues.length>12)throw Error('Invalid local value evidence.');
   for(const value of trace.localValues){
    const local=site(value?.source);
    if(!local||value.source.kind!=='literal-fallback'||!['value','control'].includes(value.role)){localSourcesVerified=false;gap('Local fallback source changed or its capture could not be verified.');continue;}
    output.localValues.push({source:local,role:value.role});
   }
  }
  for(const dependency of trace.dependencies){
   if(dependency?.truncated===true)gap('This element has more dependencies than the capture limit; its displayed flow is incomplete.');
   const request=dependency?.request,backend=dependency?.backend;
   if(!request||!text(request.id,80)||!/^[a-zA-Z0-9_-]{8,80}$/.test(request.id)||!['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(request.method)||!Number.isInteger(request.status)||request.status<100||request.status>599)throw Error('Invalid captured request.');
   const address=new URL(request.url);if(address.origin!==new URL(url).origin||address.username||address.password)throw Error('Request is outside the reviewed origin.');
   const row={field:text(dependency.field,200)||null,request:{id:request.id,method:request.method,url:address.origin+address.pathname,status:request.status,...(timing(request.durationMs)!==undefined?{durationMs:request.durationMs}:{})},backend:null,queries:[],fieldOrigin:null};
   row.role=dependency.role==='control'?'control':'value';
   if(dependency.collection===true){
    row.collection=true;
    row.operations=Array.isArray(dependency.operations)&&dependency.operations.length<=8&&dependency.operations.every(value=>['map','filter','slice','append','length'].includes(value))?[...dependency.operations]:[];
    if(dependency.collectionUnknown===true){row.collectionUnknown=true;gap('Some frontend collection filtering depends on untraced control values. Its complete calculation is not proven.');}
   }
   if(backend?.id===request.id){
    const route=site(backend.route);if(route)row.backend={id:backend.id,route,...(timing(backend.durationMs)!==undefined?{durationMs:backend.durationMs}:{})};else gap('Backend source version unavailable or different from connected code.');
    if(backend.truncated)gap('Backend trace exceeded its limit; the captured flow is incomplete.');
    const ids=new Set();
    for(const query of Array.isArray(backend.queries)?backend.queries.slice(0,256):[]){
     if(!text(query.id,80)||ids.has(query.id)||!text(query.sql,6000))continue;ids.add(query.id);
     const sql=query.sql.replace(/'(?:''|[^'])*'/g,"'?'").replace(/\b\d+(?:\.\d+)?\b/g,'?');
     const querySite=site(query.site),queryFrames=Array.isArray(query.frames)?query.frames.map(site).filter(Boolean).slice(-12):[],sourceVerified=query.site?Boolean(querySite):queryFrames.length>0;
     // A mapper class loaded by a query is useful source evidence even when a
     // serializer has no proven response-field lineage. It must never imply a
     // returned column or fill that separate coverage boundary.
     const models=[],modelKeys=new Set();
     if(row.backend&&sourceVerified&&query.failed!==true)for(const value of Array.isArray(query.models)?query.models.slice(0,12):[]){
      const modelSource=site(value?.modelSource);if(!modelSource||!identifier(value?.model))continue;
      const key=JSON.stringify([value.model,modelSource.path,modelSource.line,modelSource.hash]);if(modelKeys.has(key))continue;modelKeys.add(key);
      if(value.evidence!==undefined&&value.evidence!=='query-reference')continue;
      models.push({model:value.model,modelSource,...(value.evidence==='query-reference'?{evidence:'query-reference'}:{}),...(identifier(value.table)?{table:value.table}:{})});
     }
     row.queries.push({id:query.id,sql:redact(sql),tables:Array.isArray(query.tables)?query.tables.filter(t=>typeof t==='string'&&/^[A-Za-z_][\w.]{0,120}$/.test(t)).slice(0,20):[],site:querySite,frames:queryFrames,sourceVerified,failed:query.failed===true,...(models.length?{models}:{}),...(timing(query.durationMs)!==undefined?{durationMs:query.durationMs}:{}),...(timing(query.startOffsetMs)!==undefined?{startOffsetMs:query.startOffsetMs}:{})});
    }
    const origin=!row.collection&&row.field&&backend.fields?.[row.field];
    // An execution list is not field lineage. Require the adapter's explicit
    // field mapping plus current route/query source evidence before showing an
    // originating column. A stale backend file must never keep an old claim.
    // ORM declarations supplement an already-proven result origin. They are
    // definition evidence, never call frames or a prerequisite for old captures.
    function modelDefinition(value){
     if(!value.model)return {};
     const attribute=text(value.attribute,120),modelSource=site(value.modelSource),fieldSource=site(value.fieldSource);
     const valid=identifier(value.model)&&attribute&&/^[A-Za-z_]\w*$/.test(attribute)&&modelSource;
     return {modelDefinitionStatus:valid?'verified':value.modelSource?'unavailable':'not-captured',...(valid?{attribute,modelSource,...(fieldSource?{fieldSource}:{}),...(typeof value.type==='string'&&/^[A-Za-z_]\w{0,119}$/.test(value.type)?{type:value.type}:{}),...(typeof value.nullable==='boolean'?{nullable:value.nullable}:{})}:{})};
    }
    const projection=origin?.projection?site(origin.projection):null;
    if(origin?.projection&&!projection)gap('The Python response mapping source changed or is unavailable. Restart the traced backend and refresh source.');
    const validQueries=values=>Array.isArray(values)&&values.length>0&&values.length<=256&&values.every(id=>ids.has(id)&&row.queries.some(query=>query.id===id&&!query.failed&&query.sourceVerified));
    if(row.collection){
     const collection=backend.collections?.[row.field||''],source=site(collection?.source);
     if(row.backend&&row.operations.at(-1)==='length'&&source&&Number.isSafeInteger(collection.count)&&collection.count>=0&&collection.count<=1000000&&validQueries(collection.queries))row.collectionOrigin={source,queries:[...new Set(collection.queries)],count:collection.count};
     else if(collection?.source&&!source)gap('Collection mapping source changed or is unavailable. Recapture this request with current source.');
    }
    const transformation=origin?.transformation;
    if(row.backend&&origin&&origin.kind!=='computed'&&(!origin.projection||projection)&&(transformation===undefined||['isoformat','enum-value'].includes(transformation)&&projection)&&identifier(origin.table)&&identifier(origin.column)&&(origin.model===null||text(origin.model,120))&&validQueries(origin.queries))row.fieldOrigin={table:origin.table,column:origin.column,model:origin.model,queries:origin.queries,...(projection?{projection}:{}),...(transformation?{transformation}:{}),...modelDefinition(origin)};
    if(row.backend&&origin?.kind==='computed'&&origin.immutable===true&&projection&&validQueries(origin.queries)){
     // Accept only the adapter's bounded numeric operation tree. Derive all
     // columns and expression text from verified leaves; SQL text and equal
     // scalar values never establish a computed response field's inputs.
     const inputs=[],operations={add:'+',subtract:'-',multiply:'*',divide:'/'};let budget=23;
     function operation(value,depth=0){
      if(!value||--budget<0||depth>4)throw Error('Unsupported operation');
      if(value.kind==='constant')return {tree:{kind:'constant'},expression:'constant'};
      if(value.kind==='column'&&identifier(value.table)&&identifier(value.column)&&(value.model===null||text(value.model,120))&&validQueries(value.queries)&&value.queries.every(id=>origin.queries.includes(id))){
       const input={table:value.table,column:value.column,model:value.model,queries:[...new Set(value.queries)],...modelDefinition(value)};
       if(!inputs.some(item=>JSON.stringify(item)===JSON.stringify(input)))inputs.push(input);
       if(inputs.length>8)throw Error('Too many inputs');
       return {tree:{kind:'column',...input},expression:value.table+'.'+value.column};
      }
      if(!Object.hasOwn(operations,value.op))throw Error('Unsupported operation');
      const left=operation(value.left,depth+1),right=operation(value.right,depth+1);
      return {tree:{op:value.op,left:left.tree,right:right.tree},expression:'('+left.expression+' '+operations[value.op]+' '+right.expression+')'};
     }
     try{
      if(!Object.hasOwn(operations,origin.operation?.op))throw Error('No calculation');
      const result=operation(origin.operation);
      if(inputs.length&&origin.queries.every(id=>inputs.some(input=>input.queries.includes(id))))row.fieldOrigin={kind:'computed',immutable:true,inputs,queries:[...new Set(origin.queries)],projection,operation:result.tree,expression:result.expression};
     }catch{/* An unsupported computation leaves an explicit coverage boundary. */}
    }
    if(row.collection&&!row.collectionOrigin)gap('The frontend collection and request are captured. Query-to-collection membership and database cardinality are not proven.');
    else if(!row.collection&&row.field&&!row.fieldOrigin)gap('Response field to model/column lineage is not captured. Executed request queries do not prove that field lineage.');
   }else gap(dependency.pending===true?'Trace metadata is still arriving for this request. Select the element again when capture finishes.':'Backend execution trace unavailable for this request.');
   output.dependencies.push(row);
  }
  if(trace.valueOrigin==='local'&&localSourcesVerified&&output.localValues.some(value=>value.role==='value')&&output.dependencies.every(value=>value.role==='control'))output.valueOrigin='local';
  if(trace.mode==='data'&&!output.dependencies.length&&!output.valueOrigin)gap('Data origin unavailable; the adapter has not supplied a response dependency.');
  if(trace.mode==='action'&&!output.dependencies.length)gap('No action request captured yet. Use the element normally, then inspect it again.');
  if(['static','local'].includes(trace.mode)&&output.dependencies.length)throw Error('Inconsistent frontend-only trace.');
 }catch(e){output.source=null;output.mode=null;output.dependencies=[];output.localValues=[];delete output.valueOrigin;output.captured=false;output.reason=e.message.includes('source differs')?'source_changed':'invalid_trace';gap(e.message);}
 return output;
}
module.exports={readElementFlow,readElementFlowSnapshot,buildElementFlow};
