'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {makeAgentRequest, validateExplanation} = require('../engine/agent-coordinator.cjs');

const hash = 'a'.repeat(64);
function graphFixture() {
  return {
    id: 'trace-1', coverage: 'partial', selector: '#patient-name',
    title: 'Patient Jane Doe', gaps: ['Backend trace is not connected.'],
    nodes: [
      {id: 'element-1', kind: 'element', label: 'Jane Doe', file: 'src/PatientCard.tsx', line: 8, meta: {value: 'Jane Doe', token: 'secret-token'}},
      {id: 'api-1', kind: 'api', label: 'GET /api/patients?name=Jane', method: 'GET', url: 'http://localhost/api/patients?name=Jane', file: 'src/api.ts', line: 4},
      {id: 'gap-1', kind: 'gap', status: 'missing', label: 'Backend trace unavailable'},
    ],
    edges: [{id: 'edge-1', from: 'element-1', to: 'api-1', kind: 'renders'}],
  };
}
function mapFixture() {
  return {
    fingerprint: 'b'.repeat(64),
    files: [{path: 'src/PatientCard.tsx', hash, lineCount: 20}, {path: 'src/api.ts', hash, lineCount: 20}],
    symbols: [{kind: 'component', name: 'PatientCard', path: 'src/PatientCard.tsx', line: 8, hash}, {kind: 'api-call', name: 'GET /api/patients', path: 'src/api.ts', line: 4, hash}],
    references: [],
  };
}

