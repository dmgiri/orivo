// This parser ships with the tracing kit. It does not depend on the reviewed
// app installing a compiler package or upgrading its Vite version.
import babel from './parser-bundle.cjs';

export function parseSync(filename,code,{lang}={}){
 const language=lang||(/\.tsx$/i.test(filename)?'tsx':/\.[cm]?ts$/i.test(filename)?'ts':'jsx');
 const typescript=language==='ts'||language==='tsx';
 const plugins=['estree','decorators-legacy'];
 if(language!=='ts')plugins.push('jsx');
 if(typescript)plugins.push(['typescript',{dts:/\.d\.[cm]?ts$/i.test(filename),disallowAmbiguousJSXLike:/\.[cm]ts$/i.test(filename)}]);
 try{
  const parsed=babel.parse(code,{sourceType:'module',sourceFilename:filename,plugins,createParenthesizedExpressions:true,createImportExpressions:true,errorRecovery:true,allowUndeclaredExports:true,attachComment:false});
  return {program:parsed.program,errors:parsed.errors||[]};
 }catch(error){return {program:null,errors:[error]};}
}
