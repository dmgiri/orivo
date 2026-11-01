// Read-only React runtime metadata. No props/state, DevTools hook or application calls.
function readComponentHierarchy(selector){
 const empty={frames:[],note:'Runtime component/source metadata unavailable for this element.'};
 try{
  const el=document.querySelector(selector);if(!el)return empty;
  const key=Object.getOwnPropertyNames(el).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
  const start=key&&Object.getOwnPropertyDescriptor(el,key)?.value;if(!start)return empty;
  const name=f=>{const t=f?.type;return typeof t==='string'?t:typeof t==='function'?(t.displayName||t.name||'Anonymous'):t?.displayName||t?.render?.displayName||t?.render?.name||t?.type?.name||'Anonymous';};
  const source=(f,expected)=>{
   const value=f?._debugSource;if(typeof value?.fileName==='string'&&Number.isInteger(value.lineNumber))return {url:value.fileName.slice(0,1024),line:value.lineNumber,column:Number.isInteger(value.columnNumber)?value.columnNumber:1};
   const stack=f?._debugStack?.stack;if(typeof stack!=='string')return null;
   for(const line of stack.slice(0,12000).split('\n').slice(0,16)){
    const m=line.match(/(https?:\/\/[^\s)]+|file:\/\/\/[^\s)]+):(\d+):(\d+)\)?$/);if(!m||/\/node_modules\/|\/@vite\/|\/@react-refresh/.test(m[1])||/\b(?:jsxDEV|createElement|ReactElement|react_stack|jsxDEVImpl)\b/.test(line))continue;const frameName=line.match(/at\s+(?:new\s+)?([^ (]+)\s*\(/)?.[1]?.split('.').at(-1);if(expected&&expected!=='Anonymous'&&frameName!==expected)continue;
    return {url:m[1].slice(0,1024),line:Number(m[2]),column:Number(m[3])};
   }
   return null;
  };
  const nodes=[start],seen=new Set(nodes);let node=start;
  while(nodes.length<30){let parent=node._debugOwner;if(!parent||typeof parent.tag!=='number'){parent=node.return;while(parent&&typeof parent.type==='string')parent=parent.return;}
   if(!parent||seen.has(parent)||!parent.type)break;nodes.push(parent);seen.add(parent);node=parent;
  }
  const frames=nodes.map((fiber,i)=>({component:String(name(fiber)).slice(0,100),kind:i===0?'element':'component',source:i===0?source(fiber,nodes[1]?name(nodes[1]):''):source(nodes[i-1],name(fiber)),evidence:'React runtime ancestry; location is the JSX creation site reported by development metadata.'})).reverse();
  return {frames,note:frames.some(f=>f.source)?'Runtime React hierarchy. File locations are reported JSX creation sites; missing locations remain unavailable.':'Runtime React hierarchy found; source locations are unavailable in this build.'};
 }catch{return empty;}
}
function resolveHierarchy(index,root,frames,appUrl){
 const path=require('node:path');if(!Array.isArray(frames)||frames.length>30)throw Error('Invalid component hierarchy.');
 const origin=new URL(appUrl).origin;
 return {frames:frames.map(frame=>{
  if(!frame||typeof frame.component!=='string'||frame.component.length>100||!['element','component'].includes(frame.kind))throw Error('Invalid hierarchy frame.');
  const row={component:frame.component,kind:frame.kind,path:null,line:null,note:'Source location unavailable.'};const s=frame.source;
  if(!s)return row;if(typeof s.url!=='string'||s.url.length>1024||!Number.isInteger(s.line)||s.line<1||s.line>100000||!Number.isInteger(s.column)||s.column<1||s.column>100000)throw Error('Invalid hierarchy location.');
  let name;try{const u=new URL(s.url);if(u.origin!==origin||!['http:','https:'].includes(u.protocol)){row.note='Source URL is outside the current app origin.';return row;}name=decodeURIComponent(u.pathname);}catch{row.note='Unsupported source location.';return row;}
  let matches=[];
  if(name.startsWith('/@fs/')){const absolute=name.slice(5);const rel=path.relative(root,path.resolve(absolute)).replaceAll('\\','/');if(!rel.startsWith('../')&&!path.isAbsolute(rel))matches=index.files.filter(f=>f.path.toLowerCase()===rel.toLowerCase());}
  else {const relative=name.replace(/^\//,'');matches=index.files.filter(f=>f.path===relative||f.path.endsWith('/'+relative));}
  if(matches.length===1){row.path=matches[0].path;row.line=s.line;row.column=s.column;row.note='Runtime JSX site matched to one local file. Line is a runtime position; original-source line requires source-map verification.';}
  else row.note=matches.length?'Source path is ambiguous in this folder.':'Runtime source file is not in the active index (or is excluded).';
  return row;
 }),note:'Component ancestry from the selected DOM element. Locations come from app runtime metadata; unresolved files are never guessed. Transformed/bundled locations need source maps before original source lines can be verified.'};
}
module.exports={readComponentHierarchy,resolveHierarchy};
