import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseSync as parsePortable} from './parser.mjs';

const moduleId='virtual:studio-tracing',resolvedId='\0'+moduleId,codecId='virtual:studio-trace-codec',resolvedCodecId='\0'+codecId,managedId='virtual:studio-managed-trace',resolvedManagedId='\0'+managedId;
const inside=(root,file)=>{const relative=path.relative(root,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

// Resolve bindings before rewriting. A spelling alone cannot distinguish a
// shadowed local, a property key, a parameter or an unrelated equal value.
function lexicalBindings(program,code,unsafe){
 const scopes=new WeakMap(),parents=new WeakMap(),declarations=new WeakSet(),bindings=[],functions=new WeakMap(),variables=new WeakMap(),names=new Set();let serial=0;
 const children=node=>Object.entries(node).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).filter(child=>child&&typeof child.type==='string').map(child=>({child,key})));
 const scope=parent=>({parent,bindings:new Map(),functionScope:false});const root=scope(null);root.functionScope=true;
 function declare(pattern,current,kind){
  if(!pattern)return;if(pattern.type==='Identifier'){declarations.add(pattern);names.add(pattern.name);let binding=current.bindings.get(pattern.name);if(!binding){binding={name:pattern.name,kind,scope:current,written:false};current.bindings.set(pattern.name,binding);bindings.push(binding);}return binding;}
  if(pattern.type==='Property')return declare(pattern.value,current,kind);if(pattern.type==='AssignmentPattern')return declare(pattern.left,current,kind);if(pattern.type==='RestElement')return declare(pattern.argument,current,kind);
  for(const child of pattern.properties||pattern.elements||[])declare(child,current,kind);
 }
 function walk(node,current,parent,key){
  if(!node||typeof node.type!=='string')return;
  parents.set(node,parent);
  if(node.type==='Identifier')names.add(node.name);
  if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)){
   if(node.type==='FunctionDeclaration')declare(node.id,current,'function');const inner=scope(current);inner.functionScope=true;scopes.set(node,inner);if(node.type==='FunctionExpression')declare(node.id,inner,'function');for(const param of node.params)declare(param,inner,'param');for(const {child,key} of children(node))if(key!=='id')walk(child,inner,node,key);return;
  }
  if(node.type==='BlockStatement'||node.type==='CatchClause'||['ForStatement','ForInStatement','ForOfStatement','SwitchStatement'].includes(node.type)){current=scope(current);current.type=node.type;if(node.type==='CatchClause')declare(node.param,current,'catch');}
  scopes.set(node,current);
  if(node.type==='VariableDeclaration')for(const declaration of node.declarations){let target=current;if(node.kind==='var')while(!target.functionScope&&target.parent)target=target.parent;declare(declaration.id,target,node.kind);}
  if(node.type==='ClassDeclaration')declare(node.id,current,'class');
  if(node.type==='ImportDeclaration')for(const specifier of node.specifiers)declare(specifier.local,current,'import');
  for(const {child,key} of children(node))walk(child,current,node,key);
 }
 walk(program,root,null,'');
 const lookup=(node,name)=>{for(let current=scopes.get(node);current;current=current.parent)if(current.bindings.has(name))return current.bindings.get(name);return null;};
 function writes(pattern){if(!pattern)return;if(pattern.type==='Identifier'){const binding=lookup(pattern,pattern.name);if(binding)binding.written=true;return;}if(pattern.type==='MemberExpression')return;for(const {child} of children(pattern))writes(child);}
 function scan(node){if(!node||typeof node.type!=='string')return;if(node.type==='AssignmentExpression'||node.type==='ForInStatement'||node.type==='ForOfStatement')writes(node.left);if(node.type==='UpdateExpression')writes(node.argument);if(node.type==='VariableDeclarator'&&node.init&&node.id.type==='Identifier'&&lookup(node.id,node.id.name)?.kind==='param')writes(node.id);for(const {child} of children(node))scan(child);}
 scan(program);
 const fresh=kind=>{let name;do{name='__studio'+kind+(++serial);}while(names.has(name));names.add(name);return name;};
 const simplePattern=pattern=>pattern?.type==='ObjectPattern'&&pattern.properties.every(property=>property.type==='RestElement'?property.argument.type==='Identifier':property.type==='Property'&&!property.computed&&!property.method&&['Identifier','Literal'].includes(property.key.type)&&(property.value.type==='Identifier'||property.value.type==='AssignmentPattern'&&property.value.left.type==='Identifier'&&!unsafe(property.value.right)));
 function patternPlan(pattern,source){
  const entries=[];for(const property of pattern.properties){const id=property.type==='RestElement'?property.argument:property.value.type==='AssignmentPattern'?property.value.left:property.value,binding=lookup(id,id.name);if(!binding||binding.written)continue;if(property.type==='RestElement'){entries.push({rest:true,name:id.name,source});continue;}binding.cell=fresh('Binding');entries.push({name:id.name,cell:binding.cell,source,key:property.key.name??property.key.value});}return entries;
 }
 function plan(node,parent,key){
  if(!node||typeof node.type!=='string')return;
  if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&parent?.kind==='const'){const binding=lookup(node.id,node.id.name);if(binding)binding.declaration=node;}
  if(node.type==='VariableDeclarator'&&parent?.kind==='const'&&node.init&&!unsafe(node.init)){
   if(node.id.type==='Identifier'&&!['FunctionExpression','ArrowFunctionExpression','ClassExpression'].includes(node.init.type)){const binding=lookup(node.id,node.id.name);if(binding&&!binding.written){binding.cell=fresh('Binding');variables.set(node,{cell:binding.cell});}}
   else if(simplePattern(node.id)){const source=fresh('Object');variables.set(node,{source,entries:patternPlan(node.id,source)});}
  }
  if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)&&!node.generator&&node.params.length&&node.params.slice(1).every(param=>param.type==='Identifier'||param.type==='RestElement'&&param.argument.type==='Identifier')){const param=node.params[0],pattern=param.type==='AssignmentPattern'?param.left:param;if(simplePattern(pattern)&&!unsafe(pattern)&&pattern.properties.every(property=>property.value?.type!=='AssignmentPattern'||property.value.right.type==='Literal')){const source=fresh('Props'),entries=patternPlan(pattern,source);functions.set(node,{source,pattern,param,entries});}else if(param.type==='Identifier'&&parent?.type==='CallExpression'&&key==='arguments'&&parent.arguments[0]===node&&parent.callee.type==='MemberExpression'&&!parent.callee.computed&&['map','filter','find'].includes(parent.callee.property.name)){const binding=lookup(param,param.name);if(binding&&!binding.written){binding.cell=fresh('Binding');functions.set(node,{callback:true,cell:binding.cell,param,token:fresh('Callback')});}}}
  for(const {child,key} of children(node))plan(child,node,key);
 }
 plan(program,null,'');
 return {lookup,declarations,functions,variables,fresh,scopeOf:node=>scopes.get(node),parentOf:node=>parents.get(node)};
}

