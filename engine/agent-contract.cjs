'use strict';

const ownRecord = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw Error(`${label} must be plain data.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || descriptor.get || descriptor.set || !('value' in descriptor)) throw Error(`${label} contains an unsupported field.`);
  }
  return value;
};
const AGENT_TOOLS = Object.freeze(['search-project-map', 'read-source-excerpt', 'read-selected-trace']);

function boundedText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error(`${label} must be short, non-empty text.`);
  return value.trim();
}

function boundedIds(value, label, allowed, {min = 1, max = 12} = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => typeof item !== 'string' || !allowed.has(item)) || new Set(value).size !== value.length) throw Error(`${label} must cite current evidence.`);
  return [...value];
}

function sourceReferences(value, label, projectMap, limit = 8) {
  if (!Array.isArray(value) || value.length > limit) throw Error(`${label} must be a bounded list.`);
  const files = new Map(projectMap.files.filter(file => file && typeof file.path === 'string' && typeof file.hash === 'string').map(file => [file.path, file]));
  return value.map((value, index) => {
    const ref = ownRecord(value, ['path', 'line', 'hash'], `${label} ${index + 1}`);
    const path = boundedText(ref.path, 'Source path', 512), file = files.get(path);
    if (!file || file.hash !== ref.hash || !Number.isInteger(ref.line) || ref.line < 1 || ref.line > file.lineCount) throw Error(`${label} contains stale or unavailable source.`);
    return {path, line: ref.line, hash: ref.hash};
  });
}

function graphEvidence(graph) {
  const nodes = graph.nodes.filter(node => node && typeof node.id === 'string');
  const evidenceIds = new Set([
    ...nodes.filter(node => node.kind !== 'gap' && node.status !== 'missing').map(node => node.id),
    ...graph.edges.filter(edge => edge && typeof edge.id === 'string').map(edge => edge.id),
  ]);
  const gapIds = new Set(nodes.filter(node => node.kind === 'gap' || node.status === 'missing').map(node => node.id));
  const focusIds = new Set([...nodes.map(node => node.id), ...graph.edges.filter(edge => typeof edge?.id === 'string').map(edge => edge.id)]);
  return {evidenceIds, gapIds, focusIds};
}

function validateAgentRequest(candidate, {graph, projectMap} = {}) {
  if (!graph || typeof graph.id !== 'string' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw Error('A captured trace is required for an agent task.');
  if (!projectMap || !Array.isArray(projectMap.files)) throw Error('A current local project map is required for an agent task.');
  const request = ownRecord(candidate, ['version', 'task', 'traceId', 'focusId', 'evidenceIds', 'gapIds', 'sourceRefs', 'tools'], 'Agent request');
  if (request.version !== 1 || !['explain-trace', 'explain-gap', 'suggest-check'].includes(request.task)) throw Error('Unsupported agent task.');
  if (request.traceId !== graph.id) throw Error('The agent task refers to a different captured trace.');
  const ids = graphEvidence(graph);
  const focusId = request.focusId === null ? null : boundedIds([request.focusId], 'Focused evidence', ids.focusIds)[0];
  const evidenceIds = boundedIds(request.evidenceIds, 'Agent evidence', ids.evidenceIds, {min: 0, max: 300});
  const gapIds = boundedIds(request.gapIds, 'Agent gaps', ids.gapIds, {min: 0, max: 40});
  if (request.task === 'explain-gap' && gapIds.length === 0) throw Error('Explain a captured gap before asking the agent to explain it.');
  const sourceRefs = sourceReferences(request.sourceRefs, 'Agent source references', projectMap, 40);
  if (!Array.isArray(request.tools) || request.tools.length > AGENT_TOOLS.length || request.tools.some(tool => !AGENT_TOOLS.includes(tool)) || new Set(request.tools).size !== request.tools.length) throw Error('The agent task requested a tool outside its read-only allowlist.');
  return Object.freeze({version: 1, task: request.task, traceId: graph.id, focusId, evidenceIds, gapIds, sourceRefs, tools: [...request.tools]});
}

function validateAgentExplanation(candidate, {graph, projectMap, allowedSourceRefs} = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw Error('A captured trace is required to validate an explanation.');
  if (!projectMap || !Array.isArray(projectMap.files)) throw Error('A current local project map is required to validate source references.');

  const explanation = ownRecord(candidate, ['version', 'summary', 'steps', 'unknowns', 'nextChecks'], 'Agent explanation');
  if (explanation.version !== 1) throw Error('Unsupported agent explanation version.');
  const {evidenceIds, gapIds} = graphEvidence(graph);
  const allowedSources = allowedSourceRefs ? new Set(allowedSourceRefs.map(ref => `${ref.path}\0${ref.line}\0${ref.hash}`)) : null;
  const checkedSources = (refs, label, limit = 8) => {
    const checked = sourceReferences(refs, label, projectMap, limit);
    if (allowedSources && checked.some(ref => !allowedSources.has(`${ref.path}\0${ref.line}\0${ref.hash}`))) throw Error(`${label} cites source that was not supplied to the model.`);
    return checked;
  };
  const summary = ownRecord(explanation.summary, ['text', 'evidenceIds', 'sourceRefs'], 'Explanation summary');
  const summaryEvidenceIds = boundedIds(summary.evidenceIds, 'Explanation summary', evidenceIds, {min: 0, max: 20});
  const summarySourceRefs = checkedSources(summary.sourceRefs, 'Explanation summary source', 8);
  if (!summaryEvidenceIds.length && !summarySourceRefs.length) throw Error('Explanation summary must cite current evidence or source.');

  const rows = (value, label, limit) => {
    if (!Array.isArray(value) || value.length > limit) throw Error(`${label} must be a bounded list.`);
    return value;
  };
  const steps = rows(explanation.steps, 'Explanation steps', 40).map((value, index) => {
    const step = ownRecord(value, ['text', 'evidenceIds', 'sourceRefs'], `Explanation step ${index + 1}`);
    const ids = boundedIds(step.evidenceIds, `Explanation step ${index + 1}`, evidenceIds, {min: 0, max: 12});
    const sources = checkedSources(step.sourceRefs, `Explanation step ${index + 1} source`, 8);
    if (!ids.length && !sources.length) throw Error(`Explanation step ${index + 1} must cite current evidence or source.`);
    return {text: boundedText(step.text, `Explanation step ${index + 1}`, 1200), evidenceIds: ids, sourceRefs: sources};
  });
  const unknowns = rows(explanation.unknowns, 'Unknowns', 40).map((value, index) => {
    const unknown = ownRecord(value, ['text', 'gapIds'], `Unknown ${index + 1}`);
    return { text: boundedText(unknown.text, `Unknown ${index + 1}`, 1200), gapIds: boundedIds(unknown.gapIds, `Unknown ${index + 1}`, gapIds, {min: 1, max: 12}) };
  });
  const nextChecks = rows(explanation.nextChecks, 'Next checks', 20).map((value, index) => {
    const check = ownRecord(value, ['text', 'sourceRefs'], `Next check ${index + 1}`);
    if (!Array.isArray(check.sourceRefs) || check.sourceRefs.length < 1 || check.sourceRefs.length > 8) throw Error(`Next check ${index + 1} must cite current source.`);
    const sourceRefs = checkedSources(check.sourceRefs, `Next check ${index + 1} source`, 8);
    return {text: boundedText(check.text, `Next check ${index + 1}`, 1200), sourceRefs};
  });

  // The result intentionally contains no graph, edge, coverage, or confidence field.
  // Callers must render it as a suggestion alongside the unchanged captured graph.
  return Object.freeze({version: 1, status: 'suggestion', summary: {text: boundedText(summary.text, 'Explanation summary', 2000), evidenceIds: summaryEvidenceIds, sourceRefs: summarySourceRefs}, steps, unknowns, nextChecks});
}

module.exports = {validateAgentRequest, validateAgentExplanation, AGENT_TOOLS};
