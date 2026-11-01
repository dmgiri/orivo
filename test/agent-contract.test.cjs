'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {validateAgentRequest, validateAgentExplanation, AGENT_TOOLS} = require('../engine/agent-contract.cjs');

const hash = 'a'.repeat(64);
function fixture() {
  return {
    graph: {id: 'trace-1', coverage: 'partial', nodes: [{id: 'element-1', kind: 'element'}, {id: 'gap-1', kind: 'gap', status: 'missing'}], edges: [{id: 'edge-1', from: 'element-1', to: 'gap-1'}]},
    projectMap: {files: [{path: 'src/view.tsx', hash, lineCount: 24}]},
    candidate: {version: 1, summary: {text: 'The selected element has a captured source binding.', evidenceIds: ['element-1'], sourceRefs: []}, steps: [{text: 'The element maps to the current source expression.', evidenceIds: ['element-1', 'edge-1'], sourceRefs: []}], unknowns: [{text: 'The backend link is not captured.', gapIds: ['gap-1']}], nextChecks: [{text: 'Exercise the request and capture it again.', sourceRefs: [{path: 'src/view.tsx', line: 8, hash}]}]},
  };
}

test('agent explanations are suggestions linked only to current evidence and source', () => {
  const {graph, projectMap, candidate} = fixture(), before = JSON.stringify(graph);
  const result = validateAgentExplanation(candidate, {graph, projectMap});
  assert.equal(result.status, 'suggestion');
  assert.equal(result.steps[0].evidenceIds[0], 'element-1');
  assert.equal(result.unknowns[0].gapIds[0], 'gap-1');
  assert.equal(result.nextChecks[0].sourceRefs[0].path, 'src/view.tsx');
  assert.equal('coverage' in result, false);
  assert.equal('nodes' in result, false);
  assert.equal(JSON.stringify(graph), before);
});

test('agent requests are trace-scoped and expose only the read-only tool allowlist', () => {
  const {graph, projectMap} = fixture(), before = JSON.stringify(graph);
  const request = validateAgentRequest({version: 1, task: 'explain-gap', traceId: graph.id, focusId: 'gap-1', evidenceIds: ['element-1'], gapIds: ['gap-1'], sourceRefs: [{path: 'src/view.tsx', line: 8, hash}], tools: [...AGENT_TOOLS]}, {graph, projectMap});
  assert.deepEqual(request.tools, ['search-project-map', 'read-source-excerpt', 'read-selected-trace']);
  assert.equal('coverage' in request, false);
  assert.equal('sourceText' in request, false);
  assert.equal(JSON.stringify(graph), before);
  assert.throws(() => validateAgentRequest({...request, tools: ['execute-shell']}, {graph, projectMap}), /outside its read-only allowlist/);
  assert.throws(() => validateAgentRequest({...request, traceId: 'different-trace'}, {graph, projectMap}), /different captured trace/);
});

test('agent output cannot invent evidence or present a gap as supporting evidence', () => {
  const {graph, projectMap, candidate} = fixture();
  const invented = structuredClone(candidate); invented.steps[0].evidenceIds = ['made-up'];
  assert.throws(() => validateAgentExplanation(invented, {graph, projectMap}), /current evidence/);
  const gapAsEvidence = structuredClone(candidate); gapAsEvidence.steps[0].evidenceIds = ['gap-1'];
  assert.throws(() => validateAgentExplanation(gapAsEvidence, {graph, projectMap}), /current evidence/);
  const inventedGap = structuredClone(candidate); inventedGap.unknowns[0].gapIds = ['made-up'];
  assert.throws(() => validateAgentExplanation(inventedGap, {graph, projectMap}), /current evidence/);
});

test('stale source and graph-mutating fields are rejected', () => {
  const {graph, projectMap, candidate} = fixture();
  const stale = structuredClone(candidate); stale.nextChecks[0].sourceRefs[0].hash = 'b'.repeat(64);
  assert.throws(() => validateAgentExplanation(stale, {graph, projectMap}), /stale or unavailable source/);
  assert.throws(() => validateAgentExplanation({...candidate, coverage: 'complete'}, {graph, projectMap}), /unsupported field/);
});

test('agent data accessors and oversized or uncited claims are rejected', () => {
  const {graph, projectMap, candidate} = fixture();
  const accessor = {...candidate};
  Object.defineProperty(accessor, 'summary', {enumerable: true, get() {throw Error('must not execute');}});
  assert.throws(() => validateAgentExplanation(accessor, {graph, projectMap}), /unsupported field/);
  const uncited = structuredClone(candidate); uncited.steps[0].evidenceIds = [];
  assert.throws(() => validateAgentExplanation(uncited, {graph, projectMap}), /must cite current evidence or source/);
  const summaryUncited = structuredClone(candidate); summaryUncited.summary.sourceRefs = []; summaryUncited.summary.evidenceIds = [];
  assert.throws(() => validateAgentExplanation(summaryUncited, {graph, projectMap}), /summary must cite current evidence or source/);
  assert.throws(() => validateAgentExplanation(candidate, {graph, projectMap, allowedSourceRefs: []}), /not supplied to the model/);
});

test('oversized sections and malformed source citations are rejected', () => {
  const {graph, projectMap, candidate} = fixture();
  const oversized = structuredClone(candidate); oversized.steps[0].text = 'x'.repeat(1201);
  assert.throws(() => validateAgentExplanation(oversized, {graph, projectMap}), /short, non-empty text/);
  const badLine = structuredClone(candidate); badLine.summary.sourceRefs = [{path: 'src/view.tsx', line: 0, hash}];
  assert.throws(() => validateAgentExplanation(badLine, {graph, projectMap}), /stale or unavailable source/);
  const tooMany = structuredClone(candidate); tooMany.steps = Array.from({length: 41}, () => structuredClone(candidate.steps[0]));
  assert.throws(() => validateAgentExplanation(tooMany, {graph, projectMap}), /bounded list/);
});
