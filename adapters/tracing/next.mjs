import path from 'node:path';
import {fileURLToPath} from 'node:url';

const loader=fileURLToPath(new URL('./next-loader.cjs',import.meta.url));
const runtime=fileURLToPath(new URL('./runtime.mjs',import.meta.url));
const inside=(root,file)=>{const relative=path.relative(root,file);return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

// Wrap the existing configuration rather than replacing its rewrites, plugins,
// or webpack hook. Next's server and production compilers stay unchanged.
export function withStudioTracing(configuration={},options={}){
 const enabled=options.enabled??process.env.STUDIO_TRACE==='1';
 if(!enabled)return configuration;
 function wrap(original){
  if(!original||typeof original!=='object'||Array.isArray(original))throw Error('Studio tracing expects a Next.js configuration object.');
  const previous=original.webpack;
  return {...original,webpack(config,context){
   const result=previous?previous.call(this,config,context):config;
   function extend(value){
    if(!context.dev||context.isServer)return value;
    const projectRoot=path.resolve(options.projectRoot||context.dir||process.cwd());
    const repositoryRoot=path.resolve(options.repositoryRoot||projectRoot);
    const compilerRoot=options.shadowRoot?path.resolve(options.shadowRoot):projectRoot;
    const roots=(options.include||['src','app','pages','components']).flatMap(name=>options.shadowRoot?[path.resolve(compilerRoot,name),path.resolve(projectRoot,name)]:[path.resolve(projectRoot,name)]);
    value.module??={};value.module.rules??=[];
    value.module.rules.push({test:/\.[cm]?[jt]sx?$/,enforce:'pre',
     include:file=>(inside(repositoryRoot,file)||options.shadowRoot&&inside(compilerRoot,file))&&!inside(path.dirname(loader),file)&&roots.some(root=>inside(root,file))&&!/(?:^|[\\/])(?:node_modules|\.next|\.studio-tracing|dist|archives?)(?:[\\/]|$)/i.test(file),
     use:[{loader,options:{repositoryRoot,runtimeImport:runtime.replaceAll('\\','/'),...(options.shadowRoot?{shadowRoot:compilerRoot,sourceRoot:projectRoot}:{}),refComponents:options.refComponents||[],excludeRequests:options.excludeRequests||['/auth','/api/auth','/api/v1/auth']}}]});
    return value;
   }
   return result&&typeof result.then==='function'?result.then(extend):extend(result);
  }};
 }
 if(configuration&&typeof configuration.then==='function')return configuration.then(wrap);
 if(typeof configuration==='function')return function(...args){
  const value=configuration.apply(this,args);
  return value&&typeof value.then==='function'?value.then(wrap):wrap(value);
 };
 return wrap(configuration);
}
export default withStudioTracing;
