(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.traceAtlas;
  let graph = null, selected = null, sourceRoot = null, models = [], activeController = null, opened = false;
  let progressTimer = null, progressStage = '', progressStarted = 0;
  const setStatus = (message, error = false, working = false) => { const el = $('agent-status'); el.textContent = message; el.classList.toggle('error', error); el.classList.toggle('working', working); };
  const renderProgress = () => {
    if (!activeController) return;
    const seconds = Math.max(0, Math.floor((Date.now() - progressStarted) / 1000));
    setStatus(`${progressStage} (${seconds}s)`, false, true);
  };
  const beginProgress = stage => {
    progressStage = stage; progressStarted = Date.now();
    clearInterval(progressTimer); progressTimer = setInterval(renderProgress, 1000);
    renderProgress();
  };
  const updateProgress = stage => {
    if (!activeController || typeof stage !== 'string' || !stage) return;
    progressStage = stage; renderProgress();
  };
  const endProgress = () => {clearInterval(progressTimer); progressTimer = null;};
  const text = (parent, tag, value, className) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = String(value ?? ''); parent.append(node); return node; };
  const sourceKey = ref => `${ref.path}\0${ref.line}\0${ref.hash}`;
  function selectedGap() { return selected?.kind === 'gap' || selected?.status === 'missing'; }
  function updateControls() {
    const model = $('agent-model').value, ready = !!api && !!graph && !!model && !activeController;
    $('agent-explain-trace').disabled = !ready;
    $('agent-explain-gap').disabled = !ready || !selectedGap();
    $('agent-refresh-models').disabled = !api || !!activeController;
    $('agent-model').disabled = !models.length || !!activeController;
    $('agent-cancel').hidden = !activeController;
  }
  async function refreshModels() {
    if (!api?.getLocalModels || activeController) return;
    $('agent-refresh-models').disabled = true;
    $('agent-model').disabled = true;
    $('agent-model-status').textContent = 'Starting Orivo’s bundled local model…';
    try {
      const result = await api.getLocalModels();
      models = Array.isArray(result?.models) ? result.models.filter(model => typeof model === 'string') : [];
      const previous = $('agent-model').value;
      $('agent-model').replaceChildren();
      for (const model of models) {const option = document.createElement('option'); option.value = model; option.textContent = model; $('agent-model').append(option);}
      if (models.includes(previous)) $('agent-model').value = previous;
      if (result?.available && models.length) $('agent-model-status').textContent = result.message || `${result.provider || 'Orivo Local AI'} · Ready`;
      else $('agent-model-status').textContent = result?.message || 'Orivo’s bundled model is unavailable.';
    } catch (error) {models = []; $('agent-model').replaceChildren(); $('agent-model-status').textContent = error.message || 'Orivo’s bundled model is unavailable.';}
    updateControls();
  }
  function clearResult() { $('agent-result').replaceChildren(); $('agent-result').hidden = true; $('agent-source').hidden = true; $('agent-source-path').textContent = ''; $('agent-source-line').textContent = ''; $('agent-source-code').textContent = ''; }
  function renderRefs(parent, refs) {
    for (const ref of refs || []) {
      const button = text(parent, 'button', `${ref.path}:${ref.line}`, 'agent-citation');
      button.type = 'button';
      button.addEventListener('click', () => openSource(ref));
    }
  }
  function renderEvidence(parent, ids) {
    const row = document.createElement('div'); row.className = 'agent-citations';
    for (const id of ids || []) {
      const button = text(row, 'button', `Evidence ${id}`, 'agent-citation'); button.type = 'button';
      button.addEventListener('click', () => {window.dispatchEvent(new CustomEvent('trace-atlas:select-node', {detail: {id}})); window.dispatchEvent(new CustomEvent('trace-atlas:view', {detail: 'map'}));});
    }
    if (row.childElementCount) parent.append(row);
  }
  function renderExplanation(result) {
    clearResult();
    const explanation = result?.explanation;
    if (!explanation || explanation.status !== 'suggestion') throw Error('Orivo rejected the model output because its evidence citations were not valid.');
    const root = $('agent-result');
    const summary = document.createElement('article'); summary.className = 'agent-summary';
    text(summary, 'span', 'AI SUGGESTION · VERIFIED REFERENCES', 'agent-result-label');
    text(summary, 'p', explanation.summary.text);
    renderEvidence(summary, explanation.summary.evidenceIds); renderRefs(summary, explanation.summary.sourceRefs); root.append(summary);
    for (const [heading, rows, kind] of [['Trace steps', explanation.steps, 'step'], ['Unknowns', explanation.unknowns, 'unknown'], ['Suggested checks', explanation.nextChecks, 'check']]) {
      if (!rows?.length) continue;
      const section = document.createElement('section'); section.className = `agent-result-section agent-${kind}`; text(section, 'h3', heading);
      for (const row of rows) {
        const item = document.createElement('article'); item.className = 'agent-result-item';
        text(item, 'p', row.text);
        renderEvidence(item, row.evidenceIds || row.gapIds); renderRefs(item, row.sourceRefs);
        section.append(item);
      }
      root.append(section);
    }
    root.hidden = false;
    $('agent-model-status').textContent = `${result.provider || 'Local model'} · ${result.model || ''} · ${new Date(result.generatedAt || Date.now()).toLocaleTimeString()}`;
  }
  async function openSource(ref) {
    if (!api?.readSource || !sourceRoot) return;
    $('agent-source').hidden = true;
    try {
      const source = await api.readSource({path: ref.path, line: ref.line});
      if (sourceRoot !== graph?.repositoryRoot && graph?.repositoryRoot) return;
      if (source.hash !== ref.hash) throw Error('Source changed after this explanation. Scan the project map and explain the current trace again.');
      $('agent-source-path').textContent = source.path;
      $('agent-source-line').textContent = `Line ${source.line} · checked against current source`;
      $('agent-source-code').textContent = source.code;
      $('agent-source').hidden = false;
    } catch (error) { setStatus(error.message || 'Could not verify the cited source.', true); }
  }
  async function explain(task) {
    if (!api?.explainAgent || !graph || !$('agent-model').value || activeController) return;
    if (task === 'explain-gap' && !selectedGap()) return;
    clearResult();
    activeController = new AbortController(); updateControls();
    beginProgress(task === 'explain-gap' ? 'Explaining the selected evidence gap locally…' : 'Explaining the captured path locally…');
    try {
      const result = await api.explainAgent({task, traceId: graph.id, focusId: task === 'explain-gap' ? selected.id : selected?.id || null, model: $('agent-model').value});
      endProgress();
      renderExplanation(result);
      setStatus('Explanation checked against this capture and the current source map. It does not change trace coverage.');
    } catch (error) { endProgress(); setStatus(error.message || 'The local explanation failed.', true); }
    finally { endProgress(); activeController = null; updateControls(); }
  }
  async function cancel() {
    if (!activeController) return;
    activeController.abort();
    try { await api?.cancelAgent?.(); } catch {}
    setStatus('Cancelling the local explanation…', false, true); updateControls();
  }
  async function open() {
    opened = true;
    if (!api) {setStatus('AI explanations are available in the Orivo desktop app.', true); return;}
    try { const state = await api.getState(); sourceRoot = state?.demo ? null : state?.repository?.path || null; } catch { sourceRoot = null; }
    await refreshModels();
    if (!graph) setStatus('Capture an element in a connected project to explain its trace.');
    else updateControls();
  }
  $('agent-refresh-models').addEventListener('click', refreshModels);
  $('agent-explain-trace').addEventListener('click', () => explain('explain-trace'));
  $('agent-explain-gap').addEventListener('click', () => explain('explain-gap'));
  $('agent-cancel').addEventListener('click', cancel);
  $('agent-model').addEventListener('change', updateControls);
  api?.onAgentProgress?.(payload => updateProgress(payload?.message));
  window.addEventListener('trace-atlas:graph', event => {graph = event.detail || null; selected = null; clearResult(); setStatus(graph ? 'Trace ready. Choose a local model and explain the captured path.' : 'Capture an element in a connected project to explain its trace.'); updateControls(); if (opened && graph && !models.length) refreshModels();});
  window.addEventListener('trace-atlas:node', event => {selected = event.detail || null; updateControls();});
  if (api?.onState) api.onState(state => {sourceRoot = state?.demo ? null : state?.repository?.path || null; if (!sourceRoot) {graph = null; selected = null; clearResult(); setStatus('Connect your project and capture an element before using the local agent.'); updateControls();}});
  window.OrivoAgent = Object.freeze({open, refreshModels});
})();


