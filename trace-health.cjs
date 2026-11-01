'use strict';
function traceHealth({ state, graph, managed, busy = false, hasSelection = false }) {
  const nodes = graph?.nodes || [];
  const observed = (id, label, match) => ({ id, label, status: graph ? nodes.some(match) ? 'observed' : 'not-observed' : 'not-captured' });
  return {
    busy, canRestart: !busy && !!state.repository && !state.demo && !!managed?.frontend,
    canRecapture: hasSelection,
    source: { connected: !!state.repository, name: state.repository?.name || null, fileCount: state.repository?.fileCount || 0 },
    preview: { loaded: !!state.url && !state.loading, loading: !!state.loading, url: state.url || null, runtime: state.pageRuntime || 'unknown' },
    managed: { status: managed?.status || 'idle', active: !!managed?.active, frontend: managed?.frontend || null, backend: managed?.backend || null, notice: managed?.notice || '' },
    observed: { capturedAt: graph?.capturedAt || null, coverage: graph?.coverage || 'not-captured', gaps: graph?.gaps || [], stages: [observed('frontend', 'Frontend binding', node => node.kind === 'source' && node.meta?.sourceRole === 'frontend'), observed('api', 'API request', node => node.kind === 'api'), observed('backend', 'Backend handler', node => node.kind === 'backend'), observed('sql', 'SQL execution', node => node.kind === 'query'), observed('column', 'Database field mapping', node => node.kind === 'database')] },
    note: 'A running process does not prove tracing coverage. The stages above describe the most recent captured element only.',
  };
}
// Operation ownership checks fence every await so switching workspaces or
// pressing Stop cannot accidentally start/recapture the previous project.
async function restartManagedSession({ repository, options, url, check, stop, rescan, start, open }) {
  check(); await stop(repository); check();
  const index = await rescan(repository); check();
  const attachment = await start(repository, { ...options, url }); check();
  if (attachment.status !== 'running' || !attachment.url) throw Error(attachment.notice || 'The managed development session could not restart.');
  await open(attachment.url, index, attachment); check();
  return { attachment, index };
}
module.exports = { traceHealth, restartManagedSession };
