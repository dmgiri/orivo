'use strict';
const os = require('node:os');
function redactDiagnosticText(value) {
  return String(value || '').slice(0, 2400)
    .replace(/https?:\/\/[^\s"'<>]+/gi, candidate => { try { return new URL(candidate).origin + '/[path-omitted]'; } catch { return '[application-url]'; } })
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s\n"<>]+/g, '[local-path]')
    .replace(/((?:password|token|authorization|secret|api[_ -]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1000);
}
function diagnosticReport({ version, packaged, state, errors = [] }) {
  let origin = null;
  try { if (state.url) origin = new URL(state.url).origin; } catch {}
  return {
    format: 'orivo-diagnostics', version: 1, createdAt: new Date().toISOString(),
    application: { name: 'Orivo', version, channel: 'beta', packaged: !!packaged },
    system: { platform: process.platform, architecture: process.arch, release: os.release(), electron: process.versions.electron || null, chrome: process.versions.chrome || null },
    workspace: { connected: !!state.repository, indexedFiles: state.repository?.fileCount || 0, indexTruncated: !!state.repository?.truncated, skipped: state.repository?.skipped || null, applicationOrigin: origin, demo: !!state.demo, loading: !!state.loading },
    recentErrors: errors.slice(-30).map(error => ({ at: error.at, category: 'workspace-operation', code: 'OPERATION_FAILED' })),
    privacy: 'Generated locally. No source files, trace payloads, query text, repository paths, account tokens or application URL paths are included. Nothing is uploaded automatically.',
  };
}
module.exports = { redactDiagnosticText, diagnosticReport };
