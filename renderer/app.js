'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const paths = {
    route:'M4 6h7a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h11M4 3v6m16 6v6',
    plug:'m8 3 1 5m7-5-1 5M7 8h10v3a5 5 0 0 1-10 0Zm5 8v5',
    history:'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2',
    book:'M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v14c-4-1-7 0-9 2-2-2-5-3-9-2Z',
    moon:'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z',
    sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 1.4 1.4m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    folder:'M3 7V5h6l2 2h10v13H3Zm0 3h18',
    minimize:'M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5M8 8 3 3m13 5 5-5M8 16l-5 5m13-5 5 5',
    expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6',
    globe:'M21 12H3m9-9c5 5 5 13 0 18-5-5-5-13 0-18Zm9 9a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    'arrow-right':'M4 12h15m-6-6 6 6-6 6',
    'arrow-left':'M20 12H5m6 6-6-6 6-6',
    refresh:'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
    cursor:'m5 3 15 9-7 2-3 7Zm8 11 5 6',
    code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
    shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
    'chevron-right':'m9 5 7 7-7 7',
    'chevron-down':'m5 9 7 7 7-7',
    download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    files:'M8 3h9l4 4v12H8Zm9 0v5h4M3 7v15h13',
    activity:'M2 12h5l3-8 4 16 3-8h5',
    play:'m8 4 12 8-12 8Z',
    pause:'M8 4v16m8-16v16',
    maximize:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    copy:'M8 8h13v13H8ZM4 16H3V3h13v1',
    close:'m5 5 14 14M5 19 19 5',
    info:'M12 10v7m0-11v1m9 5a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    database:'M20 6c0 4-16 4-16 0s16-4 16 0Zm0 0v12c0 4-16 4-16 0V6m0 6c0 4 16 4 16 0',
    server:'M3 3h18v7H3Zm0 11h18v7H3ZM6 6h1m-1 11h1m4-11h7m-7 11h7',
    query:'M4 4h16v16H4Zm4 4 3 3-3 3m5 2h4',
    model:'M4 3h16v18H4Zm0 6h16M8 13h2m3 0h3m-8 4h2m3 0h3',
    check:'m5 12 4 4L19 6',
    warning:'m12 3 10 18H2Zm0 6v5m0 3v1',
    element:'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z'
    ,search:'M16 16l5 5m-3-11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'
  };
  function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.code}"/></svg>`; }
  function refreshIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon)); }
  refreshIcons();
  const api = window.traceAtlas;
  document.title='Orivo - Discover every connection';
  document.querySelector('.command-placeholder').textContent='Search files and commands';
  $('command-input').placeholder='Search files or commands';
  $('zoom-out').textContent='−';
  document.querySelector('.map-navigation-hint').textContent='Scroll to zoom · Drag to pan';
  document.querySelectorAll('.command-footer kbd').forEach((key,index)=>{if(index<2)key.textContent=index?'↓':'↑';});
  document.querySelector('.wordmark').title='Orivo - Connection and lineage';
  const sessionSetup=document.createElement('button');
  sessionSetup.id='session-setup';sessionSetup.className='secondary-button';sessionSetup.type='button';
  sessionSetup.textContent='Tracing setup';sessionSetup.onclick=()=>openDialog('tracing-setup-dialog');
  document.querySelector('.heading-actions').insertBefore(sessionSetup,$('export-button'));
  const componentTab=document.createElement('button');componentTab.type='button';componentTab.dataset.inspector='components';
  componentTab.setAttribute('role','tab');componentTab.setAttribute('aria-selected','false');componentTab.textContent='Components';
  document.querySelector('.inspector-tabs').insertBefore(componentTab,document.querySelector('[data-inspector=evidence]'));
  const appearance=document.createElement('div');appearance.className='appearance-switch';appearance.setAttribute('role','group');appearance.setAttribute('aria-label','Appearance');
  for(const [value,label] of [['light','Light'],['dark','Dark']]){const button=document.createElement('button');button.type='button';button.dataset.appearance=value;button.textContent=label;button.setAttribute('aria-pressed','false');button.onclick=()=>setTheme(value);appearance.append(button);}
  document.querySelector('.topbar').insertBefore(appearance,$('connect-top'));
  const paletteControl=document.createElement('label');paletteControl.className='palette-control';
  const paletteLabel=document.createElement('span');paletteLabel.textContent='Theme';
  const paletteSelect=document.createElement('select');paletteSelect.id='palette-select';paletteSelect.setAttribute('aria-label','Color theme');
  for(const palette of window.OrivoThemes.workbenchPalettes){const option=document.createElement('option');option.value=palette.id;option.textContent=palette.name;paletteSelect.append(option);}
  paletteControl.append(paletteLabel,paletteSelect);document.querySelector('.topbar').insertBefore(paletteControl,appearance);
  let paletteId=localStorage.getItem('orivo-palette')||'vscode-2026';
  if(!window.OrivoThemes.workbenchPalettes.some(p=>p.id===paletteId))paletteId='vscode-2026';
  paletteSelect.value=paletteId;
  let appearanceReady=false,appearanceTransition=null,appearanceRevision=0;
  function changeAppearance(update,{wave=false}={}){
    const revision=++appearanceRevision,root=document.documentElement;
    const apply=()=>{if(revision===appearanceRevision)update();};
    appearanceTransition?.skipTransition();
    if(!appearanceReady||matchMedia('(prefers-reduced-motion: reduce)').matches||typeof document.startViewTransition!=='function'){appearanceTransition=null;delete root.dataset.themeTransition;apply();return;}
    if(wave){
      if(!document.getElementById('theme-water-surface')){const surface=document.createElement('div');surface.id='theme-water-surface';surface.className='theme-water-surface';surface.setAttribute('aria-hidden','true');document.body.append(surface);}
      root.style.setProperty('--theme-wave-radius',Math.ceil(Math.hypot(innerWidth,innerHeight))+'px');root.dataset.themeTransition='wave';
    }else delete root.dataset.themeTransition;
    const transition=document.startViewTransition(apply);appearanceTransition=transition;
    transition.ready.catch(()=>{}); // Rapid switching intentionally skips snapshots.
    transition.finished.catch(()=>{}).finally(()=>{if(appearanceTransition===transition){appearanceTransition=null;delete root.dataset.themeTransition;}});
  }
  function applyPalette(mode){document.documentElement.dataset.palette=paletteId;for(const [key,value]of Object.entries(window.OrivoThemes.tokens(paletteId,mode)))document.documentElement.style.setProperty('--'+key,value);api?.setDiagramAppearance?.(document.getElementById('diagram-preset')?.value||'classic',mode).catch(()=>{});api?.setWindowAppearance?.(mode).then(result=>document.body.classList.toggle('custom-titlebar',!!result?.overlay)).catch(()=>{});}
  paletteSelect.onchange=()=>{paletteId=paletteSelect.value;localStorage.setItem('orivo-palette',paletteId);changeAppearance(()=>applyPalette(theme));};
  document.body.classList.toggle('desktop-runtime',!!api);
  const state = { graph:null, selected:null, history:[], host:{}, view:'map', filesScope:'all', zoom:1, panX:0, panY:0, graphWidth:1000, graphHeight:480, playing:false, timers:[], sourceTicket:0, scope:'field', expanded:new Set(), collapsed:new Set(), presentation:null };
  let productInfo=null, workspaceBusy=false, initialHostReceived=false, previewScroll=0, setupTicket=0, openingDialogs=0, attachmentUiBusy=false, attachmentSelectionUrl, attachmentRetry=null, attachmentRetryRepository=null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const colors = {element:['var(--kind-element)','var(--soft-element)','element','UI ELEMENT'],source:['var(--kind-source)','var(--soft-source)','code','FRONTEND'],api:['var(--kind-api)','var(--soft-api)','globe','API REQUEST'],backend:['var(--kind-backend)','var(--soft-backend)','server','BACKEND'],query:['var(--kind-query)','var(--soft-query)','query','SQL QUERY'],model:['var(--kind-model)','var(--soft-model)','model','ORM MODEL'],database:['var(--kind-database)','var(--soft-database)','database','DATA ORIGIN'],gap:['var(--kind-gap)','var(--soft-gap)','warning','MISSING LINK']};
  function nodeColors(node){const value=colors[node.kind]||colors.gap;if(node.kind!=='source')return value;return [...value.slice(0,3),node.meta?.sourceRole==='response-mapping'||node.label==='Python response mapping'?'PYTHON MAPPING':node.file?.endsWith('.py')?'PYTHON CODE':node.meta?.sourceRole==='backend-call'?'BACKEND CODE':'FRONTEND'];}
  function toast(message, error=false) { const value=String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').slice(0,700);if([...$('toast-region').children].some(node=>node.textContent===value))return;const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=value;$('toast-region').append(el);setTimeout(()=>el.remove(),error?8500:4200); }
  async function run(fn) {try{return await fn();}catch(e){toast(e.message || e,true);return undefined;}}
  function requireDesktop() {if(api)return true;toast('Open the desktop app to connect a real application and its source.');return false;}
  function setIcon(el,name){el.innerHTML=icon(name);}
  const automaticProjectAction=document.createElement('div');
  automaticProjectAction.className='automatic-project-action';
  automaticProjectAction.innerHTML='<button class="primary-button" id="project-auto-attach" type="button">Attach automatically</button><p id="attachment-session-status" role="status">Start a traced session from this folder. No hooks to add or commands to copy.</p>';
  $('project-open-form').before(automaticProjectAction);
  function renderAutomaticAttachment(){
    const session=state.host.attachment||{},starting=session.status==='starting'||session.status==='detecting',running=session.status==='running',stopping=session.status==='stopping';
    const disabled=!api||!state.host.repository||state.host.demo||attachmentUiBusy||starting||running||stopping;
    $('attach-button').disabled=$('project-auto-attach').disabled=!!disabled;
    const runtime=state.host.pageRuntime;
    $('attach-button').querySelector('span:last-child').textContent=running?(runtime==='available'?'Runtime connected':runtime==='missing'?'Runtime missing':'Checking runtime'):attachmentUiBusy||starting?'Attaching…':'Attach tracing';
    $('attach-button').title=running?(runtime==='available'?'Frontend runtime detected on this page. Select an element to verify backend and database coverage.':runtime==='missing'?'The session is running, but this page has no supported frontend tracing runtime. Open Tracing setup or restart the session.':'The development session is running. Checking this page for its tracing runtime.'):session.notice||'Automatically start frontend and backend tracing';
    $('stop-attachment').hidden=!(session.active||starting||stopping);
    $('stop-attachment').disabled=stopping;
    $('attachment-session-status').textContent=session.notice||'Start a traced session from this folder. No hooks to add or commands to copy.';
  }
  async function launchAutomaticTracing(options){
    const enteredUrl=options.url??($('connections-dialog').open?$('project-url').value:$('app-url').value).trim();
    options={...options,...(enteredUrl?{url:enteredUrl}:{})};
    const repository=state.host.repository?.path;
    attachmentUiBusy=true;renderAutomaticAttachment();
    for(const id of ['attachment-dialog','attachment-url-dialog','connections-dialog','welcome-dialog'])if($(id).open)closeDialog(id);
    try{await api.startAttachment(options);await syncHost();if(state.host.attachment?.status==='running')toast('Tracing attached. Select an element to follow its data.');}
    catch(error){
      await syncHost();
      const session=state.host.attachment;
      if(repository!==state.host.repository?.path||!['port-in-use','unsupported-origin'].includes(session?.errorCode))throw error;
      attachmentRetry={...options,url:options.url||session.requestedUrl,urlMode:'provided'};
      attachmentRetryRepository=repository;
      $('attachment-url-notice').textContent=session.notice;
      $('attachment-url-value').textContent=options.url||session.requestedUrl||'';
      $('attachment-url-retry').textContent=session.errorCode==='unsupported-origin'?'Edit address':'Retry same address';
      await openDialog('attachment-url-dialog');
    }
    finally{attachmentUiBusy=false;renderAutomaticAttachment();}
  }
  function currentAttachmentRetry(){if(!attachmentRetry||attachmentRetryRepository!==state.host.repository?.path){closeDialog('attachment-url-dialog');throw Error('The project changed. Attach tracing to the current project again.');}return attachmentRetry;}
  $('attachment-url-retry').onclick=()=>run(async()=>{const options=currentAttachmentRetry();if(state.host.attachment?.errorCode==='unsupported-origin'){closeDialog('attachment-url-dialog');await openDialog('connections-dialog');$('project-url').focus();}else await launchAutomaticTracing(options);});
  $('attachment-url-separate').onclick=()=>run(()=>launchAutomaticTracing({...currentAttachmentRetry(),urlMode:'separate'}));
  function showAttachmentChoices(detection){
    const front=$('attachment-frontend'),back=$('attachment-backend');front.replaceChildren();back.replaceChildren();
    function option(select,value,label,disabled=false){const item=document.createElement('option');item.value=value;item.textContent=label;item.disabled=disabled;select.append(item);}
    for(const item of detection.frontends||[])option(front,item.id,[item.framework,item.directory].filter(Boolean).join(' · '),item.supported===false||item.available===false);
    option(back,'','Frontend only');
    for(const item of detection.backends||[])option(back,item.id,[item.framework,item.directory,item.app||''].filter(Boolean).join(' · '),item.supported===false||item.available===false||!!item.issue);
    if(detection.selected?.frontend)front.value=detection.selected.frontend;
    if(detection.selected?.backend&&!detection.backends?.find(item=>item.id===detection.selected.backend)?.issue)back.value=detection.selected.backend;
    const issues=$('attachment-issues');issues.replaceChildren();
    for(const issue of detection.issues||[]){const li=document.createElement('li');li.textContent=typeof issue==='string'?issue:issue.message||issue.reason||'This configuration needs advanced setup.';issues.append(li);}
    $('attachment-detection-status').textContent=detection.supported?'Choose the applications to run together.':'This project needs additional configuration for automatic attachment.';
    const update=()=>{$('attachment-start').disabled=!front.value||front.selectedOptions[0]?.disabled===true;};
    front.onchange=update;update();
  }
  async function attachAutomaticTracing(){
    if(!requireDesktop())return;
    if(!state.host.repository||state.host.demo){await openDialog('connections-dialog');toast('Choose your project folder to attach tracing.');return;}
    attachmentUiBusy=true;renderAutomaticAttachment();
    attachmentSelectionUrl=($('connections-dialog').open?$('project-url').value:$('app-url').value).trim()||undefined;
    try{
      const detection=await api.detectAttachment();
      const backendIssue=detection.backends?.find(item=>item.id===detection.selected?.backend)?.issue;
      if(detection.supported&&!detection.requiresSelection&&detection.selected?.frontend&&!backendIssue){await launchAutomaticTracing({frontend:detection.selected.frontend,backend:detection.selected.backend??null,url:attachmentSelectionUrl});return;}
      showAttachmentChoices(detection);
      for(const id of ['connections-dialog','welcome-dialog'])if($(id).open)closeDialog(id);
      await openDialog('attachment-dialog');
    }finally{attachmentUiBusy=false;renderAutomaticAttachment();}
  }
  $('attach-button').onclick=$('project-auto-attach').onclick=()=>run(attachAutomaticTracing);
  $('stop-attachment').onclick=()=>run(async()=>{await api.stopAttachment();await syncHost();toast('Traced session stopped.');});
  $('attachment-form').onsubmit=event=>{event.preventDefault();run(()=>launchAutomaticTracing({frontend:$('attachment-frontend').value,backend:$('attachment-backend').value||null,url:attachmentSelectionUrl}));};
  $('attachment-manual').onclick=()=>{closeDialog('attachment-dialog');openDialog('tracing-setup-dialog');};
  async function openDialog(id){stopPlayback();openingDialogs++;try{if(api)await api.setPreviewBounds({x:0,y:0,width:0,height:0,visible:false}).catch(()=>{});if(id==='connections-dialog')prepareProjectDialog();if(id==='welcome-dialog')await loadWorkspaces();if(id==='about-dialog')await loadProductInfo();if(!$(id).open)$(id).showModal();if(id==='tracing-setup-dialog')await loadTracingSetup();}finally{openingDialogs--;scheduleBounds();}}
  function closeDialog(id){$(id).close();scheduleBounds();}
  document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('close',scheduleBounds);dialog.addEventListener('click',e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dialog.close();}});});
  function handleHost(next) {if(next.contextRevision!==undefined&&state.host.contextRevision!==undefined&&next.contextRevision!==state.host.contextRevision){window.dispatchEvent(new Event('trace-atlas:cancel-panel-resize'));clearTrace();}state.host={...state.host,...next};const host=state.host;applyPreviewLayout(!!host.previewMaximized);document.body.classList.toggle('loading',!!host.loading);document.body.classList.toggle('application-connected',!!host.url);$('app-url').value=host.url||host.attachment?.url||host.attachment?.requestedUrl||'';const demo=host.demo;$('project-name').textContent=demo?'Orbit storefront':host.repository?.name || (host.url?'Connected application':'No project open');$('project-avatar').textContent=demo?'O':(host.repository?.name?.[0]||'A').toUpperCase();$('breadcrumb-project').textContent=$('project-name').textContent;$('project-framework').textContent=host.loading?'Connecting to application…':demo?'Node.js · SQLite · Live demo':host.url?'Your development application':'Connect your development application';$('repo-name').textContent=host.repository?.name || 'Choose app folder';$('repo-detail').textContent=host.repository?`${host.repository.fileCount ?? 0} source files · ${host.repository.truncated?'partial index':'read only'}`:'Read-only source inspection';$('footer-status').textContent=host.loading?'Loading application…':host.repository&&host.url?'Source and application connected':host.repository?'Source connected · open your application':host.url?'Application open · connect its source':'Waiting for an application';const inspecting=!!host.inspectMode;$('inspect-button').disabled=!host.url||!!host.loading;$('inspect-button').classList.toggle('inspecting',inspecting);$('inspect-button').querySelector('span:nth-child(2)').textContent=inspecting?'Click an element in the app':'Select an element';$('inspect-button').setAttribute('aria-label',inspecting?'Click an element in the app':'Select an element');$('inspect-button').title=inspecting?'Click an element in the app (Escape cancels)':'Select an element (I)';$('inspect-hint').textContent=inspecting?'Escape cancels. Clicks select without running actions.':host.url?'Point to something. Discover its story.':'Open a running application to select an element.';updateProjectStatus();scheduleBounds();if(!initialHostReceived){initialHostReceived=true;if(host.onboarding===true)openDialog('welcome-dialog');}}
  function prepareProjectDialog(){if(!state.host.demo&&(state.host.url||state.host.attachment?.url||state.host.attachment?.requestedUrl))$('project-url').value=state.host.url||state.host.attachment?.url||state.host.attachment?.requestedUrl;else if(state.host.demo)$('project-url').value='';if(!$('project-workspace-name').value)$('project-workspace-name').placeholder=state.host.repository&&!state.host.demo?state.host.repository.name:'Defaults to the source folder name';updateProjectStatus();}
  function updateProjectStatus(){const host=state.host,connected=!!host.repository&&!host.demo;let addressMatches=false;try{addressMatches=new URL($('project-url').value).href===new URL(host.url).href;}catch{}const canSave=connected&&!!host.url&&!host.loading&&addressMatches;$('project-repository').textContent=connected?(host.repository.path||host.repository.name):'No source folder connected';$('project-repository').title=connected?(host.repository.path||host.repository.name):'';$('save-workspace').disabled=!canSave||workspaceBusy||!api?.saveWorkspace;$('project-open-button').disabled=!!host.loading||workspaceBusy;$('dialog-connect').disabled=workspaceBusy;$('project-save-status').textContent=canSave?'Save this source folder and address to reopen them from Recent projects.':host.demo?'The demo is separate from your saved projects. Choose your own source folder to begin.':connected&&host.url?'Open this application address before saving the project.':'Connect a source folder and application to save this project.';$('project-readiness').textContent=host.demo?'The demo includes source, request, query, and field-origin adapters. Your own project needs the adapters for its stack.':host.repository&&host.url?'Source and application are connected. Capture an element to check which runtime adapters are present. Missing connections remain explicit partial paths.':'Adapter coverage is checked when you capture an element. Unsupported expressions and missing backend evidence remain explicit partial paths.';if(host.repository){const skipped=Object.values(host.repository.skipped||{}).reduce((sum,value)=>sum+(Number(value)||0),0);$('project-readiness').textContent+=host.repository.truncated?' The source index reached its size limit; some paths cannot be resolved.':skipped?' '+skipped+' files or folders were excluded by the source index.':'';}}
  async function syncHost(){if(api){const next=await api.getState();if(next){handleHost(next);renderAutomaticAttachment();}}}
  const readinessReasons={not_running:['Runtime tracing is off','Enable development tracing and restart the frontend server, then reload and select this element again. Connecting a source folder alone does not capture element bindings.'],unsupported_element:['No binding captured for this element','Tracing is running, but this element has no supported source binding. Check the adapter configuration or select a supported element.'],source_changed:['Source version changed','The captured source hash does not match the connected file. Restart the traced development app, reload it, and select the element again.'],invalid_trace:['Trace could not be validated','The captured binding could not be validated against this project. Check the connected source root and tracing setup, then reload and select the element again.']};
  const captureLimited=graph=>graph?.gaps?.some(gap=>typeof gap==='string'&&gap.startsWith('Backend trace exceeded its limit'))===true;
  function capturedPresentation(graph){
    const view=window.OrivoTraceView.model(graph,{scope:state.scope,expanded:state.expanded,collapsed:state.collapsed,maxColumns:3,showGaps:false});
    const kinds=new Set(view.nodes.map(node=>node.kind));
    const stage=['database','query','backend','api','source','element'].find(kind=>kinds.has(kind))||'element';
    const labels={database:'Captured through data origin',query:'Captured through SQL',backend:'Captured through backend',api:'Captured through API',source:'Captured through source',element:'Element selected'};
    return {...view,stage,label:captureLimited(graph)&&!['database','query'].includes(stage)?'Capture limit reached':labels[stage]};
  }
  function renderTraceReadiness(graph){
    const reason=readinessReasons[graph?.reason],frontend=graph?.coverage==='frontend',banner=$('trace-readiness'),presentation=capturedPresentation(graph);
    banner.hidden=!graph||graph.coverage==='complete';
    $('trace-coverage-details').open=false;
    if(banner.hidden)return;
    $('trace-readiness-title').textContent=graph.valueOrigin==='local'?'Local fallback captured':frontend?'Frontend source captured':presentation.label;
    const boundary={database:'Additional trace coverage needs verification.',query:'Response-to-column mapping is not connected.',backend:'Database tracing is not connected.',api:'Backend tracing is not connected.',source:'No request captured for this selection.',element:reason?.[0]||'Enable tracing to capture the source path.'};
    $('trace-readiness-reason').textContent=captureLimited(graph)?'Some runtime evidence exceeded the capture limit. See coverage details.':graph.valueOrigin==='local'?'The displayed value is generated in the frontend. Captured requests explain its lookup or branch inputs.':frontend?'No API or SQL dependency captured.':boundary[presentation.stage];
    const details=[...new Set([reason?.[1],...(Array.isArray(graph.gaps)?graph.gaps:[])].filter(value=>typeof value==='string'&&value.trim()))];
    if(frontend&&!details.length)details.push('Frontend-only binding; no captured API/SQL dependency.');
    const list=$('trace-coverage-reasons');list.replaceChildren();
    for(const value of details){const item=document.createElement('li');item.textContent=value;list.append(item);}
    if(!list.childElementCount){const item=document.createElement('li');item.textContent='Only the captured steps and their verified connections appear in the map.';list.append(item);}
    banner.classList.toggle('frontend-only',frontend);
    $('trace-reload').disabled=!api||!state.host.url||!!state.host.loading;
  }
  function setupSection(title){const section=document.createElement('section'),heading=document.createElement('h3');section.className='tracing-setup-section';heading.textContent=title;section.append(heading);$('tracing-setup-content').append(section);return section;}
  function setupParagraph(parent,value,className=''){const paragraph=document.createElement('p');paragraph.textContent=String(value);if(className)paragraph.className=className;parent.append(paragraph);return paragraph;}
  function setupInstructions(parent,items){const list=document.createElement('ol');for(const value of items){if(typeof value!=='string'||!value.trim())continue;const item=document.createElement('li');item.textContent=value;list.append(item);}if(list.childElementCount)parent.append(list);}
  function frontendDirectory(root,directory){const name=String(directory||'.');if(/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(name))return name;if(name==='.')return String(root||'');return String(root||'').replace(/[\\/]+$/,'')+'\\'+name.replaceAll('/','\\');}
  function setupCommand(row,root){const directory=frontendDirectory(root,row.directory),quoted=directory.replaceAll("'","''");return `Set-Location -LiteralPath '${quoted}'\n$env:${row.flag} = '1'\nnpm run dev`;}
  function renderGuidedSetup(setup,pending){
    if(!setup.canConfigure||!api?.previewTracingSetup)return;
    const saved=setup.guided||{},eligible=pending.filter(row=>row.guided);
    if(!saved.installed&&!eligible.length)return;
    const section=setupSection(saved.installed?'Tracing commands':'Configure this project'),output=document.createElement('div');
    output.className='guided-setup-output';output.setAttribute('aria-live','polite');
    function commands(result){
      for(const [directory,command] of [[result.frontend,result.command],[result.backendDirectory,result.backendCommand]]){
        if(!command)continue;
        const code=document.createElement('pre');code.className='tracing-setup-code';code.tabIndex=0;
        code.textContent=`Set-Location -LiteralPath '${frontendDirectory(setup.root,directory).replaceAll("'","''")}'\n${command}`;output.append(code);
      }
      if(result.backendCommand)setupParagraph(output,'Run the frontend and backend commands in separate terminals with your existing development environment. Keep the API proxy pointed at the traced backend.');
    }
    if(saved.installed){
      commands(saved);setupParagraph(output,'Restart the development servers using these commands, then reload and select an element.');
      const undo=document.createElement('button');undo.className='secondary-button';undo.id='guided-setup-undo';undo.textContent='Remove generated setup';
      undo.onclick=async()=>{undo.disabled=true;try{await api.undoTracingSetup();await loadTracingSetup();toast('Generated tracing setup removed.');}catch(error){toast(error.message,true);undo.disabled=false;}};
      section.append(output,undo);return;
    }
    setupParagraph(section,'Review a separate development configuration before applying it. Existing development scripts stay available; dependencies are not installed and servers are not started.');
    const form=document.createElement('form');form.className='guided-setup-form';
    function field(label,id,element){const wrapper=document.createElement('label');wrapper.className='product-label';wrapper.textContent=label;element.id=id;element.className='product-input';wrapper.htmlFor=id;wrapper.append(element);form.append(wrapper);return element;}
    const frontend=field('Frontend','guided-frontend',document.createElement('select'));
    for(const row of eligible){const option=document.createElement('option');option.value=row.directory;option.textContent=[row.framework,row.bundler,row.directory].join(' · ');frontend.append(option);}
    const backend=field('Python backend (optional)','guided-backend',document.createElement('select'));
    const none=document.createElement('option');none.value='';none.textContent='Configure frontend only';backend.append(none);
    for(const row of setup.backends.filter(row=>['FastAPI','Starlette'].includes(row.framework))){const option=document.createElement('option');option.value=row.directory;option.textContent=row.framework+' · '+row.directory;backend.append(option);}
    const backendFields=document.createElement('div');
    const app=field('Application object','guided-python-app',document.createElement('input'));app.placeholder='app.main:app';app.maxLength=180;
    const engine=field('SQLAlchemy engine (optional)','guided-python-engine',document.createElement('input'));engine.placeholder='app.database:engine';engine.maxLength=180;
    const sessions=field('Session factory (optional)','guided-python-sessions',document.createElement('input'));sessions.placeholder='app.database:SessionLocal';sessions.maxLength=180;
    for(const input of [app,engine,sessions])backendFields.append(input.parentElement);
    form.append(backendFields);backendFields.hidden=true;
    backend.onchange=()=>{backendFields.hidden=!backend.value;app.required=!!backend.value;};
    const preview=document.createElement('button');preview.type='submit';preview.id='guided-setup-preview';preview.className='secondary-button';preview.textContent='Preview setup changes';form.append(preview);
    let plan=null;
    form.addEventListener('input',()=>{plan=null;output.replaceChildren();});
    form.onsubmit=async event=>{
      event.preventDefault();preview.disabled=true;plan=null;output.replaceChildren();
      try{
        const options={frontend:frontend.value};if(backend.value)options.backend={directory:backend.value,app:app.value.trim(),engine:engine.value.trim(),sessions:sessions.value.trim()};
        const submitted=JSON.stringify(options),result=await api.previewTracingSetup(options);
        if(!section.isConnected||!$('tracing-setup-dialog').open)return;
        const current={frontend:frontend.value};if(backend.value)current.backend={directory:backend.value,app:app.value.trim(),engine:engine.value.trim(),sessions:sessions.value.trim()};
        if(JSON.stringify(current)!==submitted){setupParagraph(output,'Setup options changed. Preview the changes again.');return;}
        plan=result;setupParagraph(output,result.notice);
        for(const change of result.changes){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=change.path+' — '+change.detail;details.append(summary);if(change.diff){const code=document.createElement('pre');code.className='tracing-setup-code';code.textContent=change.diff;details.append(code);}output.append(details);}
        commands({...result,backendDirectory:backend.value});
        const apply=document.createElement('button');apply.id='guided-setup-apply';apply.type='button';apply.className='primary-button';apply.textContent='Apply reviewed setup';
        apply.onclick=async()=>{if(!plan)return;apply.disabled=true;preview.disabled=true;try{await api.applyTracingSetup(plan.id);await loadTracingSetup();toast('Development tracing configured. Restart both servers using the displayed commands.');}catch(error){toast(error.message,true);apply.disabled=false;}finally{preview.disabled=false;}};
        output.append(apply);
      }catch(error){setupParagraph(output,error.message);}finally{preview.disabled=false;}
    };
    section.append(form,output);
  }
  function renderBackendSetup(setup){
    const backends=(setup.backends||[]).filter(row=>['FastAPI','Starlette'].includes(row.framework));
    if(!setup.canConfigure||!api?.previewTracingSetup||!backends.length)return;
    const saved=setup.guided?.backend||{},section=setupSection(saved.installed?'Python backend tracing command':'Connect Python and database tracing'),output=document.createElement('div');
    output.className='guided-setup-output';output.setAttribute('aria-live','polite');
    const command=result=>{
      if(!result.backendCommand)return;
      const code=document.createElement('pre');code.className='tracing-setup-code';code.tabIndex=0;
      code.textContent=`Set-Location -LiteralPath '${frontendDirectory(setup.root,result.backendDirectory).replaceAll("'","''")}'\n${result.backendCommand}`;output.append(code);
      setupParagraph(output,'Restart the backend with this command in its existing Python environment. Point the frontend API proxy at this backend, reload the application, and select the element again.');
    };
    if(saved.installed){
      command(saved);const undo=document.createElement('button');undo.id='backend-setup-undo';undo.className='secondary-button';undo.textContent='Remove backend tracing setup';
      undo.onclick=async()=>{undo.disabled=true;try{await api.undoTracingSetup({backendOnly:true});await loadTracingSetup();toast('Backend tracing setup removed.');}catch(error){toast(error.message,true);undo.disabled=false;}};
      section.append(output,undo);return;
    }
    setupParagraph(section,'Frontend tracing captures the API call. Connect the running Python application and its SQLAlchemy engine/session factory to continue through executed PostgreSQL queries and response fields. This setup preserves the frontend configuration.');
    const form=document.createElement('form');form.className='guided-setup-form';
    const field=(label,id,element)=>{const wrapper=document.createElement('label');wrapper.className='product-label';wrapper.textContent=label;element.id=id;element.className='product-input';wrapper.htmlFor=id;wrapper.append(element);form.append(wrapper);return element;};
    const directory=field('Python backend folder','backend-setup-directory',document.createElement('select'));
    for(const row of backends){const option=document.createElement('option');option.value=row.directory;option.textContent=row.framework+' · '+row.directory;directory.append(option);}
    const app=field('Application module and object','backend-setup-app',document.createElement('input'));app.placeholder='your_package.main:create_app';app.required=true;app.maxLength=180;
    const factory=field('Call this object as an application factory','backend-setup-factory',document.createElement('input'));factory.type='checkbox';factory.checked=true;factory.className='setup-checkbox';
    const engine=field('SQLAlchemy engine','backend-setup-engine',document.createElement('input'));engine.placeholder='@app.state.database.engine or your_package.database:engine';engine.maxLength=180;
    const sessions=field('SQLAlchemy session factory','backend-setup-sessions',document.createElement('input'));sessions.placeholder='@app.state.database.session_factory or your_package.database:SessionLocal';sessions.maxLength=180;
    setupParagraph(form,'Use @app for an object on the created application. These references are resolved after its startup, so application factories and lifespan-created databases are supported.');
    const instrument=field('Track direct ORM field assignments into response objects','backend-setup-instrument',document.createElement('input'));instrument.type='checkbox';instrument.checked=true;instrument.className='setup-checkbox';
    setupParagraph(form,'Development instrumentation follows direct Python assignments such as Response(body=record.body). It does not edit application source files.');
    const preview=document.createElement('button');preview.type='submit';preview.id='backend-setup-preview';preview.className='secondary-button';preview.textContent='Preview backend setup';form.append(preview);
    let plan=null;
    const options=()=>({backendOnly:true,backend:{directory:directory.value,app:app.value.trim(),factory:factory.checked,engine:engine.value.trim(),sessions:sessions.value.trim(),instrument:instrument.checked}});
    form.addEventListener('input',()=>{plan=null;output.replaceChildren();});
    form.onsubmit=async event=>{event.preventDefault();preview.disabled=true;plan=null;output.replaceChildren();try{
      const submitted=JSON.stringify(options()),result=await api.previewTracingSetup(JSON.parse(submitted));
      if(!section.isConnected||!$('tracing-setup-dialog').open)return;
      if(JSON.stringify(options())!==submitted){setupParagraph(output,'Backend options changed. Preview the setup again.');return;}
      plan=result;setupParagraph(output,result.notice);
      for(const change of result.changes){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=change.path+' — '+change.detail;details.append(summary);if(change.diff){const code=document.createElement('pre');code.className='tracing-setup-code';code.textContent=change.diff;details.append(code);}output.append(details);}
      command(result);
      const apply=document.createElement('button');apply.type='button';apply.id='backend-setup-apply';apply.className='primary-button';apply.textContent='Apply reviewed backend setup';
      apply.onclick=async()=>{if(!plan)return;apply.disabled=true;preview.disabled=true;try{await api.applyTracingSetup(plan.id);await loadTracingSetup();toast('Backend tracing configured. Restart the backend with the displayed command.');}catch(error){toast(error.message,true);apply.disabled=false;}finally{preview.disabled=false;}};output.append(apply);
    }catch(error){setupParagraph(output,error.message);}finally{preview.disabled=false;}};
    section.append(form,output);
  }
  async function loadTracingSetup(){
    const ticket=++setupTicket,revision=state.host.contextRevision,content=$('tracing-setup-content');
    content.replaceChildren();$('tracing-setup-status').textContent='Checking this project…';$('tracing-setup-root').textContent=state.host.repository?.path||'No source folder connected';$('tracing-setup-url').textContent=state.host.url||'No application open';$('tracing-setup-export').disabled=!api?.exportKit;$('tracing-setup-reload').disabled=!api||!state.host.url||!!state.host.loading;
    if(!api?.getTracingSetup){$('tracing-setup-status').textContent='Open the desktop app and connect a source folder to inspect its tracing setup.';return;}
    try{
      const setup=await api.getTracingSetup();
      if(ticket!==setupTicket||!$('tracing-setup-dialog').open)return;
      if(revision!==state.host.contextRevision){$('tracing-setup-status').textContent='The connected project changed. Close and reopen tracing setup to inspect the current project.';return;}
      $('tracing-setup-root').textContent=setup.root||'No source folder connected';$('tracing-setup-url').textContent=setup.url||state.host.url||'No application open';
      const frontends=Array.isArray(setup.frontends)?setup.frontends:[],backends=Array.isArray(setup.backends)?setup.backends:[],configured=(Array.isArray(setup.existingTracing)?setup.existingTracing:[]).filter(row=>row&&typeof row==='object'),runtime=setup.runtime||{};
      $('tracing-setup-status').textContent=readinessReasons[runtime.status]?.[1]||readinessReasons[runtime.reason]?.[1]||(typeof runtime.reason==='string'&&!/^[a-z][a-z0-9_]*$/.test(runtime.reason)?runtime.reason:null)||(runtime.status==='captured'?'Frontend bindings are available. API and SQL connections are shown only when captured.':'Inspect the detected stack below, enable its development tracing, then restart the server.');
      if(frontends.length){const section=setupSection('Detected frontend');for(const frontend of frontends){const row=document.createElement('div');row.className='tracing-setup-detected';const name=document.createElement('strong');name.textContent=[frontend.framework,frontend.bundler,frontend.directory||'.'].filter(Boolean).join(' · ');row.append(name);if(frontend.reason)setupParagraph(row,frontend.reason);section.append(row);}}
      if(configured.length){const section=setupSection('Activate the existing tracing configuration');setupParagraph(section,'Tracing is already configured. Stop the frontend development server before enabling it. A server restart is required; reloading the page alone does not enable the flag.');for(const row of configured){const label=document.createElement('p');label.className='tracing-setup-config';label.textContent='Configuration: '+(row.configFile||row.directory||'.');section.append(label);if(['VITE_STUDIO_TRACE','STUDIO_TRACE'].includes(row.flag)){setupParagraph(section,'Run in PowerShell:');const code=document.createElement('pre');code.className='tracing-setup-code';code.tabIndex=0;code.textContent=setupCommand(row,setup.root);section.append(code);}else setupParagraph(section,'A tracing integration was found, but its activation flag could not be determined. Check this configuration for its development tracing switch, enable it, and restart the frontend server.');}setupParagraph(section,'Keep the existing integration. An additional adapter installation or duplicate plugin is not needed.','field-note');}
      const configuredDirectories=new Set(configured.map(row=>String(row.directory||'.'))),pending=frontends.filter(row=>!configuredDirectories.has(String(row.directory||'.')));
      renderGuidedSetup(setup,pending);
      renderBackendSetup(setup);
      const instructions=(Array.isArray(setup.instructions)?setup.instructions:[]).filter(instruction=>{
        if(typeof instruction!=='string')return false;
        if(configured.length&&!pending.length&&/^(?:Install |React\/Vite|Next\.js|Other browser stacks)/i.test(instruction))return false;
        if(/^React\/Vite/i.test(instruction))return pending.some(row=>row.bundler==='Vite'&&row.framework==='React');
        if(/^Next\.js/i.test(instruction))return pending.some(row=>row.bundler==='Next.js'||row.framework==='Next.js');
        if(/^Other browser stacks/i.test(instruction))return !frontends.length||pending.some(row=>!row.automatic);
        return true;
      });
      if(instructions.length){const section=setupSection(configured.length?'Next steps':'Add development tracing');if(!configured.length)setupParagraph(section,'Export the adapter kit and follow its README for this stack. Orivo will not install dependencies or edit the project.');setupInstructions(section,instructions);}
      if(backends.length){const section=setupSection('Backend evidence');for(const backend of backends)setupParagraph(section,[backend.framework,backend.directory||'.',backend.adapter].filter(Boolean).join(' · '));setupParagraph(section,'A detected backend does not establish an API or SQL connection. Those steps appear only after the running adapters capture the selected field.','field-note');}
      if(Array.isArray(setup.gaps)&&setup.gaps.length){const section=setupSection('Coverage notes');for(const gap of setup.gaps)if(typeof gap==='string')setupParagraph(section,gap);}
    }catch(error){if(ticket===setupTicket&&$('tracing-setup-dialog').open)$('tracing-setup-status').textContent='Tracing setup could not be inspected. '+(error.message||String(error));}
  }
  async function reloadForTracing(){if(!requireDesktop()||!state.host.url)return;const button=$('trace-reload'),revision=state.host.contextRevision;button.disabled=true;try{await api.refresh();if(revision===state.host.contextRevision){clearTrace();toast('Application reloaded. Select the element again to capture fresh evidence.');}}finally{button.disabled=!state.host.url||!!state.host.loading;}}
  async function loadWorkspaces(){const box=$('workspace-list');box.replaceChildren();let workspaces=[];try{if(api?.getWorkspaces)workspaces=await api.getWorkspaces();if(api?.getProductInfo){const info=await api.getProductInfo();if(info.storageWarning){const warning=document.createElement('p');warning.className='empty-small';warning.setAttribute('role','status');warning.textContent=info.storageWarning;box.append(warning);}}}catch(error){const p=document.createElement('p');p.className='empty-small';p.textContent='Recent projects could not be loaded. '+error.message;box.append(p);$('workspace-count').textContent='—';return;}if(!Array.isArray(workspaces))workspaces=[];$('workspace-count').textContent=String(workspaces.length);if(!workspaces.length){const p=document.createElement('p');p.className='empty-small';p.textContent='Connect and save your first project to return to it here.';box.append(p);return;}for(const workspace of workspaces){const row=document.createElement('div'),open=document.createElement('button'),name=document.createElement('strong'),url=document.createElement('small'),remove=document.createElement('button');row.className='workspace-entry';open.className='workspace-open';name.textContent=workspace.name||'Saved project';url.textContent=workspace.url||workspace.repositoryPath||'';open.title=[workspace.repositoryPath,workspace.url].filter(Boolean).join('\n');open.append(name,url);open.onclick=()=>run(async()=>{if(workspaceBusy||!api?.openWorkspace)return;workspaceBusy=true;open.disabled=true;closeDialog('welcome-dialog');try{await api.openWorkspace(workspace.id);await syncHost();toast('Project opened. Select an element to inspect its path.');}finally{workspaceBusy=false;open.disabled=false;}});remove.className='icon-button workspace-remove';remove.setAttribute('aria-label','Remove '+(workspace.name||'project')+' from recent projects');remove.title='Remove from recent projects';remove.innerHTML=icon('close');remove.onclick=()=>run(async()=>{if(!api?.removeWorkspace)return;await api.removeWorkspace(workspace.id);await loadWorkspaces();});row.append(open,remove);box.append(row);}}
  async function loadProductInfo(){if(!productInfo&&api?.getProductInfo){try{productInfo=await api.getProductInfo();}catch(error){$('about-version').textContent='Unavailable';$('diagnostics-status').textContent=error.message;}}const info=productInfo||{};$('about-version').textContent=info.version?info.version+' · Beta':'Developer preview';$('about-platform').textContent=[info.platform||'Windows',info.architecture].filter(Boolean).join(' · ');$('about-installation').textContent=info.packaged?'Standalone Windows desktop build':'Development build';$('about-data-directory').textContent=info.dataDirectory||'Available in the desktop application';$('export-diagnostics').disabled=!api?.exportDiagnostics||info.diagnosticsAvailable===false;if(Array.isArray(info.support)&&info.support.length){const box=$('about-support');box.replaceChildren();for(const adapter of info.support){const tag=document.createElement('span');tag.textContent=typeof adapter==='string'?adapter:adapter.name||adapter.label||adapter.id||'Adapter';box.append(tag);}}const upiId=info.supportPayment?.upiId;if(upiId&&window.OrivoUpiQr){$('upi-id').textContent=upiId;$('support-payment').hidden=false;const paymentUri='upi://pay?'+new URLSearchParams({pa:upiId,cu:'INR'}).toString();$('upi-qr').replaceChildren(window.OrivoUpiQr.render(paymentUri));}}
  function clearTrace(){stopPlayback();stopGraphDrag();$('trace-readiness').hidden=true;state.graph=null;state.lastLiveGraph=null;state.presentation=null;state.expanded.clear();state.collapsed.clear();$('export-button').disabled=false;$('refresh-trace').disabled=false;window.dispatchEvent(new CustomEvent('trace-atlas:graph',{detail:null}));resetGraphView();state.selected=null;state.history=[];state.sourceTicket++;state.currentCode='';$('graph-stage').hidden=true;$('graph-empty').hidden=false;$('trace-graph').replaceChildren();$('trace-history').replaceChildren();$('trace-count').textContent='0';$('selected-label').textContent='Select an element to begin';$('selected-selector').textContent='No element selected';$('selection-value').textContent='';$('file-count').textContent='0';$('file-list').replaceChildren();$('request-list').replaceChildren();$('trace-id').textContent='READY TO EXPLORE';$('coverage-badge').className='coverage-badge unavailable';$('coverage-badge').textContent='Awaiting selection';$('capture-time').textContent='Choose any visible element';$('detail-kind').textContent='EXPLORER';$('detail-name').textContent='The details are in the connections.';$('code-path').textContent='Select a step in the map';$('code-content').replaceChildren();$('node-metadata').replaceChildren();$('node-description').textContent='Capture a new element in this application to inspect its evidence.';renderComponentPath(null);$('footer-stats').textContent='LOCAL-FIRST EXPLORATION · v0.1';}
  function selection(next){if(next.cancelled)return;stopPlayback();$('selected-label').textContent=next.label||next.tag||'Selected element';$('selected-selector').textContent=next.selector||'';$('selection-tag').textContent=(next.tag||'ELEMENT').toUpperCase();$('selection-value').textContent='';}
  const ns='http://www.w3.org/2000/svg';
  function svg(tag,attrs={},parent){const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(parent)parent.append(e);return e;}
  function text(parent,x,y,value,cls,extra={}){const e=svg('text',{x,y,class:cls,...extra},parent);e.textContent=value??'';return e;}
  function truncate(value,max=30){const s=String(value??'');return s.length>max?s.slice(0,max-1)+'…':s;}
  function queryExecutions(node){return node.kind==='query'?Math.max(1,Number(node.meta?.executionCount)||1):0;}
  function nodeTitle(node){const executions=queryExecutions(node);return executions>1?`${node.label} ×${executions}`:node.label;}
  function drawGraph(){
    const graph=state.graph,root=$('trace-graph');root.replaceChildren();if(!graph)return;
    const view=capturedPresentation(graph);state.presentation=view;
    const summary=graph.summary||{};$('footer-stats').textContent=`${view.nodes.length} VISIBLE STEPS · ${count(summary.requests)} REQUEST${count(summary.requests)===1?'':'S'} · ${count(summary.queries)} ${count(summary.queries)===1?'QUERY':'QUERIES'}`;
    const positions=view.positions;root.setAttribute('viewBox',`0 0 ${view.width} ${view.height}`);
    const defs=svg('defs',{},root),marker=svg('marker',{id:'arrowhead',viewBox:'0 0 8 8',refX:7,refY:4,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'},defs);
    svg('path',{d:'M1 1 7 4 1 7',fill:'none',stroke:'var(--edge)','stroke-width':1.1},marker);
    for(const lane of view.lanes||[])text(root,lane.x,lane.y,lane.label,'graph-lane-label');
    for(const route of view.routes){
      const edge=route.edge;svg('path',{id:'edge-'+edge.id,d:route.d,class:'edge-line'+(edge.relation==='execution-member'?' execution-member':''),'marker-end':'url(#arrowhead)','data-edge':edge.id},root);
      const label=truncate(edge.label||'',22),lx=route.labelX,ly=route.labelY;
      if(label){svg('rect',{x:lx-label.length*2.1-5,y:ly-9,width:label.length*4.2+10,height:13,rx:3,class:'edge-label-bg'},root);text(root,lx,ly,label,'edge-label',{'text-anchor':'middle'});}
    }
    for(const p of positions){
      const n=p.node,c=nodeColors(n),g=svg('g',{class:'graph-node'+(n.viewType==='execution'?' execution-node':''),'data-node':n.id,role:'button',tabindex:0,'aria-label':c[3]+': '+nodeTitle(n),'aria-pressed':'false',style:`--node-color:${c[0]};--node-soft:${c[1]};--step:${p.i}`},root);
      const title=svg('title',{},g);title.textContent=[nodeTitle(n),n.detail].filter(Boolean).join('\n');
      svg('rect',{x:p.x,y:p.y,width:p.w,height:p.h,rx:10,class:'node-card'},g);
      svg('rect',{x:p.x+14,y:p.y+14,width:26,height:26,rx:7,class:'node-icon-bg'},g);
      const glyph=svg('svg',{x:p.x+20,y:p.y+20,width:14,height:14,viewBox:'0 0 24 24',class:'node-icon'},g);svg('path',{d:paths[c[2]],'stroke-linecap':'round','stroke-linejoin':'round'},glyph);
      text(g,p.x+49,p.y+30,c[3],'node-kind');text(g,p.x+p.w-15,p.y+30,String(p.i+1).padStart(2,'0'),'node-step',{'text-anchor':'end'});
      text(g,p.x+16,p.y+62,truncate(nodeTitle(n),29),'node-title');
      text(g,p.x+16,p.y+80,truncate(n.file?`${n.file}${n.line?':'+n.line:''}`:n.subtitle,39),'node-subtitle');
      svg('line',{x1:p.x+15,y1:p.y+91,x2:p.x+p.w-15,y2:p.y+91,class:'node-footer-line'},g);svg('circle',{cx:p.x+18,cy:p.y+105,r:2.2,class:'node-indicator'},g);
      const duration=typeof n.meta?.durationMs==='number'?` · ${n.meta.durationMs.toFixed(1)} ms`:'';
      const measured=n.meta?.measuredCount,timingCoverage=Number.isInteger(measured)&&measured<queryExecutions(n)?` · ${measured}/${queryExecutions(n)} timed`:'';
      const footer=n.view?.collapsed?`${n.view.hiddenDescendants} steps folded`:queryExecutions(n)>1?`${queryExecutions(n)} executions${timingCoverage}${duration}`:n.viewType==='execution'?(n.meta.executionId+duration):(n.subtitle||'Runtime evidence captured');
      text(g,p.x+25,p.y+108,truncate(footer,35),'node-description');
      g.addEventListener('click',()=>selectNode(n.id));g.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectNode(n.id);}});
    }
    stopGraphDrag();state.graphWidth=view.width;state.graphHeight=view.height;resetGraphView();
    window.dispatchEvent(new CustomEvent('trace-atlas:presentation',{detail:{...view,scope:state.scope,expanded:[...state.expanded],collapsed:[...state.collapsed]}}));
  }
  function count(value){return Array.isArray(value)?value.length:Number(value)||0;}
  function renderComponentPath(graph){
    const panel=$('react-component-path'),list=$('react-component-list'),note=$('react-component-note');list.replaceChildren();
    const frames=(Array.isArray(graph?.hierarchy?.frames)?graph.hierarchy.frames:[]).filter(frame=>frame?.kind==='component').slice(-16);
    if(!frames.length){panel.hidden=true;return;}
    panel.hidden=false;
    for(const frame of frames){
      const item=document.createElement('li'),name=document.createElement('span'),source=document.createElement('span');name.className='component-name';name.textContent=frame.component||'Anonymous';
      if(frame.path&&Number.isInteger(frame.line)){
        const button=document.createElement('button');button.type='button';button.className='component-source';
        source.className='component-location';source.textContent=`${frame.path.split('/').at(-1)}:${frame.line}`;
        button.title=`Open ${frame.path}:${frame.line}`;button.append(name,source);
        button.addEventListener('click',()=>{list.querySelectorAll('.component-source').forEach(row=>row.removeAttribute('aria-current'));button.setAttribute('aria-current','true');window.dispatchEvent(new CustomEvent('trace-atlas:inspector',{detail:'source'}));inspectComponentSource(frame);});item.append(button);
      }else{source.className='component-source-unavailable';source.textContent=frame.note||'Source location unavailable';item.append(name,source);item.className='component-unavailable';}
      list.append(item);
    }
    note.textContent=graph.hierarchy?.note||'Component ancestry comes from runtime React metadata. Unresolved source locations are not inferred.';
  }
  async function inspectComponentSource(frame){
    if(!api?.readSource||!frame?.path||!Number.isInteger(frame.line))return;
    const ticket=++state.sourceTicket;
    try{
      const source=await api.readSource({path:frame.path,line:frame.line});if(ticket!==state.sourceTicket||source?.code===undefined)return;
      $('detail-kind').textContent='REACT COMPONENT';$('detail-name').textContent=frame.component||'React component';$('node-description').textContent='Runtime React ancestry matched this component to a source file in the connected project.';
      $('code-path').textContent=`${frame.path}:${frame.line}`;$('code-language').textContent=frame.path.match(/\.tsx?$/i)?'TYPESCRIPT':'JAVASCRIPT';renderCode(source.code,source.startLine||1,frame.line);
      document.querySelector('[data-inspector=source]').focus({preventScroll:true});
    }catch(error){if(ticket===state.sourceTicket)renderCode('Component source unavailable: '+(error.message||String(error)),1);}
  }
  function receiveTrace(graph){
    if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return;
    stopPlayback();state.expanded.clear();state.collapsed.clear();state.graph=graph;renderTraceReadiness(graph);
    state.history=[graph,...state.history.filter(item=>item.id!==graph.id)].slice(0,20);
    $('graph-empty').hidden=true;$('graph-stage').hidden=false;$('selected-label').textContent=graph.title||'Selected element';$('selected-selector').textContent=graph.selector||'';
    $('selection-tag').textContent=graph.mode==='data'?'DATA':String(graph.mode||'ELEMENT').toUpperCase();
    const coverage=graph.coverage||'partial',view=capturedPresentation(graph),readOnly=!!graph.snapshot?.readOnly;
    if(!readOnly)state.lastLiveGraph=graph;
    $('coverage-badge').className='coverage-badge '+coverage;$('coverage-badge').replaceChildren();
    const dot=document.createElement('i');$('coverage-badge').append(dot,document.createTextNode(graph.valueOrigin==='local'?'Local fallback captured':graph.valueOrigin==='collection'?'Collection flow captured':coverage==='complete'?'Element to column captured':coverage==='frontend'?'Frontend captured':view.label));
    $('trace-id').textContent='TRC–'+String(graph.id||'').replace(/[^a-z0-9]/ig,'').slice(-6).toUpperCase();
    const date=new Date(graph.capturedAt||Date.now());$('capture-time').textContent=(readOnly?'Saved capture · ':'Captured ')+date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    $('file-count').textContent=new Set(graph.nodes.map(node=>node.file).filter(Boolean)).size;
    $('footer-status').textContent=readOnly?'Saved snapshot · read only':graph.valueOrigin==='local'?'Local fallback · source versions matched':graph.valueOrigin==='collection'?'Captured collection flow · source versions matched':coverage==='complete'?'Captured path · source versions matched':view.label+' · view coverage details';
    $('export-button').disabled=readOnly;$('refresh-trace').disabled=readOnly;
    drawGraph();renderLists();renderHistory();renderComponentPath(graph);
    const initial=view.nodes.find(node=>node.kind==='source')||view.nodes[0];if(initial)selectNode(initial.id);
    window.dispatchEvent(new CustomEvent('trace-atlas:graph',{detail:graph}));
    if(initial)window.dispatchEvent(new CustomEvent('trace-atlas:node',{detail:initial}));
  }
  function renderHistory(){const box=$('trace-history');box.replaceChildren();$('trace-count').textContent=state.history.length;for(const g of state.history){const b=document.createElement('button');b.className='history-item'+(g.id===state.graph?.id?' active':'');const i=document.createElement('i'),label=document.createElement('span'),end=document.createElement('small');label.textContent=g.title||'Selected element';end.textContent=capturedPresentation(g).nodes.length+' steps';b.append(i,label,end);b.addEventListener('click',()=>receiveTrace(g));box.append(b);}}
  function renderLists(){
    const graph=state.graph,models=graph?.nodes.filter(node=>node.kind==='model'&&node.file)||[];
    const modelKey=node=>JSON.stringify([node.meta?.model||node.label,node.meta?.modelSource?.path||node.file,node.meta?.modelSource?.line||node.line]);
    const modelNodes=[...new Map(models.map(node=>[modelKey(node),node])).values()];
    $('model-count').textContent=modelNodes.length;
    for(const scope of ['all','models'])$('files-'+scope).setAttribute('aria-pressed',String(state.filesScope===scope));
    for(const [id,nodes]of [['file-list',state.filesScope==='models'?modelNodes:graph?.nodes.filter(node=>node.file)||[]],['request-list',graph?.nodes.filter(node=>['api','query','backend'].includes(node.kind))||[]]]){
      const box=$(id);box.replaceChildren();
      const unique=id==='file-list'&&state.filesScope==='all'?[...new Map(nodes.map(node=>[node.file,node])).values()]:nodes;
      if(!unique.length){const p=document.createElement('p');p.className='empty-small';p.textContent=id==='file-list'?(state.filesScope==='models'?'No verified ORM model classes were captured for this selection.':'No source files captured for this selection.'):'No request or query evidence was captured.';box.append(p);}
      for(const node of unique){const b=document.createElement('button');b.className='file-row';b.dataset.node=node.id;const ico=document.createElement('span');ico.innerHTML=icon(colors[node.kind]?.[2]||'code');const name=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),end=document.createElement('span');strong.textContent=nodeTitle(node);small.textContent=node.file||node.subtitle||node.detail;name.append(strong,small);end.className='file-row-end';end.textContent=(queryExecutions(node)>1?`×${queryExecutions(node)} · `:'')+(node.line?'L'+node.line:node.status==='missing'?'Missing':'Captured');b.append(ico,name,end);b.addEventListener('click',()=>selectNode(node.id));box.append(b);}
    }
  }
  for(const scope of ['all','models'])$('files-'+scope).onclick=()=>{state.filesScope=scope;renderLists();};
  window.addEventListener('trace-atlas:graph',event=>{if(!event.detail)renderLists();});
  function selectNode(id){
    const n=state.presentation?.nodes.find(node=>node.id===id)||state.graph?.nodes.find(node=>node.id===id);if(!n)return;
    state.selected=n;document.querySelectorAll('[data-node]').forEach(el=>{const yes=el.dataset.node===id;el.classList.toggle('selected',yes);el.classList.toggle('active',yes&&el.classList.contains('file-row'));if(el.classList.contains('graph-node'))el.setAttribute('aria-pressed',String(yes));});
    const color=nodeColors(n);$('detail-kind').textContent=color[3];$('detail-name').textContent=nodeTitle(n);$('node-description').textContent=n.detail||n.subtitle||'Captured runtime information.';
    $('code-path').textContent=n.file?(n.file+(n.line?':'+n.line:'')):n.kind==='query'?'Executed SQL':n.kind==='database'?'Captured field origin':n.kind==='api'?'Captured request':'Runtime selection';
    $('code-language').textContent=n.kind==='query'||n.file?.endsWith('.sql')?'SQL':n.file?.endsWith('.py')?'PYTHON':n.file?.match(/\.(?:[cm]?js|tsx?)$/)?'JAVASCRIPT':'EVIDENCE';
    const metadata={...(n.meta||{})};if(n.status)metadata.status=n.status;if(n.file)metadata.file=n.file;if(n.line)metadata.line=n.line;
    const dl=$('node-metadata');dl.replaceChildren();for(const [key,value]of Object.entries(metadata).slice(0,18)){if(value==null)continue;dl.append(Object.assign(document.createElement('dt'),{textContent:key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ')}),Object.assign(document.createElement('dd'),{textContent:typeof value==='object'?JSON.stringify(value):String(value)}));}
    const readOnly=!!state.graph?.snapshot?.readOnly;
    $('evidence-state').querySelector('span:last-child').textContent=readOnly?'Saved evidence · read only':n.status==='missing'?'This connection is not established':'Captured evidence · source read only';
    setIcon($('evidence-state').querySelector('[data-icon]'),n.status==='missing'?'warning':'shield');
    window.dispatchEvent(new CustomEvent('trace-atlas:node',{detail:n}));
    renderCode(n.code||nodeEvidence(n),n.kind==='query'?1:n.startLine||n.line||1,n.kind==='query'?0:n.line||0);
    const ticket=++state.sourceTicket;
    if(n.file&&api&&n.kind!=='query'&&!readOnly)api.readSource({path:n.file,line:n.line||1}).then(source=>{if(ticket!==state.sourceTicket)return;if(source?.code!==undefined)renderCode(source.code,source.startLine||1,n.line||0);}).catch(error=>{if(ticket!==state.sourceTicket)return;renderCode('Source unavailable: '+error.message,1,0);});
  }
  function nodeEvidence(n){if(n.kind==='gap')return (state.graph.gaps||[n.detail]).join('\n\n');if(n.kind==='element')return `${state.graph.selector}\n\n${n.detail||''}`;if(n.kind==='database'){const query=state.graph.nodes.find(x=>x.kind==='query');return [n.label,n.subtitle,query?.code].filter(Boolean).join('\n\n');}return JSON.stringify(n.meta||{detail:n.detail},null,2);}
  const tokenRe=/(\/\/[^\n]*|#[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|async|await|return|function|for|if|else|import|from|export|new|try|catch|throw|class|def|with|as|SELECT|FROM|WHERE|ORDER|BY|INSERT|INTO|VALUES|UPDATE|SET|JOIN|ON|AS|LIMIT|CREATE|TABLE|INTEGER|TEXT|REAL)\b|\b\d+(?:\.\d+)?\b)/g;
  function renderCode(code,startLine=1,highlight=0){const box=$('code-content');box.replaceChildren();state.currentCode=String(code||'No code captured.');for(const [i,line]of state.currentCode.split('\n').entries()){const row=document.createElement('div');row.className='code-line'+(startLine+i===highlight?' highlight':'');const number=document.createElement('span'),txt=document.createElement('span');number.className='line-number';number.textContent=startLine+i;txt.className='line-text';let cursor=0;tokenRe.lastIndex=0;for(const m of line.matchAll(tokenRe)){txt.append(document.createTextNode(line.slice(cursor,m.index)));const token=document.createElement('span');token.className=/^(\/\/|#)/.test(m[0])?'token-comment':/^["'`]/.test(m[0])?'token-string':/^\d/.test(m[0])?'token-number':'token-keyword';token.textContent=m[0];txt.append(token);cursor=m.index+m[0].length;}txt.append(document.createTextNode(line.slice(cursor)));row.append(number,txt);box.append(row);}}
  function switchView(view){if(state.host.previewMaximized)requestPreviewMaximized(false);state.view=view;document.querySelectorAll('[data-view]').forEach(b=>{const selected=b.dataset.view===view;b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});for(const name of ['map','files','requests','project'])$(name+'-view').hidden=name!==view;if(view==='project')window.OrivoProjectMap?.open();}
  const minGraphZoom=.25,maxGraphZoom=10;
  function applyZoom(){
    $('trace-graph').setAttribute('viewBox',`${state.panX} ${state.panY} ${state.graphWidth/state.zoom} ${state.graphHeight/state.zoom}`);
    $('zoom-value').textContent=Math.round(state.zoom*100)+'%';
    $('zoom-in').disabled=!state.graph||state.zoom>=maxGraphZoom;
    $('zoom-out').disabled=!state.graph||state.zoom<=minGraphZoom;
    $('zoom-value').disabled=$('zoom-fit').disabled=!state.graph;
  }
  function resetGraphView(){state.zoom=1;state.panX=0;state.panY=0;applyZoom();}
  function zoomGraph(next,anchor){
    if(!state.graph)return;
    const zoom=Math.max(minGraphZoom,Math.min(maxGraphZoom,next)),ratio=state.zoom/zoom;
    const point=anchor||{x:state.panX+state.graphWidth/state.zoom/2,y:state.panY+state.graphHeight/state.zoom/2};
    state.panX=point.x-(point.x-state.panX)*ratio;state.panY=point.y-(point.y-state.panY)*ratio;
    state.zoom=zoom;applyZoom();
  }
  function graphPoint(clientX,clientY){const matrix=$('trace-graph').getScreenCTM();return matrix?new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse()):null;}
  const graphCanvas=$('graph-canvas');
  graphCanvas.addEventListener('wheel',event=>{
    if(!state.graph||!event.deltaY)return;
    const point=graphPoint(event.clientX,event.clientY);if(!point)return;
    event.preventDefault();
    const unit=event.deltaMode===1?16:event.deltaMode===2?graphCanvas.clientHeight:1;
    zoomGraph(state.zoom*Math.exp(-Math.max(-600,Math.min(600,event.deltaY*unit))*(event.ctrlKey ? .006 : .0015)),point);
  },{passive:false});
  graphCanvas.addEventListener('keydown',event=>{
    if(!state.graph||event.ctrlKey||event.metaKey||event.altKey)return;
    if(['+','=','-','0'].includes(event.key)){
      event.preventDefault();event.stopPropagation();
      if(event.key==='0')resetGraphView();else zoomGraph(state.zoom*(event.key==='-'?1/1.25:1.25));
    }
  });
  let graphDrag=null,suppressGraphClick=false;
  graphCanvas.addEventListener('pointerdown',event=>{
    if(!state.graph||event.button!==0||event.target.closest('.zoom-controls'))return;
    const matrix=$('trace-graph').getScreenCTM();if(!matrix)return;
    suppressGraphClick=false;
    graphDrag={id:event.pointerId,x:event.clientX,y:event.clientY,panX:state.panX,panY:state.panY,inverse:matrix.inverse(),moving:false};
    if(!event.target.closest('.graph-node'))graphCanvas.focus({preventScroll:true});
  });
  window.addEventListener('pointermove',event=>{
    const drag=graphDrag;if(!drag||event.pointerId!==drag.id)return;
    if(!drag.moving&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
    if(!drag.moving){drag.moving=true;suppressGraphClick=true;graphCanvas.classList.add('panning');graphCanvas.setPointerCapture(event.pointerId);}
    event.preventDefault();
    const start=new DOMPoint(drag.x,drag.y).matrixTransform(drag.inverse),point=new DOMPoint(event.clientX,event.clientY).matrixTransform(drag.inverse);
    state.panX=drag.panX-(point.x-start.x);state.panY=drag.panY-(point.y-start.y);applyZoom();
  });
  function stopGraphDrag(){
    const drag=graphDrag;graphDrag=null;graphCanvas.classList.remove('panning');
    if(drag&&graphCanvas.hasPointerCapture(drag.id))graphCanvas.releasePointerCapture(drag.id);
    setTimeout(()=>{suppressGraphClick=false;},0);
  }
  window.addEventListener('pointerup',event=>{if(graphDrag?.id===event.pointerId)stopGraphDrag();});
  window.addEventListener('pointercancel',event=>{if(graphDrag?.id===event.pointerId)stopGraphDrag();});
  window.addEventListener('blur',stopGraphDrag);
  graphCanvas.addEventListener('click',event=>{if(suppressGraphClick){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  function stopPlayback(){for(const timer of state.timers)clearTimeout(timer);state.timers=[];state.playing=false;$('play-trace').setAttribute('aria-pressed','false');$('play-trace').querySelector('span:last-child').textContent='Follow path';setIcon($('play-trace').querySelector('[data-icon]'),'play');document.querySelectorAll('.playing,.edge-line.active,.edge-point').forEach(el=>{if(el.classList.contains('edge-point'))el.remove();else el.classList.remove('playing','active');});}
  function playTrace(){if(state.playing){stopPlayback();return;}if(!state.graph){toast('Select an element to capture its path first.');return;}const presentation=capturedPresentation(state.graph);switchView('map');if(reduced.matches){state.playing=true;$('play-trace').setAttribute('aria-pressed','true');$('play-trace').querySelector('span:last-child').textContent='Clear path';presentation.nodes.forEach(n=>{document.querySelector(`.graph-node[data-node="${CSS.escape(n.id)}"]`)?.classList.add('playing');});toast('Captured steps highlighted. Motion is reduced in your system settings.');return;}state.playing=true;$('play-trace').setAttribute('aria-pressed','true');$('play-trace').querySelector('span:last-child').textContent='Pause';setIcon($('play-trace').querySelector('[data-icon]'),'pause');presentation.nodes.forEach((node,i)=>{state.timers.push(setTimeout(()=>{if(!state.playing)return;document.querySelectorAll('.graph-node.playing').forEach(el=>el.classList.remove('playing'));document.querySelector(`.graph-node[data-node="${CSS.escape(node.id)}"]`)?.classList.add('playing');selectNode(node.id);if(i){const edge=presentation.edges.find(e=>e.from===presentation.nodes[i-1].id&&e.to===node.id);const path=edge&&document.getElementById('edge-'+edge.id);if(path){path.classList.add('active');const point=svg('circle',{r:3,class:'edge-point'},$('trace-graph'));const motion=svg('animateMotion',{dur:'.5s',path:path.getAttribute('d'),fill:'freeze'},point);motion.beginElement?.();state.timers.push(setTimeout(()=>point.remove(),550));}}},i*850));});state.timers.push(setTimeout(stopPlayback,presentation.nodes.length*850+350));}
  let boundFrame;
  function scheduleBounds(){if(boundFrame)return;boundFrame=requestAnimationFrame(()=>{boundFrame=null;reportBounds();});}
  function reportBounds(){if(!api)return;const node=$('preview-surface'),rect=node.getBoundingClientRect(),clip=$('app-sidebar').getBoundingClientRect(),contained=rect.top>=Math.max(0,clip.top)-1&&rect.bottom<=Math.min(innerHeight,clip.bottom)+1&&rect.left>=Math.max(0,clip.left)-1&&rect.right<=Math.min(innerWidth,clip.right)+1,visible=!!state.host.url&&contained&&!openingDialogs&&!document.querySelector('dialog[open]')&&rect.width>10&&rect.height>10&&getComputedStyle($('app-sidebar')).display!=='none';api.setPreviewBounds({x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height),visible}).catch(()=>{});}
  window.addEventListener('resize',scheduleBounds);window.addEventListener('scroll',scheduleBounds,true);new ResizeObserver(scheduleBounds).observe($('preview-surface'));
  let resizeFrameRevision=0;
  window.addEventListener('trace-atlas:preview-resizing',event=>{
    if(!api||typeof event.detail!=='boolean')return;
    const resizing=event.detail,revision=++resizeFrameRevision,frame=$('preview-resize-frame');
    if(resizing){
      document.body.classList.add('preview-resizing');
      api.setPreviewResizing(true).then(data=>{if(revision===resizeFrameRevision&&data){frame.src=data;frame.hidden=false;}}).catch(()=>{});
    }else{
      reportBounds();
      api.setPreviewResizing(false).finally(()=>{if(revision===resizeFrameRevision){document.body.classList.remove('preview-resizing');frame.hidden=true;frame.removeAttribute('src');}}).catch(()=>{});
    }
  });
  $('url-form').addEventListener('submit',e=>{e.preventDefault();if(requireDesktop())run(()=>api.openApp($('app-url').value.trim()));});
  const connect=()=>{if(requireDesktop())return run(async()=>{const result=await api.connectRepository();await syncHost();if(result)toast('Source folder connected. Open your running application to continue.');return result;});};
  $('connect-top').onclick=() => openDialog('connections-dialog');$('connect-repo').onclick=connect;$('nav-connections').onclick=()=>openDialog('connections-dialog');$('dialog-connect').onclick=()=>run(async()=>{await connect();$('project-url').focus();});$('dialog-url-focus').onclick=()=>{closeDialog('connections-dialog');$('app-url').focus();scheduleBounds();};$('nav-guide').onclick=()=>openDialog('guide-dialog');$('nav-traces').onclick=()=>switchView('map');$('nav-history').onclick=async()=>{if(!state.history.length){toast('Capture an element to start your trace history.');return;}if(state.host.previewMaximized)await requestPreviewMaximized(false);$('preview-details').open=true;window.dispatchEvent(new Event('resize'));requestAnimationFrame(()=>{const content=$('preview-details').querySelector('.preview-details-content');content.scrollTop+=$('trace-history').getBoundingClientRect().top-content.getBoundingClientRect().top;scheduleBounds();});};
  const openDemo=()=>{if(requireDesktop())return run(()=>api.openDemo());};const openBrokenDemo=()=>{if(requireDesktop())return run(()=>api.openBrokenDemo());};$('load-demo').onclick=openDemo;$('empty-demo').onclick=openDemo;
  $('nav-home').onclick=()=>openDialog('welcome-dialog');document.querySelector('.brand-mark').onclick=event=>{event.preventDefault();openDialog('welcome-dialog');};$('nav-about').onclick=()=>openDialog('about-dialog');
  $('welcome-open').onclick=()=>{closeDialog('welcome-dialog');openDialog('connections-dialog');};$('welcome-demo').onclick=()=>{closeDialog('welcome-dialog');openDemo();};$('welcome-broken-demo').hidden=false;$('welcome-demo').after($('welcome-broken-demo'));$('welcome-broken-demo').onclick=()=>{closeDialog('welcome-dialog');openBrokenDemo();};
  $('welcome-guide').onclick=()=>{closeDialog('welcome-dialog');openDialog('guide-dialog');};$('project-guide').onclick=()=>{closeDialog('connections-dialog');openDialog('guide-dialog');};
  $('project-url').addEventListener('input',updateProjectStatus);
  $('project-open-form').onsubmit=event=>{event.preventDefault();if(!requireDesktop())return;run(async()=>{const button=$('project-open-button');button.disabled=true;try{await api.openApp($('project-url').value.trim());await syncHost();toast('Application opened. Save the project, then continue to the workspace.');}finally{updateProjectStatus();}});};
  $('save-workspace').onclick=()=>run(async()=>{if(!api?.saveWorkspace||workspaceBusy)return;workspaceBusy=true;let saved=false;updateProjectStatus();try{await api.saveWorkspace({name:$('project-workspace-name').value.trim(),url:state.host.url});saved=true;toast('Project saved to Recent projects.');}finally{workspaceBusy=false;updateProjectStatus();if(saved)$('project-save-status').textContent='Project saved. Reopen it from Projects in the activity bar.';}});
  $('export-diagnostics').onclick=()=>run(async()=>{if(!api?.exportDiagnostics)return;const button=$('export-diagnostics');button.disabled=true;try{const result=await api.exportDiagnostics();$('diagnostics-status').textContent=result?'Diagnostic report saved locally. Review the report before sharing it.':'Export cancelled.';}finally{button.disabled=false;}});
  $('copy-upi-id').onclick=()=>run(async()=>{await navigator.clipboard.writeText($('upi-id').textContent);$('upi-copy-status').textContent='UPI ID copied. Open your UPI app to choose an amount and pay.';});
  $('inspect-button').onclick=()=>{if(requireDesktop())run(()=>api.inspect());};$('reload-app').onclick=()=>{if(requireDesktop())run(()=>api.refresh());};$('refresh-trace').onclick=()=>{if(requireDesktop()){if(state.graph?.selector){const selector=state.graph.selector;run(async()=>{await api.refreshSource();await api.capture(selector);});}else toast('Select an element first.');}};
  $('export-button').onclick=()=>{if(!state.graph){toast('Capture a trace before exporting.');return;}if(requireDesktop())run(()=>api.exportTrace(state.graph.id)).then(value=>{if(value)toast('Trace exported.');});};
  $('export-kit').onclick=()=>{if(requireDesktop())run(()=>api.exportKit()).then(value=>{if(value)toast('Adapter kit exported. Follow its README to enable capture.');});};
  $('trace-setup').onclick=()=>openDialog('tracing-setup-dialog');
  $('project-tracing-setup').onclick=()=>{closeDialog('connections-dialog');openDialog('tracing-setup-dialog');};
  $('trace-reload').onclick=()=>run(reloadForTracing);
  $('tracing-setup-reload').onclick=()=>{closeDialog('tracing-setup-dialog');run(reloadForTracing);};
  $('tracing-setup-back').onclick=()=>closeDialog('tracing-setup-dialog');
  $('tracing-setup-export').onclick=()=>{if(requireDesktop())run(()=>api.exportKit()).then(value=>{if(value)toast('Adapter kit exported. Follow its README for your detected stack.');});};
  $('copy-code').onclick=()=>run(async()=>{if(!state.currentCode){toast('Select a trace step first.');return;}await navigator.clipboard.writeText(state.currentCode);toast('Copied to clipboard.');});
  $('toggle-detail').onclick=()=>{const panel=$('detail-body').closest('section'),collapsed=panel.classList.toggle('detail-collapsed');$('toggle-detail').setAttribute('aria-expanded',String(!collapsed));};
  document.querySelectorAll('[data-view]').forEach(b=>{b.onclick=()=>switchView(b.dataset.view);b.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-view]')],i=tabs.indexOf(b),next=tabs[(i+(event.key==='ArrowRight'?1:2))%tabs.length];switchView(next.dataset.view);next.focus();});});
  $('play-trace').onclick=playTrace;$('zoom-in').onclick=()=>zoomGraph(state.zoom*1.25);$('zoom-out').onclick=()=>zoomGraph(state.zoom/1.25);$('zoom-fit').onclick=$('zoom-value').onclick=resetGraphView;
  applyZoom();
  function applyPreviewLayout(expanded){
    const sidebar=$('app-sidebar'),changed=document.body.classList.contains('preview-maximized')!==expanded;
    if(changed)window.dispatchEvent(new Event('trace-atlas:cancel-panel-resize'));
    if(changed&&expanded){previewScroll=sidebar.scrollTop;window.dispatchEvent(new CustomEvent('trace-atlas:explorer',{detail:'app'}));}
    document.body.classList.toggle('preview-maximized',expanded);
    $('expand-preview').setAttribute('aria-pressed',String(expanded));
    $('expand-preview').title=expanded?'Restore application preview (Escape)':'Maximize application preview';
    $('expand-preview').setAttribute('aria-label',$('expand-preview').title);
    $('preview-panel-title').textContent=expanded?'APPLICATION PREVIEW':'EXPLORER';
    setIcon($('expand-preview').querySelector('[data-icon]'),expanded?'minimize':'expand');
    if(changed){sidebar.scrollTop=expanded?0:previewScroll;window.dispatchEvent(new Event('resize'));requestAnimationFrame(scheduleBounds);}
  }
  function requestPreviewMaximized(expanded){if(!requireDesktop())return;return run(()=>api.setPreviewMaximized(expanded));}
  $('expand-preview').onclick=()=>requestPreviewMaximized(!state.host.previewMaximized);
  window.addEventListener('trace-atlas:preview-maximized',event=>{if(typeof event.detail==='boolean')requestPreviewMaximized(event.detail);});
  let theme=localStorage.getItem('trace-atlas-theme')==='light'?'light':'dark';
  function setTheme(next){
    if(appearanceReady&&next===theme)return;
    theme=next;localStorage.setItem('trace-atlas-theme',next);
    changeAppearance(()=>{document.documentElement.dataset.theme=next;applyPalette(next);setIcon($('theme-toggle').querySelector('[data-icon]'),next==='dark'?'sun':'moon');$('theme-toggle').title='Switch to '+(next==='dark'?'light':'dark')+' appearance';$('theme-toggle').setAttribute('aria-label',$('theme-toggle').title);document.querySelectorAll('[data-appearance]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.appearance===next)));},{wave:true});
  }
  setTheme(theme);appearanceReady=true;$('theme-toggle').onclick=()=>setTheme(theme==='dark'?'light':'dark');
  window.addEventListener('trace-atlas:select-node',event=>{if(typeof event.detail?.id==='string')selectNode(event.detail.id);});
  window.addEventListener('trace-atlas:view',event=>{if(['map','files','requests','project'].includes(event.detail))switchView(event.detail);});
  window.addEventListener('trace-atlas:theme',event=>{if(['light','dark'].includes(event.detail))setTheme(event.detail);});
  window.addEventListener('trace-atlas:notice',event=>{if(typeof event.detail==='string')toast(event.detail);});
  window.addEventListener('trace-atlas:open-dialog',event=>{if(['command-dialog','connections-dialog','guide-dialog','welcome-dialog','about-dialog','tracing-setup-dialog','trace-tools-dialog','diagram-studio-dialog'].includes(event.detail))openDialog(event.detail);});
  window.addEventListener('trace-atlas:open-snapshot',event=>{receiveTrace(event.detail);switchView('map');});
  window.addEventListener('trace-atlas:return-live',()=>{if(state.lastLiveGraph){receiveTrace(state.lastLiveGraph);switchView('map');}else toast('Select an element in the live application to capture a current trace.');});
  window.addEventListener('trace-atlas:map-options',event=>{
    if(!state.graph)return;stopPlayback();const next=event.detail||{};
    if(['field','request'].includes(next.scope))state.scope=next.scope;
    for(const [key,set]of [['toggleBranch',state.collapsed],['toggleExecutions',state.expanded]])if(next[key]){if(set.has(next[key]))set.delete(next[key]);else set.add(next[key]);}
    if(next.revealNode)state.collapsed.clear();
    const previous=state.selected?.id;drawGraph();
    const requested=next.revealNode||previous,id=state.presentation.nodes.some(node=>node.id===requested)?requested:state.presentation.nodes.find(node=>node.kind==='source')?.id||state.presentation.nodes[0]?.id;if(id)selectNode(id);
  });
  reduced.addEventListener('change',()=>{if(reduced.matches)stopPlayback();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlayback();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.host.previewMaximized&&!document.querySelector('dialog[open]')){e.preventDefault();if(state.host.inspectMode)run(()=>api.inspect());else requestPreviewMaximized(false);return;}if(e.target.closest('input,textarea,select,[contenteditable]')||e.ctrlKey||e.metaKey||e.altKey||document.querySelector('dialog[open]'))return;if(e.key.toLowerCase()==='i'){e.preventDefault();$('inspect-button').click();}if(e.key.toLowerCase()==='f'){e.preventDefault();playTrace();}if(e.key==='Escape')stopPlayback();});
  if(api){api.onState(next=>{handleHost(next);renderAutomaticAttachment();});api.onSelection(selection);api.onTrace(receiveTrace);api.onError(error=>toast(error?.message||error,true));run(()=>api.getState()).then(initial=>{if(initial){handleHost(initial);renderAutomaticAttachment();}});scheduleBounds();}else{$('inspect-button').disabled=true;$('footer-status').textContent='Desktop preview · run npm start to inspect applications';}
  window.addEventListener('beforeunload',()=>stopPlayback());
})();