// Preserve application semantics when a construct cannot be safely instrumented.
export function transformStudio(code,filename,root,parseSync=parsePortable,{refComponents=[],onGap=()=>{},runtimeImport=moduleId}={}) {
 const parsed=parseSync(filename,code,{lang:/\.tsx$/i.test(filename)?'tsx':/\.jsx$/i.test(filename)?'jsx':/\.[cm]?ts$/i.test(filename)?'ts':'js'});
 if(parsed.errors.length||code.includes('__studioFlow'))return null;
 const hash=createHash('sha256').update(code).digest('hex'),file=path.relative(root,filename).replaceAll('\\','/');
 if(!inside(root,filename))return null;
 const forwarded=new Set(refComponents);let changed=false;
 function unsafe(node){if(!node||typeof node!=='object')return false;if(['AwaitExpression','YieldExpression'].includes(node.type))return true;if(node.type==='CallExpression'&&(/^(?:use[A-Z]|eval$)/.test(node.callee?.name||'')))return true;return Object.values(node).some(v=>Array.isArray(v)?v.some(unsafe):unsafe(v));}
 function valueProof(node){if(!node)return false;if(node.type==='Literal')return true;if(node.type==='Identifier'){const binding=lexical.lookup(node,node.name);return !!binding?.cell&&!binding.written;}if(['ParenthesizedExpression','TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','TSTypeAssertion','ChainExpression'].includes(node.type))return valueProof(node.expression);if(node.type==='LogicalExpression'&&node.operator==='??'&&node.right.type==='Literal')return true;if(node.type==='UnaryExpression'&&node.operator==='!')return valueProof(node.argument);if(node.type==='BinaryExpression'&&['==','!=','===','!==','<','<=','>','>='].includes(node.operator))return valueProof(node.left)&&valueProof(node.right);if(node.type==='MemberExpression')return valueProof(node.object)&&(!node.computed||valueProof(node.property));return false;}
 const lexical=lexicalBindings(parsed.program,code,unsafe);
 function conditionalAppendPlan(node){if(node?.type!=='IfStatement'||node.alternate||unsafe(node.test))return null;const body=node.consequent.type==='BlockStatement'&&node.consequent.body.length===1?node.consequent.body[0]:node.consequent,call=body?.type==='ExpressionStatement'?body.expression:null,member=call?.callee;if(call?.type!=='CallExpression'||call.optional||unsafe(call)||member?.type!=='MemberExpression'||member.optional||member.computed||member.property.name!=='push'||member.object.type!=='Identifier')return null;const binding=lexical.lookup(member.object,member.object.name);return binding?.kind==='const'&&!binding.written&&binding.declaration?.init?.end<node.start&&binding.scope===lexical.scopeOf(node)&&binding.scope.type==='BlockStatement'?{call,receiver:member.object}:null;}
 function unknownAppendControl(node){for(let current=lexical.parentOf(node);current;current=lexical.parentOf(current)){if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(current.type))break;if(current.type==='IfStatement'&&!conditionalAppendPlan(current))return true;}return false;}
 const entries=rows=>rows.map(row=>row.rest?'__studioFlow.rest('+row.name+','+row.source+');':'var '+row.cell+'=__studioFlow.binding('+row.name+','+row.source+','+JSON.stringify(row.key)+');').join('');
 const jsxName=node=>node.type==='JSXIdentifier'?node.name:node.type==='JSXMemberExpression'?jsxName(node.object)+'.'+jsxName(node.property):'';
 const forwardedNamespaces=new Map();
 for(const statement of parsed.program.body)if(statement.type==='ImportDeclaration')for(const specifier of statement.specifiers){const imported=specifier.imported?.name;if(['motion/react','framer-motion'].includes(statement.source.value)&&['motion','m'].includes(imported))forwardedNamespaces.set(specifier.local.name,'motion');if(statement.source.value==='radix-ui'&&['Dialog','AlertDialog'].includes(imported))forwardedNamespaces.set(specifier.local.name,'dialog');}
 const forwardsRef=name=>forwarded.has(name)||/^[a-z]/.test(name)&&!name.includes('.')||(()=>{const [namespace,member]=name.split('.');return forwardedNamespaces.get(namespace)==='motion'&&/^[a-z]/.test(member||'')||forwardedNamespaces.get(namespace)==='dialog'&&['Title','Description','Content','Overlay','Close','Trigger','Action','Cancel'].includes(member);})();
 function rewrite(node,parent,key,reference=false){
  if(!node||typeof node.type!=='string')return '';
  const original=code.slice(node.start,node.end);
  if(node.type==='ImportDeclaration'&&node.source.value==='axios'){
   const clients=node.specifiers.filter(specifier=>specifier.type==='ImportDefaultSpecifier'||specifier.type==='ImportSpecifier'&&(specifier.imported?.name||specifier.imported?.value)==='default');
   if(clients.length){changed=true;return original+'\n'+clients.map(specifier=>'__studioFlow.attachAxios('+specifier.local.name+');').join('\n');}
  }
  if(node.type.startsWith('TS')&&!['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','TSTypeAssertion','TSInstantiationExpression'].includes(node.type))return original;
  // Assignment targets include nested destructuring and loop bindings. These
  // must remain references, never helper calls returning their current values.
  if(['AssignmentExpression','ForOfStatement','ForInStatement'].includes(parent?.type)&&key==='left'||parent?.type==='UpdateExpression'&&key==='argument')return original;
  if(!unsafe(node)&&(node.type==='AssignmentExpression'||node.type==='UpdateExpression')&&(node.left||node.argument)?.type==='MemberExpression'&&(node.left||node.argument).object.type==='Identifier'){
   const target=node.left||node.argument,body=node.type==='AssignmentExpression'?code.slice(node.start,node.right.start)+rewrite(node.right,node,'right'):original;changed=true;return '__studioFlow.mutation('+target.object.name+',()=>('+body+'))';
  }
  if(node.type==='UnaryExpression'&&node.operator==='delete'&&node.argument.type==='MemberExpression'&&node.argument.object.type==='Identifier'&&!unsafe(node)){changed=true;return '__studioFlow.mutation('+node.argument.object.name+',()=>('+original+'))';}
  const needsReference=reference||(['CallExpression','NewExpression'].includes(parent?.type)&&key==='callee')||(parent?.type==='TaggedTemplateExpression'&&key==='tag')||(parent?.type==='UnaryExpression'&&parent.operator==='delete');
  if(node.type==='Identifier'&&!needsReference&&!lexical.declarations.has(node)&&!(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)&&!(['Property','MethodDefinition','PropertyDefinition'].includes(parent?.type)&&key==='key'&&!parent.computed)&&!['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier','ExportSpecifier','LabeledStatement','BreakStatement','ContinueStatement','MetaProperty'].includes(parent?.type)){
   const binding=lexical.lookup(node,node.name);if(binding?.cell&&!binding.written){changed=true;return '__studioFlow.alias('+original+','+binding.cell+')';}
  }
  const transparent=['ParenthesizedExpression','TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','TSTypeAssertion'].includes(node.type);
  if(node.type==='ChainExpression'){
   // Property-only chains preserve short-circuiting, lazy keys and one read per
   // getter. Calls/reference contexts stay native so receiver/delete semantics
   // never change merely to capture provenance.
   if(unsafe(node)||needsReference||original.includes('import.meta'))return original;
   const steps=[];let base=node.expression;
   while(base?.type==='MemberExpression'){
    if(base.property.type==='PrivateIdentifier'||!base.computed&&base.property.type!=='Identifier')return original;
    steps.unshift({optional:base.optional===true,property:base.property,computed:base.computed});base=base.object;
   }
   const shortCircuit=value=>value?.optional===true||value?.type==='ChainExpression'||value?.type==='MemberExpression'&&shortCircuit(value.object)||value?.type==='CallExpression'&&shortCircuit(value.callee);
   if(!steps.length||base?.type==='Super'||base?.type==='CallExpression'&&shortCircuit(base)){
    function native(value){if(value.type!=='MemberExpression'&&value.type!=='CallExpression')return rewrite(value,node,'expression');let out='',at=value.start;for(const [field,part] of Object.entries(value))for(const child of Array.isArray(part)?part:[part])if(child?.type&&Number.isInteger(child.start)){if(child.start<at)continue;out+=code.slice(at,child.start)+((field==='callee'||field==='object'&&shortCircuit(child))?native(child):field==='property'&&!value.computed?code.slice(child.start,child.end):rewrite(child,value,field));at=child.end;}return out+code.slice(at,value.end);}
    return native(node.expression);
   }
   const renderedBase=rewrite(base,node.expression,'object');
   changed=true;
   return '__studioFlow.optionalChain(('+renderedBase+'),['+steps.map(step=>'['+step.optional+',()=>('+(step.computed?rewrite(step.property,node.expression,'property'):JSON.stringify(step.property.name))+')]').join(',')+'])';
  }
  if(node.type==='MemberExpression'&&original.startsWith('import.meta'))return original;
  if(node.type==='MemberExpression'&&!node.optional&&!needsReference&&(node.computed||node.property.type==='Identifier')&&!['AssignmentExpression','UpdateExpression','UnaryExpression'].includes(parent?.type)&&node.object.type!=='Super'&&!unsafe(node)){
   const steps=[];let base=node;
   while(base?.type==='MemberExpression'&&!base.optional&&(base.computed||base.property.type==='Identifier')&&base.object.type!=='Super'){
    steps.unshift(base);base=base.object;
   }
   // Capture one leaf for an ordinary property path as well. A containing
   // object is not an additional database field merely because we traversed it.
   changed=true;
   return '__studioFlow.optionalChain(('+rewrite(base,node,'object')+'),['+steps.map(step=>'[false,()=>('+(step.computed?rewrite(step.property,step,'property'):JSON.stringify(step.property.name))+')]').join(',')+'])';
  }
  const children=[];
  for(const [name,value] of Object.entries(node))for(const child of Array.isArray(value)?value:[value])if(child?.type&&Number.isInteger(child.start))children.push({child,key:name});
  const rendered=new Map(children.map(({child,key})=>[child,rewrite(child,node,key,transparent&&needsReference)]));
  const get=child=>rendered.get(child)??code.slice(child.start,child.end);
  const conditional=conditionalAppendPlan(node);if(conditional){changed=true;return '__studioFlow.conditionalAppend(()=>('+get(node.test)+'),()=>('+rewrite(conditional.call,node.consequent,'expression')+'),()=>('+conditional.receiver.name+'),'+valueProof(node.test)+');';}
  if(node.type==='LogicalExpression'&&node.operator==='??'&&node.right.type==='Literal'&&!unsafe(node)&&!node.right.regex){changed=true;const site={path:file,hash,line:code.slice(0,node.right.start).split('\n').length,expression:'Executed literal fallback',kind:'literal-fallback'};return '__studioFlow.nullish(()=>('+get(node.left)+'),()=>('+get(node.right)+'),'+JSON.stringify(site)+','+valueProof(node.left)+')';}
  if(node.type==='CallExpression'&&!node.optional&&!unsafe(node)&&node.callee.type==='Identifier'&&node.callee.name==='structuredClone'&&!lexical.lookup(node.callee,'structuredClone')){changed=true;return '__studioFlow.clone(structuredClone,()=>['+node.arguments.map(get).join(',')+'])';}
  if(node.type==='ArrayExpression'&&!unsafe(node)){changed=true;return '__studioFlow.array('+(()=>{let text='',at=node.start;for(const {child} of children.sort((a,b)=>a.child.start-b.child.start)){if(child.start<at)continue;text+=code.slice(at,child.start)+get(child);at=child.end;}return text+code.slice(at,node.end);})()+','+!node.elements.some(element=>element?.type==='SpreadElement')+')';}
  if(node.type==='CallExpression'&&!node.optional&&!unsafe(node)&&node.callee.type==='MemberExpression'&&!node.callee.optional&&!node.callee.computed&&['map','filter','slice','find','push'].includes(node.callee.property.name)&&node.callee.object.type!=='Super'){
   changed=true;const args=node.arguments.map(argument=>{const plan=lexical.functions.get(argument),value=plan?.callback?'__studioFlow.arrayCallback(('+get(argument)+'),'+JSON.stringify(plan.token)+','+valueProof(argument.body)+')':get(argument);return node.callee.property.name==='push'?argument.type==='SpreadElement'?'...__studioFlow.arraySpread(()=>('+rewrite(argument.argument,argument,'argument')+'))':'__studioFlow.arrayArgument(()=>('+value+'),'+valueProof(argument)+')':value;});return '__studioFlow.arrayCall(()=>('+rewrite(node.callee.object,node.callee,'object')+'),'+JSON.stringify(node.callee.property.name)+',()=>['+args.join(',')+']'+(node.callee.property.name==='push'?','+unknownAppendControl(node):'')+')';
  }
  const variable=lexical.variables.get(node);
  if(variable){changed=true;if(variable.cell)return variable.cell+'=__studioFlow.capture(()=>('+get(node.init)+'),'+valueProof(node.init)+'),' +get(node.id)+'='+variable.cell+'.value';const pattern=code.slice(node.id.start,node.id.typeAnnotation?.start??node.id.end);return variable.source+'=('+get(node.init)+'),'+pattern+'=__studioFlow.destructure('+variable.source+')'+variable.entries.map(row=>row.rest?','+lexical.fresh('Rest')+'=__studioFlow.rest('+row.name+','+row.source+')':','+row.cell+'=__studioFlow.binding('+row.name+','+row.source+','+JSON.stringify(row.key)+')').join('');}
  if(node.type==='ObjectExpression'&&!unsafe(node)&&node.properties.length&&node.properties.every(p=>p.type==='SpreadElement'||p.type==='Property'&&p.kind==='init'&&!p.method&&!p.computed&&['Identifier','Literal'].includes(p.key.type)&&(p.key.name??p.key.value)!=='__proto__')){
   changed=true;
   return '__studioFlow.merge(['+node.properties.map(p=>p.type==='SpreadElement'?'()=>('+get(p.argument)+')':'()=>__studioFlow.object([['+JSON.stringify(p.key.name??p.key.value)+',()=>('+rewrite(p.value,p,'value')+'),'+valueProof(p.value)+']])').join(',')+'])';
  }
  if(node.type==='MemberExpression'&&!node.optional&&!needsReference&&(node.computed||node.property.type==='Identifier')&&!['AssignmentExpression','UpdateExpression','UnaryExpression'].includes(parent?.type)&&node.object.type!=='Super'){
   changed=true;return '__studioFlow.read('+get(node.object)+','+(node.computed?'('+get(node.property)+')':JSON.stringify(node.property.name))+')';
  }
  let result='',offset=node.start;
  for(const {child} of children.sort((a,b)=>a.child.start-b.child.start)){if(child.start<offset)continue;result+=code.slice(offset,child.start)+get(child);offset=child.end;}
  result+=code.slice(offset,node.end);
  const fn=lexical.functions.get(node);
  if(fn){
   const annotation=fn.pattern?.typeAnnotation?code.slice(fn.pattern.typeAnnotation.start,fn.pattern.end):'',parameter=fn.callback?get(fn.param):fn.source+annotation+(fn.param.type==='AssignmentPattern'?'='+get(fn.param.right):''),pattern=fn.callback?'':code.slice(fn.pattern.start,fn.pattern.typeAnnotation?.start??fn.pattern.end),setup=fn.callback?'var '+fn.cell+'=__studioFlow.parameter('+fn.param.name+','+JSON.stringify(fn.token)+');':'var '+pattern+'=__studioFlow.destructure('+fn.source+');'+entries(fn.entries),body=get(node.body);
   let replacement;if(node.body.type==='BlockStatement'){let at=1;for(const statement of node.body.body){if(statement.type!=='ExpressionStatement'||typeof statement.expression?.value!=='string')break;at=statement.end-node.body.start;}replacement=body.slice(0,at)+setup+body.slice(at);}else replacement='{'+setup+'return ('+body+');}';
   // Replace by original child offsets so expression-body arrows keep their
   // lexical this/arguments and hooks remain in their original call order.
   result='';offset=node.start;for(const {child} of children.sort((a,b)=>a.child.start-b.child.start)){if(child.start<offset)continue;result+=code.slice(offset,child.start)+(child===fn.param?parameter:child===node.body?replacement:get(child));offset=child.end;}result+=code.slice(offset,node.end);changed=true;
  }
  if(node.type==='JSXElement'){
   const name=jsxName(node.openingElement.name),attributes=node.openingElement.attributes,host=forwardsRef(name);
   if(unsafe(node)){onGap({path:file,line:code.slice(0,node.start).split('\n').length,reason:'Async/hook expression inside JSX'});return result;}
   let opening='',attributeOffset=node.openingElement.start;for(const attribute of attributes){opening+=code.slice(attributeOffset,attribute.start);if(attribute.type==='JSXSpreadAttribute')opening+='{...__studioFlow.spread(()=>('+rewrite(attribute.argument,attribute,'argument')+'))}';else if(attribute.value?.type==='JSXExpressionContainer')opening+=code.slice(attribute.start,attribute.value.start)+'{__studioFlow.prop('+JSON.stringify(attribute.name.name)+',()=>('+rewrite(attribute.value.expression,attribute.value,'expression')+'),'+valueProof(attribute.value.expression)+')}';else opening+=rewrite(attribute,node.openingElement,'attributes');attributeOffset=attribute.end;}opening+=code.slice(attributeOffset,node.openingElement.end);
   const existingRef=attributes.find(a=>a.name?.name==='ref');
   if(existingRef&&existingRef.value?.type!=='JSXExpressionContainer'){onGap({path:file,reason:'Legacy string ref'});return result;}
   if(host){const at=opening.length-(node.openingElement.selfClosing?2:1);opening=opening.slice(0,at)+' ref={__studioFlow.jsxRef(__studioRef)}'+opening.slice(at);}
   result=opening+result.slice(get(node.openingElement).length);
   // Capture each expression child separately. Static whitespace consumes no
   // React child slot; ordinary text follows the compiler's JSX whitespace rule.
   let slot=0;for(const child of node.children){if(child.type==='JSXText'){const lines=child.value.split(/\r\n|\n|\r/);let value='';for(let i=0;i<lines.length;i++){let line=lines[i].replace(/\t/g,' ');if(i)line=line.replace(/^ +/,'');if(i!==lines.length-1)line=line.replace(/ +$/,'');if(line)value+=line+(i<lines.length-1?' ':'');}if(value)slot++;continue;}if(child.type==='JSXExpressionContainer'){if(child.expression.type==='JSXEmptyExpression')continue;const text=get(child);result=result.replace(text,'{__studioFlow.child('+slot+',()=>('+text.slice(1,-1)+'),'+valueProof(child.expression)+')}');}slot++;}
   const site={path:file,hash,line:code.slice(0,node.start).split('\n').length,expression:original.slice(0,1200),kind:name};
   const isStatic=node.children.every(c=>c.type==='JSXText')&&attributes.every(a=>!a.value||a.value.type==='Literal');
   changed=true;result='__studioFlow.jsx(()=>('+result+'))';if(host)result='__studioFlow.element('+JSON.stringify(site)+',(__studioRef)=>('+result+'),'+isStatic+')';
   if(parent?.type==='JSXElement'||parent?.type==='JSXFragment')result='{'+result+'}';
  }
  return result;
 }
 const output=rewrite(parsed.program,null,'');
 if(!changed)return null;
 // Framework directives must remain the first statements. Everything before
 // this insertion point is unchanged by the expression instrumentation above.
 let insertion=code.startsWith('#!')?(code.indexOf('\n')<0?code.length:code.indexOf('\n')):0;
 for(const statement of parsed.program.body||[]){
  if(statement.type!=='ExpressionStatement'||statement.expression?.type!=='Literal'||typeof statement.expression.value!=='string')break;
  insertion=statement.end;
 }
 return output.slice(0,insertion)+(insertion?'\n':'')+'import * as __studioFlow from '+JSON.stringify(runtimeImport)+';\n'+output.slice(insertion);
}