test('agent context keeps bounded evidence metadata and excludes runtime values', async () => {
  const graph = graphFixture(), projectMap = mapFixture();
  const index = {files: projectMap.files.map(file => ({...file, text: 'export const patient = "Jane Doe";\nexport const token = "secret-token";'}))};
  const built = await makeAgentRequest({graph, projectMap, index, task: 'explain-trace', focusId: 'element-1', readSource: (_index, file, line) => ({path: file, line, hash, code: 'return <span>{patient.name}</span>;\nconst token="secret-token";\nconst label="Jane Doe";'})});
  const serialized = JSON.stringify(built.messages);
  assert.equal(serialized.includes('Jane Doe'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('name=Jane'), false);
  assert.ok(serialized.includes('PatientCard'));
  assert.ok(serialized.includes('patient.name'));
  assert.ok(serialized.includes('[redacted sensitive source line]'));
  assert.equal(built.request.traceId, 'trace-1');
  assert.ok(built.request.sourceRefs.length > 0);
});

test('agent output accepts only supplied evidence and source citations', async () => {
  const graph = graphFixture(), projectMap = mapFixture();
  const built = await makeAgentRequest({graph, projectMap, task: 'explain-trace'}), request = built.request;
  const explanation = {version: 1, summary: {text: 'The selected value is rendered by the captured component.', evidenceIds: ['element-1'], sourceIds: []}, steps: [{text: 'The selected node maps to this component source.', evidenceIds: ['element-1'], sourceIds: ['S1']}], unknowns: [{text: 'Backend execution is missing from this capture.', gapIds: ['gap-1']}], nextChecks: [{text: 'Capture the request with backend tracing enabled.', sourceIds: ['S1']}]};
  const accepted = validateExplanation(explanation, {graph, projectMap, request});
  assert.equal(accepted.status, 'suggestion');
  assert.equal('coverage' in accepted, false);
  assert.deepEqual(accepted.steps[0].sourceRefs[0], request.sourceRefs[0]);
  assert.throws(() => validateExplanation({...explanation, steps: [{...explanation.steps[0], evidenceIds: ['invented']}]}, {graph, projectMap, request}), /current evidence/);
});

test('agent prompt constrains compact citations and expands them to verified source references', async () => {
  const graph = graphFixture(), projectMap = mapFixture();
  const built = await makeAgentRequest({graph, projectMap, task: 'explain-trace', readSource: () => null});
  const summarySchema = built.schema.properties.summary.properties;
  const sourceIds = summarySchema.sourceIds.items.enum;
  assert.ok(summarySchema.evidenceIds.items.enum.includes('element-1'));
  assert.ok(built.schema.properties.unknowns.items.properties.gapIds.items.enum.includes('gap-1'));
  assert.ok(sourceIds.length > 0);
  const explanation = {
    version: 1,
    summary: {text: 'The selected field is rendered by PatientCard.', evidenceIds: ['element-1'], sourceIds: [sourceIds[0]]},
    steps: [{text: 'The UI field maps to its React component.', evidenceIds: ['element-1'], sourceIds: [sourceIds[0]]}],
    unknowns: [{text: 'Backend execution was not captured.', gapIds: ['gap-1']}],
    nextChecks: [{text: 'Capture a request with backend tracing enabled.', sourceIds: [sourceIds[0]]}],
  };
  const accepted = validateExplanation(explanation, {graph, projectMap, request: built.request});
  assert.equal(accepted.status, 'suggestion');
  assert.deepEqual(accepted.summary.sourceRefs[0], built.request.sourceRefs[0]);
  assert.throws(() => validateExplanation({...explanation, summary: {...explanation.summary, sourceIds: ['invented']}}, {graph, projectMap, request: built.request}), /source ID/);
});

test('duplicate model citations are normalized before validation', async () => {
  const graph = graphFixture(), projectMap = mapFixture();
  const built = await makeAgentRequest({graph, projectMap, task: 'explain-trace'});
  const explanation = {
    version: 1,
    summary: {text: 'The selected field is rendered by PatientCard.', evidenceIds: ['element-1', 'element-1'], sourceIds: []},
    steps: [{text: 'The selected field maps to its component.', evidenceIds: ['element-1', 'element-1'], sourceIds: []}],
    unknowns: [{text: 'Backend execution was not captured.', gapIds: ['gap-1', 'gap-1']}],
    nextChecks: [],
  };
  const accepted = validateExplanation(explanation, {graph, projectMap, request: built.request});
  assert.deepEqual(accepted.summary.evidenceIds, ['element-1']);
  assert.deepEqual(accepted.steps[0].evidenceIds, ['element-1']);
  assert.deepEqual(accepted.unknowns[0].gapIds, ['gap-1']);
});

test('large captured traces are trimmed to the local context budget instead of failing', async () => {
  const hash = 'c'.repeat(64);
  const nodes = Array.from({length: 200}, (_, index) => ({id: `node-${index}`, kind: 'element', label: 'x', file: `src/Component${index}.tsx`, line: index + 1}));
  const edges = Array.from({length: 400}, (_, index) => ({id: `edge-${index}`, from: `node-${index % 200}`, to: `node-${(index + 1) % 200}`, kind: 'reads'}));
  const projectMap = {
    fingerprint: hash,
    files: nodes.map(node => ({path: node.file, hash, lineCount: 20})),
    symbols: nodes.map(node => ({kind: 'component', name: `Component${node.id}`, path: node.file, line: 8, hash})),
    references: nodes.map((node, index) => ({kind: 'import', from: {path: node.file, line: 1}, target: {path: nodes[(index + 1) % 200].file, line: 2}, status: 'candidate'})),
  };
  const index = {files: projectMap.files.map(file => ({...file, text: 'x'}))};
  const built = await makeAgentRequest({graph: {id: 'large-trace', coverage: 'partial', nodes, edges}, projectMap, index, task: 'explain-trace', focusId: 'node-199', readSource: (_index, file, line) => ({path: file, line, hash, code: 'const value = 1;\n'.repeat(300)})});
  const content = built.messages[1].content;
  const payload = JSON.parse(content.split('<untrusted-trace-and-source-data>')[1].split('</untrusted-trace-and-source-data>')[0]);
  assert.ok(Buffer.byteLength(content) <= 18_000, 'the rendered context must stay within the local budget');
  assert.ok(payload.trace.nodes.length < 200, 'the trace projection must be bounded');
  assert.ok(payload.trace.nodes.some(node => node.id === 'node-199'), 'the focused node must survive trimming');
  assert.ok(built.request.evidenceIds.every(id => payload.trace.nodes.some(node => node.id === id)), 'allowed evidence must remain visible in the supplied trace');
});


