'use strict';
(() => {
  const $=id=>document.getElementById(id),api=window.traceAtlas;
  const emit=(name,detail)=>window.dispatchEvent(new CustomEvent('trace-atlas:'+name,{detail}));
  const notice=message=>emit('notice',message);
  let graph=null,selected=null,host={},snapshots=[],activeTab='health',busy=false,requestMode='list',healthRevision=0,snapshotRevision=0,comparisonRevision=0;
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const ms=value=>finite(value)?(value<1?value.toFixed(2):value<100?value.toFixed(1):Math.round(value))+' ms':'Not measured';
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;};
  async function action(work){try{return await work();}catch(error){notice(error.message||String(error));}}
  const tools=element('button');tools.id='trace-tools-button';tools.className='icon-button';tools.title='Trace tools: health, performance and saved comparisons';tools.setAttribute('aria-label','Trace tools');
  tools.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18M7 3v6m10 0v6M9 15v6"/></svg>';
  document.querySelector('.heading-actions').append(tools);
  tools.append(document.createTextNode('Tools'));
  const editor=element('button');editor.id='open-editor';editor.className='icon-button';editor.title='Open current source line in VS Code';editor.setAttribute('aria-label','Open source in VS Code');editor.disabled=true;
  editor.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6"/></svg>';
  document.querySelector('.detail-actions').prepend(editor);
  const options=element('div',undefined,'trace-map-options');
  options.innerHTML='<select id="graph-scope" aria-label="Diagram scope"><option value="field">Selected field</option><option value="request">Entire request</option></select><button id="graph-branch-toggle" aria-label="Collapse selected branch" title="Collapse or restore descendants of the selected step" disabled>Branch</button><button id="graph-executions-toggle" aria-label="Expand captured SQL executions" title="Expand or collapse individual captured SQL executions" disabled>SQL</button><output id="graph-hidden-count" aria-live="polite"></output>';
  document.querySelector('.canvas-footer').insertBefore(options,document.querySelector('.map-navigation-hint'));
  $('graph-scope').onchange=()=>emit('map-options',{scope:$('graph-scope').value});
  $('graph-branch-toggle').onclick=()=>emit('map-options',{toggleBranch:selected?.sourceNodeId||selected?.id});
  $('graph-executions-toggle').onclick=()=>emit('map-options',{toggleExecutions:selected?.sourceNodeId||selected?.id});
  const returnLive=element('button','Live');returnLive.id='return-live';returnLive.hidden=true;returnLive.title='Return to the most recent live capture';returnLive.onclick=()=>emit('return-live');options.append(returnLive);
  window.addEventListener('trace-atlas:presentation',event=>{
    const view=event.detail||{},hidden=view.hidden||{};
    $('graph-hidden-count').textContent=hidden.nodes?`${hidden.nodes} hidden`:'';
    $('graph-hidden-count').title=hidden.nodes?`${hidden.queries||0} other SQL blocks, ${hidden.executions||0} executions. Switch to Entire request or restore a collapsed branch.`:'';
    $('graph-scope').value=view.scope||'field';
    updateSelection(view);
  });
  let presentation={};
  function updateSelection(view=presentation){
    presentation=view;
    const sourceId=selected?.sourceNodeId||selected?.id,node=graph?.nodes.find(node=>node.id===sourceId),expanded=new Set(view.expanded||[]),collapsed=new Set(view.collapsed||[]);
    const count=node?.kind==='query'?Number(node.meta?.executionCount)||node.meta?.queryIds?.length||1:0;
    $('graph-executions-toggle').disabled=count<2;
    $('graph-executions-toggle').textContent=count>1?(expanded.has(sourceId)?'Group SQL':`Expand ×${count}`):'SQL';
    $('graph-executions-toggle').setAttribute('aria-label',expanded.has(sourceId)?'Group captured SQL executions':`Expand ${count||0} captured SQL executions`);
    $('graph-executions-toggle').setAttribute('aria-pressed',String(expanded.has(sourceId)));
    $('graph-branch-toggle').disabled=!sourceId||!graph?.edges.some(edge=>edge.from===sourceId);
    $('graph-branch-toggle').textContent=collapsed.has(sourceId)?'Restore branch':'Fold branch';
    $('graph-branch-toggle').setAttribute('aria-label',collapsed.has(sourceId)?'Restore selected branch':'Fold selected branch');
    $('graph-branch-toggle').setAttribute('aria-pressed',String(collapsed.has(sourceId)));
    editor.disabled=!api?.openInEditor||!node?.file||!node?.meta?.sourceHash||!!graph?.snapshot?.readOnly;
    editor.title=graph?.snapshot?.readOnly?'Saved captures are read only. Capture the current element to open its verified source.':'Open current source line in VS Code';
  }
  editor.onclick=()=>action(async()=>{if(editor.disabled)return;await api.openInEditor({graphId:graph.id,nodeId:selected.sourceNodeId||selected.id});});
  const dialog=element('dialog');dialog.id='trace-tools-dialog';dialog.className='app-dialog trace-tools-dialog';dialog.setAttribute('aria-labelledby','trace-tools-title');
  dialog.innerHTML='<form method="dialog"><button class="dialog-close icon-button" aria-label="Close trace tools">×</button></form><h2 id="trace-tools-title">Trace tools</h2><div class="trace-tools-tabs" role="tablist" aria-label="Trace tools"><button id="tool-tab-health" role="tab" aria-controls="tool-health" aria-selected="true">Health</button><button id="tool-tab-performance" role="tab" aria-controls="tool-performance" aria-selected="false">Performance</button><button id="tool-tab-snapshots" role="tab" aria-controls="tool-snapshots" aria-selected="false">Saved traces</button><button id="tool-tab-compare" role="tab" aria-controls="tool-compare" aria-selected="false">Compare</button></div><section id="tool-health" class="trace-tool-panel" role="tabpanel" aria-labelledby="tool-tab-health"></section><section id="tool-performance" class="trace-tool-panel" role="tabpanel" aria-labelledby="tool-tab-performance" hidden></section><section id="tool-snapshots" class="trace-tool-panel" role="tabpanel" aria-labelledby="tool-tab-snapshots" hidden><div class="tool-actions"><input id="snapshot-name" aria-label="Saved trace name" maxlength="80" placeholder="Name this capture"><button class="secondary-button" id="pin-trace">Save current trace</button><button class="secondary-button" id="import-trace">Import JSON</button></div><p id="snapshot-note"></p><div id="snapshot-list"></div></section><section id="tool-compare" class="trace-tool-panel" role="tabpanel" aria-labelledby="tool-tab-compare" hidden><p>Compare captured paths, SQL execution counts and measured timings. Saved captures remain read only.</p><div class="compare-selects"><label>Before<select id="compare-before"></select></label><label>After<select id="compare-after"></select></label><button class="secondary-button" id="compare-traces">Compare</button></div><div id="compare-result"></div></section>';
  document.body.append(dialog);
  dialog.addEventListener('close',()=>window.dispatchEvent(new Event('resize')));
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  tools.onclick=()=>action(async()=>{emit('open-dialog','trace-tools-dialog');await renderTab();});
  const tabNames=['health','performance','snapshots','compare'];
  async function setTab(name){healthRevision++;snapshotRevision++;comparisonRevision++;activeTab=name;for(const tab of tabNames){$('tool-tab-'+tab).setAttribute('aria-selected',String(tab===name));$('tool-tab-'+tab).tabIndex=tab===name?0:-1;$('tool-'+tab).hidden=tab!==name;}await renderTab();}
  for(const name of tabNames)$('tool-tab-'+name).tabIndex=name===activeTab?0:-1;
  for(const name of tabNames){$('tool-tab-'+name).onclick=()=>action(()=>setTab(name));$('tool-tab-'+name).onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const index=tabNames.indexOf(name),next=tabNames[(index+(event.key==='ArrowRight'?1:3))%4];action(()=>setTab(next));$('tool-tab-'+next).focus();};}
  async function renderTab(){if(activeTab==='health')await renderHealth();if(activeTab==='performance')renderPerformance();if(['snapshots','compare'].includes(activeTab))await loadSnapshots();}
  function healthCard(parent,title,state,detail){const card=element('div',undefined,'health-card');card.dataset.state=state;card.append(element('strong',title),element('small',detail));parent.append(card);}
  async function renderHealth(){
    const ticket=++healthRevision,panel=$('tool-health');
    const nextHost=api?.getState?await api.getState():host;
    const native=api?.getTraceHealth?await api.getTraceHealth():null;
    if(ticket!==healthRevision||activeTab!=='health'||!dialog.open)return;
    host=nextHost;panel.replaceChildren();
    const session=host.attachment||{},observed=graph&&!graph.snapshot?.readOnly?graph:null;
    const sessionStatus=session.status||'not attached';
    panel.append(element('p',`Managed session: ${sessionStatus}${session.notice?' · '+session.notice:''}`,'tool-note'));
    const runtime=host.pageRuntime||'unknown';
    panel.append(element('p',runtime==='available'?'Frontend runtime detected on the loaded page.':runtime==='missing'?'Frontend runtime is missing on the loaded page. Restart the traced session or check its setup.':'Frontend runtime: '+runtime,'tool-note'));
    const grid=element('div',undefined,'health-grid');panel.append(grid);
    const has=kind=>observed?.nodes.some(node=>node.kind===kind&&node.status!=='missing');
    healthCard(grid,'Frontend binding',observed?.captured?'captured':'unavailable',observed?.captured?'Captured source binding and version verified.':'Select an element in a traced app to verify its binding.');
    healthCard(grid,'API request',has('api')?'captured':'unavailable',has('api')?'Same-origin request captured for this selected binding.':'No response dependency captured for this element.');
    healthCard(grid,'Backend correlation',has('backend')?'captured':'unavailable',has('backend')?'Matching request and backend source captured.':'No verified backend handler in the current capture.');
    healthCard(grid,'Database execution',has('query')?'captured':'unavailable',has('query')?`${observed.summary?.queries||0} SQL executions captured.`:'No database execution in the current capture.');
    healthCard(grid,'Field origin',observed?.valueOrigin==='local'?'frontend':observed?.valueOrigin==='collection'||has('database')?'captured':'unavailable',observed?.valueOrigin==='local'?'The visible value is a captured local fallback. Any displayed columns are lookup or branch inputs.':observed?.valueOrigin==='collection'?'The input collection has captured query-result membership. Its displayed count is calculated in the frontend.':has('database')?'The displayed field has captured column evidence.':'A query alone does not establish the displayed field’s column.');
    if(graph?.snapshot?.readOnly)panel.append(element('p','You are viewing a saved trace. Select an element in the live app to check current coverage.','tool-note'));
    if(observed?.gaps?.length){panel.append(element('h3','Coverage details'));const list=element('ul');for(const gap of observed.gaps)list.append(element('li',gap));panel.append(list);}
    const actions=element('div',undefined,'tool-actions'),restart=element('button','Restart session and recapture','secondary-button');restart.id='restart-recapture';restart.disabled=busy||!api?.restartAndRecapture||!session.active||session.status!=='running';
    restart.disabled=busy||!api?.restartAndRecapture||!native?.canRestart;
    restart.onclick=()=>action(async()=>{busy=true;restart.disabled=true;restart.textContent='Restarting…';try{const result=await api.restartAndRecapture();notice(result.notice||(result.recaptured?'Session restarted and trace recaptured.':'Session restarted. Select the element again.'));}finally{busy=false;if(dialog.open)await renderHealth();}});
    const setup=element('button','Tracing setup','secondary-button');setup.onclick=()=>{dialog.close();emit('open-dialog','tracing-setup-dialog');};
    actions.append(restart,setup);panel.append(actions);
    if(host.repository&&api?.setIndexProfile){
      panel.append(element('h3','Source indexing'));
      const repository=host.repository,limits=repository.limits||{},skipped=repository.skipped||{};
      panel.append(element('p',`${repository.fileCount||0} indexed files · ${Math.round((repository.totalBytes||0)/1048576)} MiB${repository.truncated?' · Scan limit reached':''}. Excluded: ${skipped.excluded||0}; too large: ${skipped.tooLarge||0}; unreadable: ${skipped.unreadable||0}; links: ${skipped.symlinks||0}.`,'tool-note'));
      const controls=element('div',undefined,'tool-actions'),label=element('label','Scan profile '),select=element('select');select.id='source-index-profile';
      for(const [value,text] of [['standard','Standard — 5,000 files / 40 MiB'],['large','Large — 25,000 files / 256 MiB']]){const option=element('option',text);option.value=value;select.append(option);}
      select.value=repository.profile||'standard';label.append(select);
      const apply=element('button','Apply and rescan','secondary-button');apply.id='source-index-apply';apply.disabled=busy;
      apply.onclick=()=>action(async()=>{busy=true;apply.disabled=true;try{await api.setIndexProfile(select.value);notice('Source profile saved. Select an element again to capture fresh evidence.');}finally{busy=false;if(dialog.open)await renderHealth();}});
      controls.append(label,apply);panel.append(controls,element('p',`Current limits: ${limits.depth||16} folder levels, ${Math.round((limits.fileBytes||262144)/1024)} KiB per file. The selected profile is remembered for future source scans. Dependencies, secret files and symbolic links remain excluded. Project-map analysis has its own limits.`,'tool-note'));
    }
    if(native?.note)panel.append(element('p',native.note));
  }
  function table(parent,headers,rows){const node=element('table',undefined,'trace-tool-table'),head=element('thead'),header=element('tr');for(const label of headers)header.append(element('th',label));head.append(header);node.append(head);const body=element('tbody');for(const row of rows){const tr=element('tr');for(const value of row){const td=element('td');if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);}body.append(tr);}node.append(body);parent.append(node);return node;}
  function focusNode(nodeId){dialog.close();emit('view','map');emit('map-options',{scope:'request',revealNode:nodeId});emit('select-node',{id:nodeId});}
  function renderPerformance(){
    const panel=$('tool-performance');panel.replaceChildren();if(!graph){panel.append(element('p','Capture an element to inspect its request and database timings.'));return;}
    const timing=graph.summary?.timing||{};
    table(panel,['Measured stage','Captured time'],[['Browser requests',ms(timing.browserDurationMs)],['Backend requests',ms(timing.backendDurationMs)],['SQL executions',ms(timing.queryDurationMs)]]);
    panel.append(element('p','Times describe their measured scopes and may overlap. Request durations and SQL totals are not added together. Missing timings remain “Not measured”.'));
    for(const finding of graph.diagnostics||[]){const card=element('div',undefined,'performance-finding');card.append(element('strong',finding.title||'Trace finding'),element('p',finding.detail||''));const target=finding.nodeIds?.[0];if(target){const button=element('button','Show in diagram');button.onclick=()=>focusNode(target);card.append(button);}panel.append(card);}
    const queries=graph.nodes.filter(node=>node.kind==='query');
    table(panel,['SQL block','Executions','Measured','Measured total','Slowest execution'],queries.map(node=>{const button=element('button',node.label+(node.file?` · ${node.file}:${node.line||1}`:''));button.onclick=()=>focusNode(node.id);const count=node.meta?.executionCount||1,measured=node.meta?.measuredCount??node.meta?.executions?.filter(row=>finite(row.durationMs)).length??0;return[button,count,`${measured}/${count}`,ms(node.meta?.totalDurationMs??node.meta?.durationMs),ms(node.meta?.maxDurationMs)];}));
  }
  async function loadSnapshots(){
    if(!api?.getSnapshots)return;
    const ticket=++snapshotRevision,result=await api.getSnapshots();
    if(ticket!==snapshotRevision||!dialog.open||!['snapshots','compare'].includes(activeTab))return;
    snapshots=result.snapshots||[];
    $('pin-trace').disabled=!graph||!!graph.snapshot?.readOnly||!api.pinTrace;
    $('import-trace').disabled=!api.importTrace;
    $('snapshot-note').textContent=result.warning||'Saved locally. Captures contain source excerpts and redacted query evidence.';
    const list=$('snapshot-list');list.replaceChildren();if(!snapshots.length)list.append(element('p','No saved traces yet. Save a capture or import an Orivo JSON export.'));
    for(const snapshot of snapshots){const row=element('div',undefined,'saved-trace-row'),open=element('button'),name=element('strong',snapshot.name||snapshot.title||'Saved trace'),detail=element('small',`${snapshot.coverage} · ${snapshot.summary?.queries||0} queries · ${new Date(snapshot.savedAt).toLocaleString()}`);open.append(name,detail);open.onclick=()=>action(async()=>{const saved=await api.openSnapshot(snapshot.id);dialog.close();emit('open-snapshot',saved);});const remove=element('button','Remove');remove.setAttribute('aria-label','Remove saved trace '+(snapshot.name||snapshot.title));remove.onclick=()=>action(async()=>{await api.removeSnapshot(snapshot.id);await loadSnapshots();});row.append(open,remove);list.append(row);}
    const before=$('compare-before'),after=$('compare-after'),oldBefore=before.value,oldAfter=after.value;
    for(const select of [before,after]){select.replaceChildren();for(const snapshot of snapshots){const option=element('option',snapshot.name||snapshot.title);option.value=snapshot.id;select.append(option);}}
    if(snapshots.some(row=>row.id===oldBefore))before.value=oldBefore;
    if(snapshots.some(row=>row.id===oldAfter))after.value=oldAfter;else if(snapshots.length>1)after.selectedIndex=1;
    $('compare-traces').disabled=snapshots.length<2;
  }
  $('pin-trace').onclick=()=>action(async()=>{if(!graph||graph.snapshot?.readOnly)return;await api.pinTrace(graph.id,$('snapshot-name').value.trim()||undefined);$('snapshot-name').value='';await loadSnapshots();notice('Trace saved locally.');});
  $('import-trace').onclick=()=>action(async()=>{const result=await api.importTrace();if(!result)return;await loadSnapshots();notice('Trace imported as a read-only saved capture.');});
  $('compare-traces').onclick=()=>action(async()=>{
    const ticket=++comparisonRevision,before=$('compare-before').value,after=$('compare-after').value;
    const result=await api.compareSnapshots(before,after);
    if(ticket!==comparisonRevision||!dialog.open||activeTab!=='compare'||$('compare-before').value!==before||$('compare-after').value!==after)return;
    const panel=$('compare-result');panel.replaceChildren();
    if(result.note)panel.append(element('p',result.note,'tool-note'));
    if(!result.sameSelection)panel.append(element('p','These captures select different elements or page paths. Changes describe their captured structures.'));
    if(!result.sameProject)panel.append(element('p','A shared original project identity could not be verified for these captures.'));
    table(panel,['Measure','Before','After'],[['Steps',result.before.nodes,result.after.nodes],['Requests',result.before.requests,result.after.requests],['SQL executions',result.before.queries,result.after.queries],['Coverage',result.before.coverage,result.after.coverage],['SQL measured time',ms(result.before.timing?.queryDurationMs),ms(result.after.timing?.queryDurationMs)]]);
    const changed=[...(result.addedNodes||[]).map(node=>['Added',node]),...(result.removedNodes||[]).map(node=>['Removed',node])];
    for(const row of result.changedNodes||[]){if(row.before?.[0])changed.push(['Before',row.before[0]]);if(row.after?.[0])changed.push(['After',row.after[0]]);}
    if(changed.length)table(panel,['Change','Step','Source','Executions','Measured time'],changed.map(([change,node])=>[change,node.label,node.file?`${node.file}:${node.line||1}`:'—',node.executions??'—',ms(node.durationMs)]));
    else panel.append(element('p','No captured step or execution-count changes.'));
  });
  for(const id of ['compare-before','compare-after'])$(id).onchange=()=>{comparisonRevision++;$('compare-result').replaceChildren();};
  const requestOptions=element('div',undefined,'request-display-options');requestOptions.innerHTML='<button id="requests-list-toggle" aria-pressed="true">List</button><button id="requests-timeline-toggle" aria-pressed="false">Timeline</button>';
  $('request-list').before(requestOptions);const timeline=element('div',undefined,'request-timeline');timeline.id='request-timeline';timeline.hidden=true;$('request-list').after(timeline);
  function displayRequests(mode){requestMode=mode;$('request-list').hidden=mode!=='list';timeline.hidden=mode!=='timeline';$('requests-list-toggle').setAttribute('aria-pressed',String(mode==='list'));$('requests-timeline-toggle').setAttribute('aria-pressed',String(mode==='timeline'));if(mode==='timeline')renderTimeline();}
  $('requests-list-toggle').onclick=()=>displayRequests('list');$('requests-timeline-toggle').onclick=()=>displayRequests('timeline');
  function renderTimeline(){
    timeline.replaceChildren();if(!graph){timeline.append(element('p','Capture an element to inspect timings.'));return;}
    const requests=[...new Map(graph.nodes.filter(node=>node.kind==='api').map(node=>[node.meta?.requestId||node.id,node])).values()];
    if(!requests.length)timeline.append(element('p','No request captured for this element.'));
    for(const request of requests){const requestId=request.meta?.requestId,backend=graph.nodes.find(node=>node.kind==='backend'&&node.meta?.requestId===requestId),queries=graph.nodes.filter(node=>node.kind==='query'&&node.meta?.requestId===requestId),section=element('section',undefined,'timeline-request');
      section.append(element('h3',request.label),element('p',`Browser to response headers: ${ms(request.meta?.durationMs)} · Backend to response headers: ${ms(backend?.meta?.durationMs)}. SQL positions use the backend request clock.`));
      const executions=[...new Map(queries.flatMap(node=>(node.meta?.executions||node.meta?.queryIds?.map(id=>({id}))||[{id:node.meta?.queryId||node.id}]).map(execution=>({node,...execution}))).map(execution=>[execution.id,execution])).values()];
      const timed=executions.filter(item=>finite(item.durationMs)&&finite(item.startOffsetMs)),extent=Math.max(1,...timed.map(item=>item.startOffsetMs+item.durationMs),finite(backend?.meta?.durationMs)?backend.meta.durationMs:0);
      for(const item of executions){const row=element('div',undefined,'timeline-row'),button=element('button',item.id||item.node.label);button.title=item.node.file?`${item.node.file}:${item.node.line||1}`:item.node.label;button.onclick=()=>{emit('select-node',{id:item.node.id});};const track=element('div',undefined,'timeline-track');if(finite(item.durationMs)&&finite(item.startOffsetMs)){const bar=element('span',undefined,'timeline-bar');bar.style.left=Math.min(100,item.startOffsetMs/extent*100)+'%';bar.style.width=Math.min(100,item.durationMs/extent*100)+'%';track.append(bar);}else track.title='Position or duration not measured';row.append(button,track,element('span',ms(item.durationMs),'timeline-value'));section.append(row);}
      if(!executions.length)section.append(element('p','No SQL execution captured for this request.'));timeline.append(section);
    }
  }
  window.addEventListener('trace-atlas:graph',event=>{graph=event.detail;selected=null;returnLive.hidden=!graph?.snapshot?.readOnly;updateSelection();if(requestMode==='timeline')renderTimeline();if(dialog.open)action(renderTab);});
  window.addEventListener('trace-atlas:node',event=>{selected=event.detail;updateSelection();});
  if(api?.onState)api.onState(next=>{host=next;});
  if(api?.getState)action(async()=>{host=await api.getState();});
})();