export default function studioTracing(options={}) {
 let config,active=false,root,sourceRoots=[];
 const enabled=options.enabled??process.env.STUDIO_TRACE==='1';
 return {
  name:'studio-development-tracing',enforce:'pre',apply:'serve',
  async configResolved(value){
   config=value;root=path.resolve(options.repositoryRoot||value.root);sourceRoots=(options.include||['src']).map(p=>path.resolve(value.root,p));
   active=enabled&&value.command==='serve'&&!value.isProduction;
  },
  resolveId(id){if(active&&id===moduleId)return resolvedId;if(active&&id===codecId)return resolvedCodecId;if(active&&id===managedId)return resolvedManagedId;},
  async load(id){if(!active)return;if(id===resolvedCodecId)return await readFile(new URL('./trace-codec.mjs',import.meta.url),'utf8');if(id===resolvedManagedId)return (await readFile(new URL('./managed-trace.mjs',import.meta.url),'utf8')).replace("from './trace-codec.mjs'",'from '+JSON.stringify(codecId));if(id===resolvedId)return (await readFile(new URL('./runtime.mjs',import.meta.url),'utf8')).replace("from './managed-trace.mjs'",'from '+JSON.stringify(managedId))+'\ninstallFetch('+JSON.stringify({exclude:options.excludeRequests||['/auth','/api/auth','/api/v1/auth']})+');';},
  transform(code,id,environment){
   if(!active||environment?.ssr||this.environment?.name==='ssr')return;
   const file=id.split('?')[0],relative=path.relative(root,file).replaceAll('\\','/');
   if(!sourceRoots.some(dir=>inside(dir,file))||!/[.][cm]?[jt]sx?$/.test(file)||/(?:^|\/)(?:node_modules|archives?|dist|\.git)(?:\/|$)/i.test(relative))return;
   try{return transformStudio(code,file,root,parsePortable,{refComponents:options.refComponents,onGap:gap=>options.onGap?.(gap)});}
   catch(e){config.logger.warn('[Studio tracing] Skipped '+relative+': '+e.message);return;}
  },
  transformIndexHtml(){if(active)return [{tag:'script',attrs:{type:'module'},children:'import '+JSON.stringify('/@id/__x00__'+moduleId)+';',injectTo:'head-prepend'}];}
 };
}
