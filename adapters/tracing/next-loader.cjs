// Webpack runs this before Next/SWC, retaining the original JSX and source hash.
// It is registered only in the development client compiler by next.mjs.
module.exports=function studioNextLoader(source,map){
 const callback=this.async(),options=this.getOptions();this.cacheable?.();
 import('./vite.mjs').then(({transformStudio})=>{
  const code=Buffer.isBuffer(source)?source.toString('utf8'):source;
  const path=require('node:path'),relative=options.shadowRoot?path.relative(options.shadowRoot,this.resourcePath):null;
  const shadowed=relative!==null&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
  const file=shadowed&&options.sourceRoot?path.resolve(options.sourceRoot,relative):this.resourcePath;
  const output=transformStudio(code,file,options.repositoryRoot,undefined,options);
  if(!output)return callback(null,source,map);
  const declaration='import * as __studioFlow from '+JSON.stringify(options.runtimeImport)+';';
  callback(null,output.replace(declaration,declaration+'\n__studioFlow.installFetch('+JSON.stringify({exclude:options.excludeRequests})+');'));
 }).catch(error=>{
  this.emitWarning?.(new Error('[Studio tracing] Skipped '+this.resourcePath+': '+error.message));
  callback(null,source,map);
 });
};
