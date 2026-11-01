(function(root,factory){const pack=factory();if(typeof module==='object'&&module.exports)module.exports=pack;else root.OrivoThemes=pack;})(globalThis,()=>{
 'use strict';
 const upstream=typeof module==='object'&&module.exports?require('./archify-theme-data.js'):globalThis.OrivoArchifyThemes;
 const vscode=typeof module==='object'&&module.exports?require('./vscode-theme-data.js'):globalThis.OrivoVSCodeThemes;
 const workbenchPalettes=[{id:'vscode-2026',name:'VS Code'}];
 const globalPalettes=Object.entries(upstream).map(([id,modes])=>({id,name:({'classic':'Classic','signal-flow':'Signal Flow','blueprint':'Blueprint','editorial':'Editorial'})[id],family:'archify',colors:[modes.dark.bg,modes.dark.mask,modes.dark['backend-stroke'],modes.dark['text-muted'],modes.light.bg,modes.dark['arrow-emphasis']]}));
 const palettes=[
  {id:'forest',name:'Forest Brass',colors:['#0B0F0D','#1F2A1F','#3E5A3F','#8CA98C','#D9C7A3','#B08D57']},
  {id:'violet',name:'Violet Ember',colors:['#1A1A1F','#2D2B55','#6A5ACD','#A678B9','#F0D9B5','#F4A62A']},
  {id:'berry',name:'Berry Coral',colors:['#1A0F2E','#3B1B4F','#7A2E6F','#D6598F','#F4D7D4','#FF6B6B']},
  {id:'slate',name:'Slate Rose',colors:['#121212','#1F2937','#334155','#64748B','#F1F5F9','#EC4899']},
  {id:'teal',name:'Teal Copper',colors:['#0A0F14','#0F3D3E','#2E6F73','#7FB3B8','#EADCC8','#C6601F']},
  {id:'olive',name:'Olive Stone',colors:['#0F1F17','#1E3A2E','#3E5A3F','#6B7F67','#C7CBB8','#3D4337']},
  {id:'espresso',name:'Espresso Sand',colors:['#1A120E','#3A2418','#6B4A2E','#A88462','#D5C4AE','#4A4A46']},
  {id:'midnight',name:'Midnight Amber',colors:['#0B132B','#1C2541','#3A506B','#5BC0DE','#F4D6B0','#D97706']},
  {id:'amethyst',name:'Amethyst Mist',colors:['#0E0B1D','#2A1E4D','#5A3B8C','#8B7CC7','#C9C2E3','#3A3A52']}
 ];
 const rgb=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16));
 const mix=(a,b,amount)=>'#'+rgb(a).map((v,i)=>Math.round(v*(1-amount)+rgb(b)[i]*amount).toString(16).padStart(2,'0')).join('');
 const luminance=color=>rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return(values[0]+.05)/(values[1]+.05);};
 function readable(color,background,min=4.5){const toward=luminance(background)<.3?'#ffffff':'#000000';for(let i=0;i<=20;i++){const candidate=mix(color,toward,i/20);if(contrast(candidate,background)>=min)return candidate;}return toward;}
 function vscodeTokens(mode){
  const data=vscode[mode==='light'?'light':'dark'],c=data.colors;
  function color(key,background=c['editor.background'],fallback='#808080'){
   const value=c[key]||fallback;if(/^#[a-f\d]{6}$/i.test(value))return value;
   if(/^#[a-f\d]{8}$/i.test(value))return mix(background,value.slice(0,7),parseInt(value.slice(7),16)/255);
   return fallback;
  }
  const page=color('editor.background'),panel=color('sideBar.background'),ink=color('foreground'),accent=color('textLink.foreground'),code=page,button=color('button.background');
  function syntax(scope,fallback){for(const rule of [...data.tokenColors].reverse()){const scopes=(Array.isArray(rule.scope)?rule.scope:String(rule.scope||'').split(',')).map(s=>s.trim());if(scopes.some(s=>s===scope||s.startsWith(scope+'.'))&&/^#[a-f\d]{6}$/i.test(rule.settings?.foreground||''))return readable(rule.settings.foreground,code);}return readable(fallback,code);}
  const result={page,panel,card:panel,rail:color('activityBar.background'),canvas:page,ink,muted:readable(color('descriptionForeground'),panel),subtle:readable(color('icon.foreground'),panel),line:color('panel.border'),accent,'accent-deep':color('textLink.activeForeground'),button,'button-hover':color('button.hoverBackground'),'on-button':color('button.foreground'),'accent-soft':mix(panel,accent,.13),code,'on-accent':contrast(accent,'#ffffff')>=contrast(accent,page)?'#ffffff':page,selection:color('list.activeSelectionBackground',panel),'active-line':color('editor.lineHighlightBackground'),edge:readable(color('editorLineNumber.foreground'),page,3),dot:color('panel.border'),success:syntax('support.function','#82caa8'),keyword:syntax('keyword','#569cd6'),string:syntax('string','#ce9178'),number:syntax('constant.numeric','#b5cea8'),comment:syntax('comment','#858889'),'editor-ink':color('editor.foreground'),'input-bg':color('input.background'),'input-border':color('dropdown.border'),'tab-bg':color('tab.inactiveBackground',panel,panel),'tab-active':color('tab.activeBackground',page,page),'status-bg':color('statusBar.background'),'title-bg':color('titleBar.activeBackground'),'focus-border':color('focusBorder',panel),'hover-bg':color('list.hoverBackground',panel)};
  for(const [kind,value]of [['element',result.muted],['source',accent],['api',syntax('entity.name.function',accent)],['backend',result.success],['query',result.keyword],['model',result.number],['database',result.string],['gap',color('errorForeground')]]){result['kind-'+kind]=readable(value,panel);result['soft-'+kind]=mix(panel,value,.12);}
  if(mode==='light'){
   Object.assign(result,{page:'#eef5fb',panel:'#e3eff9',rail:'#dbeaf7',canvas:'#e7f1fa',card:'#f8fbff',code:'#f7fbff',line:'#b5ccdf',muted:'#4b6173',subtle:'#526779','input-bg':'#f8fbff','input-border':'#a9c4da','tab-bg':'#dfeaf5','tab-active':'#f3f8fd','status-bg':'#dbeaf7','title-bg':'#e3eff9','hover-bg':'#d0e4f5',selection:'#c4ddf2','active-line':'#e0eefb','accent-soft':'#d1e6f8',edge:'#657f94'});
   for(const kind of ['element','source','api','backend','query','model','database','gap'])result['kind-'+kind]=readable(result['kind-'+kind],result.panel);
  }
  return result;
 }
 function tokens(id,mode='dark'){
  if(id==='vscode-2026')return vscodeTokens(mode);
  const palette=[...globalPalettes,...palettes].find(p=>p.id===id)||palettes[0],[base,surface,depth,muted,paper,highlight]=palette.colors,dark=mode!=='light',original=upstream[palette.id]?.[dark?'dark':'light'];
  const panel=original?.mask||(dark?surface:mix(paper,'#ffffff',.92)),page=original?.bg||(dark?base:mix(paper,'#ffffff',.78)),ink=original?.text||(dark?mix(paper,'#ffffff',.77):base);
  const accent=readable(original?.['arrow-emphasis']||(dark?(luminance(highlight)>.15?highlight:muted):depth),panel);
  const result={page,panel,rail:dark?mix(base,surface,.64):mix(paper,'#ffffff',.84),canvas:dark?mix(base,surface,.35):mix(paper,'#ffffff',.88),ink,muted:readable(mix(ink,panel,.28),panel),subtle:readable(mix(ink,panel,.38),panel),line:mix(panel,ink,dark?.23:.23),accent,'accent-deep':accent,'accent-soft':mix(panel,accent,dark?.22:.13),code:dark?mix(base,surface,.4):mix(paper,'#ffffff',.96),'on-accent':contrast(accent,'#ffffff')>=contrast(accent,base)?'#ffffff':base,selection:mix(panel,accent,.22),'active-line':mix(panel,accent,.13),edge:readable(muted,panel,3),dot:mix(panel,ink,.19),success:accent,keyword:readable(highlight,dark?mix(base,surface,.4):mix(paper,'#ffffff',.96)),string:readable(muted,dark?mix(base,surface,.4):mix(paper,'#ffffff',.96)),number:readable(dark?paper:depth,dark?mix(base,surface,.4):mix(paper,'#ffffff',.96)),comment:readable(muted,dark?mix(base,surface,.4):mix(paper,'#ffffff',.96))};
  for(const [kind,color]of [['element',muted],['source',accent],['api',highlight],['backend',depth],['query',highlight],['model',muted],['database',accent],['gap',highlight]]){result['kind-'+kind]=readable(color,panel);result['soft-'+kind]=mix(panel,color,dark?.2:.12);}
  if(original){
   Object.assign(result,{page,panel,canvas:page,rail:panel,code:panel,ink,muted:readable(original['text-muted'],panel),subtle:readable(original['text-faint'],panel),line:original['panel-border'],edge:readable(original.arrow,panel,3),keyword:readable(original['database-stroke'],panel),string:readable(original['backend-stroke'],panel),number:readable(original['cloud-stroke'],panel),comment:readable(original['text-muted'],panel)});
   for(const [kind,key]of [['element','external'],['source','frontend'],['api','cloud'],['backend','backend'],['query','cloud'],['model','database'],['database','database'],['gap','security']]){const color=original[key+'-stroke'];result['kind-'+kind]=readable(color,panel);result['soft-'+kind]=mix(panel,color,dark?.16:.1);}
  }
  return result;
 }
 return {version:3,palettes,globalPalettes,workbenchPalettes,tokens,contrast};
});
