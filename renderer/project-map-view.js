(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.traceAtlas;
  let projectMap = null, currentRoot = null, loading = false;
  const MAX_ROWS = 500;

  function text(parent, tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value ?? '');
    parent.append(node);
    return node;
  }
  function clearSource() {
    $('project-map-source').hidden = true;
    $('project-map-source-path').textContent = '';
    $('project-map-source-line').textContent = '';
    $('project-map-source-code').textContent = '';
  }
  function renderSummary(result) {
    const map = result.map, box = $('project-map-summary');
    box.replaceChildren();
    box.hidden = false;
    const summary = map.summary;
    const metrics = [
      ['Files', summary.sourceFiles], ['Analyzed', summary.analyzedFiles], ['Symbols', summary.symbols], ['References', summary.references],
    ];
    for (const [label, value] of metrics) {
      const item = document.createElement('div'); item.className = 'project-map-metric';
      text(item, 'strong', value); text(item, 'span', label); box.append(item);
    }
    const tags = document.createElement('div'); tags.className = 'project-map-tags';
    for (const item of map.languages || []) text(tags, 'span', `${item.name} · ${item.files} files`, 'project-map-tag');
    for (const item of map.frameworks || []) text(tags, 'span', item.name, 'project-map-tag declared');
    box.append(tags);
    $('project-map-clear').disabled = false;
    const cacheText = result.cached ? 'Loaded the saved local map.' : 'Built a fresh local map.';
    const limits = summary.analysisLimited || summary.sourceIndexTruncated ? ' The analysis reached a configured size limit.' : '';
    const parse = summary.parseFailures ? ` ${summary.parseFailures} file(s) could not be parsed completely.` : '';
    $('project-map-status').textContent = `${cacheText} Findings are source-only, not runtime trace evidence.${limits}${parse}${result.cacheWarning ? ` ${result.cacheWarning}` : ''}`;
  }
  function searchable(row) { return [row.kind, row.name, row.path, row.target?.name, row.target?.path].filter(Boolean).join(' ').toLowerCase(); }
  function renderResults() {
    const box = $('project-map-results'); box.replaceChildren();
    if (!projectMap) return;
    const query = $('project-map-search').value.trim().toLowerCase();
    const symbols = (projectMap.symbols || []).map(row => ({...row, rowType: 'symbol'}));
    const references = (projectMap.references || []).map(row => ({...row, rowType: 'reference', path: row.from?.path, line: row.from?.line, hash: row.from?.hash, name: `${row.kind} → ${row.target?.name || 'reference'}`}));
    const rows = [...symbols, ...references].filter(row => !query || searchable(row).includes(query)).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind));
    if (!rows.length) {text(box, 'p', query ? 'No source findings match this search.' : 'No supported declarations were found in the indexed files.', 'project-map-empty'); return;}
    const shown = rows.slice(0, MAX_ROWS);
    for (const row of shown) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'project-map-row';
      text(button, 'span', row.rowType === 'reference' ? 'CANDIDATE' : 'SOURCE', 'project-map-row-state');
      const main = document.createElement('span'); main.className = 'project-map-row-main';
      text(main, 'strong', row.name); text(main, 'small', `${row.path}:${row.line} · ${row.kind}${row.target?.path ? ` · imports ${row.target.path}` : row.rowType === 'reference' ? ` · ${row.target?.name || ''}` : ''}`);
      button.append(main);
      button.addEventListener('click', () => openSource(row));
      box.append(button);
    }
    if (rows.length > shown.length) text(box, 'p', `Showing ${shown.length} of ${rows.length} findings. Refine the search to narrow the list.`, 'project-map-limit-note');
  }
  async function openSource(row) {
    if (!api?.readSource || !row.path || !Number.isInteger(row.line)) return;
    clearSource();
    $('project-map-status').textContent = 'Verifying current source before showing the excerpt…';
    try {
      const source = await api.readSource({path: row.path, line: row.line});
      if (currentRoot !== projectMap?.rootPath) return;
      $('project-map-source-path').textContent = source.path;
      $('project-map-source-line').textContent = `Line ${source.line} · source excerpt only`;
      $('project-map-source-code').textContent = source.code;
      $('project-map-source').hidden = false;
      $('project-map-status').textContent = 'Source excerpt verified against the current indexed file. This static finding does not prove a runtime connection.';
    } catch (error) {
      $('project-map-status').textContent = `${error.message} Scan the project again to refresh its source map.`;
    }
  }
  async function open() {
    if (loading) return;
    if (!api?.getProjectMap) { $('project-map-status').textContent = 'Project maps are available in the Orivo desktop app.'; return; }
    loading = true; $('project-map-scan').disabled = true; $('project-map-clear').disabled = true;
    clearSource();
    try {
      const state = await api.getState();
      if (!state?.repository || state.demo) {
        currentRoot = null; projectMap = null; $('project-map-summary').hidden = true; $('project-map-results').replaceChildren();
        $('project-map-status').textContent = 'Connect your own source folder to build a local project map.';
        return;
      }
      currentRoot = state.repository.path;
      $('project-map-status').textContent = 'Scanning the connected source with Orivo’s bounded, read-only index…';
      const result = await api.getProjectMap();
      const latest = await api.getState();
      if (latest?.repository?.path !== currentRoot || !result?.map) return;
      projectMap = {...result.map, rootPath: currentRoot};
      renderSummary(result); renderResults();
    } catch (error) {
      projectMap = null; $('project-map-summary').hidden = true; $('project-map-results').replaceChildren();
      $('project-map-status').textContent = error.message || 'The local project map could not be built.';
    } finally {loading = false; $('project-map-scan').disabled = false; $('project-map-clear').disabled = !projectMap;}
  }
  async function clear() {
    if (!projectMap || !api?.clearProjectMap || loading) return;
    loading = true; $('project-map-clear').disabled = true; $('project-map-scan').disabled = true;
    try {
      await api.clearProjectMap();
      projectMap = null; $('project-map-summary').replaceChildren(); $('project-map-summary').hidden = true; $('project-map-results').replaceChildren(); clearSource();
      $('project-map-status').textContent = 'The saved local map was cleared. Scan the project to build it again.';
    } catch (error) { $('project-map-status').textContent = error.message || 'The saved map could not be cleared.'; }
    finally {loading = false; $('project-map-scan').disabled = false; $('project-map-clear').disabled = !projectMap;}
  }
  $('project-map-scan').addEventListener('click', open);
  $('project-map-clear').addEventListener('click', clear);
  $('project-map-search').addEventListener('input', renderResults);
  if (api?.onState) api.onState(state => {
    const nextRoot = state?.demo ? null : state?.repository?.path || null;
    if (nextRoot !== currentRoot) {
      currentRoot = nextRoot; projectMap = null; clearSource(); $('project-map-summary').replaceChildren(); $('project-map-summary').hidden = true; $('project-map-results').replaceChildren();
      $('project-map-status').textContent = nextRoot ? 'Choose Scan project to map this source folder.' : 'Connect your own source folder to build a local project map.';
      $('project-map-clear').disabled = true;
    }
  });
  window.OrivoProjectMap = Object.freeze({open});
})();
