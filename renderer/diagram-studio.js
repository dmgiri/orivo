(()=>{
 'use strict';
 const api=window.traceAtlas,$=id=>document.getElementById(id);
 const emit=(name,detail)=>window.dispatchEvent(new CustomEvent('trace-atlas:'+name,{detail}));
 const dialog=document.createElement('dialog');dialog.id='diagram-studio-dialog';dialog.className='app-dialog diagram-studio-dialog';dialog.setAttribute('aria-labelledby','diagram-studio-title');
 dialog.innerHTML=`<form method="dialog"><button class="dialog-close icon-button" aria-label="Close diagrams">×</button></form>
 <div class="diagram-studio-heading"><h2 id="diagram-studio-title">Diagrams</h2><span class="diagram-upstream">Original Archify · GitHub source</span></div>
 <p class="diagram-studio-intro">Explore, present and export diagrams with Archify’s original viewer. Authored diagrams are separate from captured runtime evidence.</p>
 <div class="diagram-controls"><label>Diagram type<select id="diagram-type"></select></label><label>Diagram style<select id="diagram-preset"></select></label><label>Validation<select id="diagram-quality"><option value="standard">Standard</option><option value="showcase">Showcase</option></select></label><button class="secondary-button" id="diagram-example">Load example</button><button class="secondary-button" id="diagram-import">Import JSON</button><button class="secondary-button" id="diagram-current-trace">Use current trace</button></div>
 <div class="diagram-editor-options"><label><input type="checkbox" id="diagram-compare"> Architecture Before / After</label><label><input type="checkbox" id="diagram-live"> Preview valid edits automatically</label></div>
 <div class="diagram-editors"><label id="diagram-before-label" hidden>Before <button class="text-button" id="diagram-import-before">Import Before JSON</button><textarea id="diagram-before" spellcheck="false" aria-label="Before architecture JSON"></textarea></label><label>Editable source JSON<textarea id="diagram-source" spellcheck="false" aria-label="Diagram source JSON"></textarea></label></div>
 <p id="diagram-status" role="status" aria-live="polite">Load an example or import a self-contained Archify JSON document.</p>
 <div class="diagram-primary-actions"><button class="primary-button" id="diagram-render">Validate & open viewer</button><button class="secondary-button" id="diagram-export-html" disabled>Export interactive HTML</button><button class="secondary-button" id="diagram-export-json" disabled>Export source JSON</button><button class="text-button" id="diagram-export-receipt" disabled>Validation receipt</button></div>
 <details class="diagram-capabilities"><summary>Viewer features and shortcuts</summary><p>Search nodes · focus and details · upstream/downstream reach · exact routes · semantic lens and radar · deep links · Live/Still motion · presentation · PNG/JPEG/WebP/SVG/WebM exports · route and reach share cards. Use the viewer’s Guide (?) for its original controls. Explainers include panels, charts and print/PDF; Architecture comparison includes Before / Delta / After.</p><p>All four global themes support light and dark. Viewer exports describe the diagram; they do not establish runtime tracing coverage.</p></details>
 <details open class="diagram-session"><summary>Diagrams created in this session</summary><div id="diagram-library"><p>No diagrams created yet.</p></div></details>
 <p class="diagram-attribution">Archify by tt-a1i · github.com/tt-a1i/archify · upstream source preserved unchanged; Orivo integration maintained separately.</p>`;
 document.body.append(dialog);
 const typeNames={architecture:'Architecture',workflow:'Workflow',sequence:'Sequence',dataflow:'Data Flow',lifecycle:'Lifecycle',erd:'ERD',class:'Class',tree:'Tree',timeline:'Timeline',waterfall:'Waterfall',explainer:'Explainer page'};
 let info=null,current=null,busy=false,timer=null;
 function status(message,error=false){$('diagram-status').textContent=message;$('diagram-status').classList.toggle('error',error);}
 async function action(work){try{return await work();}catch(error){status(error.message||String(error),true);return null;}}
 function setBusy(value){busy=value;$('diagram-render').disabled=value;$('diagram-render').textContent=value?'Validating…':'Validate & open viewer';for(const id of ['diagram-type','diagram-quality','diagram-example','diagram-import','diagram-import-before'])$(id).disabled=value;}
 function exportButtons(){for(const format of ['html','json','receipt'])$('diagram-export-'+format).disabled=!current||busy;}
 function syncPreset(){const id=localStorage.getItem('orivo-diagram-preset');$('diagram-preset').value=window.OrivoThemes.globalPalettes.some(p=>p.id===id)?id:'classic';}
 function comparison(){const enabled=$('diagram-compare').checked&&$('diagram-type').value==='architecture';$('diagram-before-label').hidden=!enabled;dialog.classList.toggle('diagram-comparing',enabled);return enabled;}
 function library(){const node=$('diagram-library');node.replaceChildren();for(const item of [...(info?.diagrams||[])].reverse()){const row=document.createElement('div');row.className='diagram-library-row';const title=document.createElement('span');title.textContent=item.title;const detail=document.createElement('small');detail.textContent=item.type+' · '+item.preset;const open=document.createElement('button');open.className='text-button';open.textContent='Open';open.onclick=()=>action(async()=>{current=item.id;exportButtons();await api.openDiagram(item.id,document.documentElement.dataset.theme);});row.append(title,detail,open);node.append(row);}if(!node.childElementCount){const p=document.createElement('p');p.textContent='No diagrams created yet.';node.append(p);}}
 async function render(){
  if(busy)return;
  setBusy(true);exportButtons();const text=$('diagram-source').value;
  status('Running the original Archify renderer and validation gates…');
  try{
   const result=await api.renderDiagram({type:$('diagram-type').value,text,preset:$('diagram-preset').value,quality:$('diagram-quality').value,...(comparison()?{before:$('diagram-before').value}:{})});
   current=result.id;info=await api.getDiagramInfo();library();
   await api.openDiagram(result.id,document.documentElement.dataset.theme);
   status('Validated and opened. Use the viewer’s Export menu for images, SVG, video and share cards.');
  }catch(error){status((error.message||String(error))+' The previous valid diagram is preserved.',true);}
  finally{setBusy(false);exportButtons();}
 }
 async function open(){
  if(!api?.getDiagramInfo){emit('notice','Open the desktop app to use Diagram studio.');return;}
  await action(async()=>{
   info=await api.getDiagramInfo();
   if(!$('diagram-type').options.length){for(const type of info.types){const option=document.createElement('option');option.value=type;option.textContent=typeNames[type]||type;$('diagram-type').append(option);}for(const preset of window.OrivoThemes.globalPalettes){const option=document.createElement('option');option.value=preset.id;option.textContent=preset.name;$('diagram-preset').append(option);}}
   syncPreset();library();emit('open-dialog','diagram-studio-dialog');
   if(!$('diagram-source').value)$('diagram-source').value=await api.getDiagramExample('architecture');
  });
 }
 window.addEventListener('orivo:open-diagrams',open);
 $('diagram-preset').onchange=()=>{localStorage.setItem('orivo-diagram-preset',$('diagram-preset').value);api?.setDiagramAppearance?.($('diagram-preset').value,document.documentElement.dataset.theme).catch(()=>{});};
 $('diagram-type').onchange=()=>{if($('diagram-type').value!=='architecture')$('diagram-compare').checked=false;comparison();};
 $('diagram-example').onclick=()=>action(async()=>{if(comparison()){const sample=await api.getDiagramComparisonExample();$('diagram-before').value=sample.before;$('diagram-source').value=sample.after;}else $('diagram-source').value=await api.getDiagramExample($('diagram-type').value);status('Original upstream example loaded. Example facts and timings are illustrative.');});
 $('diagram-compare').onchange=()=>{if($('diagram-compare').checked)$('diagram-type').value='architecture';comparison();status('Load the comparison example or import both architecture snapshots.');};
 async function importSource(before){const imported=await api.importDiagram();if(!imported)return;const value=JSON.parse(imported.text);if(!info.types.includes(value.diagram_type))throw Error('Choose a supported Archify JSON document.');if(before&&value.diagram_type!=='architecture')throw Error('Before must be an Architecture document.');$(before?'diagram-before':'diagram-source').value=imported.text;if(!before)$('diagram-type').value=value.diagram_type;comparison();status('Imported '+imported.name+'. Validate to create the diagram.');}
 $('diagram-import').onclick=()=>action(()=>importSource(false));$('diagram-import-before').onclick=()=>action(()=>importSource(true));
 $('diagram-render').onclick=render;
 $('diagram-current-trace').onclick=()=>action(async()=>{$('diagram-source').value=await api.getTraceDiagram();$('diagram-type').value='architecture';$('diagram-compare').checked=false;comparison();status('Current captured relationships loaded. This presentation adds no new runtime evidence.');});
 for(const format of ['html','json','receipt'])$('diagram-export-'+format).onclick=()=>action(async()=>{const result=await api.exportDiagram(current,format);if(result)status('Exported '+result.path);});
 function schedule(){clearTimeout(timer);if(!$('diagram-live').checked||busy)return;timer=setTimeout(()=>{try{JSON.parse($('diagram-source').value);if(comparison())JSON.parse($('diagram-before').value);render();}catch{status('Waiting for valid JSON. The previous diagram stays available.');}},1000);}
 for(const id of ['diagram-source','diagram-before'])$(id).addEventListener('input',schedule);
 dialog.addEventListener('close',()=>clearTimeout(timer));dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
})();
