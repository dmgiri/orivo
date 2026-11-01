'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const emit = (name,detail) => window.dispatchEvent(new CustomEvent('trace-atlas:'+name,{detail}));
  let graph=null, selected=null, explorer='app', inspector='source', choices=[], commandIndex=0;
  const notice=message=>emit('notice',message);
  function setExplorer(name){explorer=name;$('sidebar-preview-area').hidden=name!=='app';$('sidebar-source-area').hidden=name!=='sources';for(const kind of ['app','sources']){$('explorer-'+kind).setAttribute('aria-selected',String(kind===name));$('explorer-'+kind).tabIndex=kind===name?0:-1;}window.dispatchEvent(new Event('resize'));}
  window.addEventListener('trace-atlas:explorer',event=>{if(['app','sources'].includes(event.detail))setExplorer(event.detail);});
  $('explorer-app').onclick=()=>setExplorer('app');$('explorer-sources').onclick=()=>setExplorer('sources');
  for(const name of ['app','sources'])$('explorer-'+name).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setExplorer(name==='app'?'sources':'app');$('explorer-'+explorer).focus();}});
  function setInspector(name,select=true){inspector=name;const panel=$('detail-body').closest('section');panel.classList.toggle('evidence-only',name==='evidence'||name==='components');panel.classList.toggle('components-only',name==='components');for(const b of document.querySelectorAll('[data-inspector]')){const active=b.dataset.inspector===name;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}if(name==='evidence'||name==='components'||!select)return;if(!graph){notice('Select an element to capture a path first.');return;}const node=name==='sql'?graph.nodes.find(n=>n.kind==='query'):selected?.file&&selected.kind!=='query'?selected:graph.nodes.find(n=>n.kind==='source'||n.kind==='backend');if(node)emit('select-node',{id:node.id});else notice(name==='sql'?'No executed query was captured for this element.':'No source binding was captured for this element.');}
  window.addEventListener('trace-atlas:inspector',event=>{if(['source','sql','evidence','components'].includes(event.detail))setInspector(event.detail,false);});
  for(const b of document.querySelectorAll('[data-inspector]')){b.onclick=()=>setInspector(b.dataset.inspector);b.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const buttons=[...document.querySelectorAll('[data-inspector]')],next=buttons[(buttons.indexOf(b)+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length];setInspector(next.dataset.inspector);next.focus();});}
  function renderTree(){const tree=$('source-tree');tree.replaceChildren();const nodes=graph?[...new Map(graph.nodes.filter(n=>n.file).map(n=>[n.file,n])).values()]:[];$('explorer-file-count').textContent=nodes.length;const queries=graph?.nodes.filter(n=>n.kind==='query')||[],executions=queries.reduce((total,node)=>total+Math.max(1,Number(node.meta?.executionCount)||1),0);$('inspector-query-count').textContent=executions;$('inspector-query-count').title=`${queries.length} SQL block${queries.length===1?'':'s'} · ${executions} captured execution${executions===1?'':'s'}`;if(!nodes.length){const p=document.createElement('p');p.className='empty-small';p.textContent='No captured source files in this context.';tree.append(p);}for(const node of nodes){const button=document.createElement('button');button.className='tree-file'+(node.file===selected?.file?' active':'');button.dataset.file=node.file;const ext=document.createElement('span'),name=document.createElement('span'),line=document.createElement('small');ext.className='file-extension';ext.textContent=node.file.split('.').at(-1).toUpperCase().slice(0,3);name.className='tree-file-name';name.textContent=node.file;line.textContent=node.line?':'+node.line:'';button.title=node.file;button.append(ext,name,line);button.onclick=()=>{setInspector(node.kind==='query'?'sql':'source',false);emit('select-node',{id:node.id});};tree.append(button);}}
  window.addEventListener('trace-atlas:graph',event=>{graph=event.detail;selected=graph?.nodes.find(n=>n.kind==='source')||null;renderTree();if(!graph)setInspector('source',false);});
  window.addEventListener('trace-atlas:node',event=>{selected=event.detail;if(inspector!=='evidence')setInspector(selected.kind==='query'?'sql':'source',false);document.querySelectorAll('.tree-file').forEach(button=>button.classList.toggle('active',button.dataset.file===selected.file));});
  const actions=[
    {label:'Inspect: select an element',hint:'I',icon:'⌖',run:()=>{setExplorer('app');$('inspect-button').click();}},
    {label:'View: maximize application preview',hint:'Workspace',icon:'+',run:()=>emit('preview-maximized',true)},
    {label:'View: restore application preview',hint:'Escape',icon:'-',run:()=>emit('preview-maximized',false)},
    {label:'View: trace map',hint:'Workspace',icon:'⌁',run:()=>emit('view','map')},
    {label:'View: files & code',hint:'Workspace',icon:'⌘',run:()=>emit('view','files')},
    {label:'View: requests & queries',hint:'Workspace',icon:'↔',run:()=>emit('view','requests')},
    {label:'View: diagrams and Archify tools',hint:'Diagram studio',icon:'◇',run:()=>window.dispatchEvent(new Event('orivo:open-diagrams'))},
    {label:'Trace: follow captured path',hint:'F',icon:'▷',run:()=>$('play-trace').click()},
    {label:'Project: connect an application',hint:'Connection',icon:'+',run:()=>emit('open-dialog','connections-dialog')},
    {label:'Project: recent projects and welcome',hint:'Projects',icon:'+',run:()=>emit('open-dialog','welcome-dialog')},
    {label:'Project: open the live SQLite demo',hint:'Reference app',icon:'◈',run:()=>$('load-demo').click()},
    {label:'Trace: attach automatically',hint:'Development session',icon:'↗',run:()=>$('attach-button').click()},
    {label:'Trace: stop attached session',hint:'Owned servers',icon:'□',run:()=>{if(!$('stop-attachment').hidden)$('stop-attachment').click();else notice('No automatic session is running.');}},
    {label:'Trace: export evidence',hint:'JSON',icon:'↓',run:()=>$('export-button').click()},
    {label:'Trace: health, performance and saved captures',hint:'Trace tools',icon:'≡',run:()=>$('trace-tools-button').click()},
    {label:'Diagram: focus selected field',hint:'Captured column path',icon:'⌁',run:()=>emit('map-options',{scope:'field'})},
    {label:'Diagram: show entire request',hint:'All captured SQL',icon:'⌁',run:()=>emit('map-options',{scope:'request'})},
    {label:'Source: open selected line in VS Code',hint:'Verified current source',icon:'↗',run:()=>{if(!$('open-editor').disabled)$('open-editor').click();else notice('Capture a verified current source step before opening it in VS Code.');}},
    {label:'Source: refresh index and recapture',hint:'Read only',icon:'↻',run:async()=>{if(!window.traceAtlas){notice('Open the desktop app to refresh its source index.');return;}if(graph?.snapshot?.readOnly){notice('Saved captures are read only. Select an element in the live app to capture current source.');return;}const selector=graph?.selector;try{await window.traceAtlas.refreshSource();if(selector)await window.traceAtlas.capture(selector);notice('Source index refreshed.');}catch(error){notice(error.message);}}},
    {label:'Color theme: GitHub Dark Default',hint:'Appearance',icon:'◐',run:()=>emit('theme','dark')},
    {label:'Color theme: GitHub Light Default',hint:'Appearance',icon:'◑',run:()=>emit('theme','light')},
    {label:'Layout: reset panel sizes',hint:'Workspace',icon:'⊞',run:()=>{for(const panel of panels)panel.reset();emit('preview-maximized',false);window.dispatchEvent(new Event('resize'));}},
    {label:'Help: how tracing works',hint:'Guide',icon:'?',run:()=>emit('open-dialog','guide-dialog')},
    {label:'Help: about Orivo and diagnostics',hint:'Support',icon:'?',run:()=>emit('open-dialog','about-dialog')}
  ];
  function renderCommands(){const q=$('command-input').value.trim().toLowerCase(),files=graph?[...new Map(graph.nodes.filter(n=>n.file).map(n=>[n.file,n])).values()].map(n=>({label:n.file,hint:'L'+(n.line||1),icon:'▤',run:()=>{setInspector('source',false);emit('select-node',{id:n.id});}})):[];choices=[...files,...actions].filter(option=>(option.label+' '+option.hint).toLowerCase().includes(q));commandIndex=0;const box=$('command-results');box.replaceChildren();const heading=document.createElement('div');heading.className='command-section';heading.textContent=q?'MATCHING FILES & COMMANDS':'FILES & WORKSPACE COMMANDS';box.append(heading);if(!choices.length){const p=document.createElement('p');p.className='command-section';p.textContent='No matching files or commands.';box.append(p);}choices.forEach((choice,i)=>{const b=document.createElement('button');b.className='command-option'+(i===0?' active':'');b.id='command-option-'+i;b.setAttribute('role','option');b.setAttribute('aria-selected',String(i===0));b.tabIndex=-1;const glyph=document.createElement('span'),label=document.createElement('span'),hint=document.createElement('small');glyph.textContent=choice.icon;glyph.style.flex='0';glyph.style.width='17px';glyph.style.color='var(--accent)';label.textContent=choice.label;hint.textContent=choice.hint;b.append(glyph,label,hint);b.onclick=()=>chooseCommand(i);box.append(b);});$('command-input').setAttribute('aria-activedescendant',choices.length?'command-option-0':'');}
  for(const action of actions){action.label=action.label.replace('GitHub Dark Default','Dark glass').replace('GitHub Light Default','Light glass');action.icon='›';}
  function chooseCommand(i){const choice=choices[i];if(!choice)return;$('command-dialog').close();choice.run();}
  function openCommands(){$('command-input').value='';renderCommands();emit('open-dialog','command-dialog');}
  $('command-center').onclick=openCommands;$('command-input').oninput=renderCommands;$('command-input').setAttribute('role','combobox');$('command-input').setAttribute('aria-controls','command-results');$('command-input').setAttribute('aria-expanded','true');
  $('command-input').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!choices.length)return;commandIndex=(commandIndex+(event.key==='ArrowDown'?1:choices.length-1))%choices.length;document.querySelectorAll('.command-option').forEach((button,i)=>{button.classList.toggle('active',i===commandIndex);button.setAttribute('aria-selected',String(i===commandIndex));});$('command-input').setAttribute('aria-activedescendant','command-option-'+commandIndex);$('command-option-'+commandIndex).scrollIntoView({block:'nearest'});}if(event.key==='Enter'){event.preventDefault();chooseCommand(commandIndex);}});
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&(event.key.toLowerCase()==='k'||event.key.toLowerCase()==='p')){event.preventDefault();if(!document.querySelector('dialog[open]'))openCommands();}});
  const workbench=document.querySelector('.workbench');
  // Reserve a usable trace pane; the preview can take the rest of any desktop window.
  const sidebarMaximum=()=>Math.max(250,Math.floor(workbench.clientWidth-400));
  function outerHeight(element){
    if(!element.getClientRects().length)return 0;
    const style=getComputedStyle(element);
    return element.getBoundingClientRect().height+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);
  }
  function previewMaximum(){
    const sidebar=$('app-sidebar'),area=$('sidebar-preview-area'),wrap=document.querySelector('.preview-wrap'),style=getComputedStyle(sidebar),wrapStyle=getComputedStyle(wrap);
    if(area.hidden)return Math.max(160,parseFloat(getComputedStyle(document.body).getPropertyValue('--preview-height'))||400);
    const siblings=[...sidebar.children].filter(child=>child!==area).reduce((sum,child)=>sum+outerHeight(child),0);
    const chrome=[...area.children].filter(child=>child!==wrap&&child.id!=='inspect-hint').reduce((sum,child)=>sum+outerHeight(child),0);
    const frame=outerHeight(document.querySelector('.preview-caption'))+outerHeight($('preview-height-sash'))+(parseFloat(wrapStyle.marginTop)||0)+(parseFloat(wrapStyle.marginBottom)||0)+(parseFloat(wrapStyle.borderTopWidth)||0)+(parseFloat(wrapStyle.borderBottomWidth)||0);
    let available=sidebar.clientHeight-siblings-chrome-frame-(parseFloat(style.paddingTop)||0)-(parseFloat(style.paddingBottom)||0)-2;
    const details=$('preview-details'),content=details.querySelector('.preview-details-content'),previous=details.open?content.getBoundingClientRect().height:0;
    // Keep both the browser minimum and the footer visible when details expand.
    content.style.maxHeight=Math.max(0,Math.min(200,Math.floor(available+previous-160)))+'px';
    if(details.open)available+=previous-content.getBoundingClientRect().height;
    return Math.max(160,Math.floor(available));
  }
  function resizer(id,key,prop,axis,min,maximum,fallback,options={}){
    const sash=$(id),saved=Number(localStorage.getItem(key));
    let preferred=Number.isFinite(saved)&&saved>=min?saved:null,drag=null;
    const defaultSize=()=>typeof fallback==='function'?fallback():fallback;
    const current=()=>parseFloat(getComputedStyle(document.body).getPropertyValue(prop))||defaultSize();
    const limit=()=>typeof maximum==='function'?maximum():maximum;
    function refresh(){
      const max=limit(),value=Math.round(Math.min(max,Math.max(min,preferred??defaultSize())));
      document.body.style.setProperty(prop,value+'px');
      sash.setAttribute('aria-valuemin',String(min));
      sash.setAttribute('aria-valuemax',String(max));
      sash.setAttribute('aria-valuenow',String(value));
      sash.setAttribute('aria-valuetext',`${value} pixels`);
    }
    function save(value){
      preferred=Math.round(Math.min(limit(),Math.max(min,value)));
      localStorage.setItem(key,String(preferred));
      refresh();
      window.dispatchEvent(new Event('resize'));
    }
    function reset(){preferred=null;localStorage.removeItem(key);refresh();}
    sash.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();
      drag={start:axis==='x'?event.clientX:event.clientY,size:current(),pointerId:event.pointerId};
      sash.setPointerCapture(event.pointerId);
      sash.classList.add('dragging');
      document.body.classList.add('resizing-panel');
      if(options.preview||axis==='x')emit('preview-resizing',true);
    });
    sash.addEventListener('pointermove',event=>{
      if(!drag)return;
      const delta=(axis==='x'?event.clientX:event.clientY)-drag.start;
      save(drag.size+(axis==='x'||options.growDown?delta:-delta));
    });
    const end=()=>{if(!drag)return;const pointerId=drag.pointerId;drag=null;if(sash.hasPointerCapture(pointerId))sash.releasePointerCapture(pointerId);sash.classList.remove('dragging');document.body.classList.remove('resizing-panel');if(options.preview||axis==='x')emit('preview-resizing',false);};
    sash.addEventListener('pointerup',end);
    sash.addEventListener('pointercancel',end);
    sash.addEventListener('lostpointercapture',end);
    window.addEventListener('blur',end);
    window.addEventListener('trace-atlas:cancel-panel-resize',end);
    sash.addEventListener('dblclick',()=>{reset();window.dispatchEvent(new Event('resize'));});
    sash.addEventListener('keydown',event=>{
      const arrows=axis==='x'?['ArrowLeft','ArrowRight']:options.growDown?['ArrowUp','ArrowDown']:['ArrowDown','ArrowUp'];
      if(![...arrows,'Home','End'].includes(event.key))return;
      event.preventDefault();
      if(event.key==='Home'){reset();window.dispatchEvent(new Event('resize'));return;}
      const delta=(event.key===arrows[1]?1:-1)*(event.shiftKey?50:10);
      save(event.key==='End'?limit():current()+delta);
    });
    refresh();
    return {refresh,reset};
  }
  const panels=[
    resizer('sidebar-sash','trace-atlas-sidebar','--sidebar','x',250,sidebarMaximum,320),
    resizer('detail-sash','trace-atlas-inspector','--inspector-height','y',130,420,210),
    resizer('preview-height-sash','trace-atlas-preview-height','--preview-height','y',160,previewMaximum,previewMaximum,{growDown:true,preview:true})
  ];
  const refreshPanels=()=>{for(const panel of panels)panel.refresh();};
  window.addEventListener('resize',refreshPanels);
  new ResizeObserver(refreshPanels).observe(workbench);
  new ResizeObserver(refreshPanels).observe($('preview-details'));
  $('preview-details').addEventListener('toggle',()=>{refreshPanels();window.dispatchEvent(new Event('resize'));});
})();
