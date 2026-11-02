'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const security = require('./host-security.cjs');
const engine = require('./engine/index.cjs');
const { startDemo } = require('./demo/server.cjs');
const { startBrokenDemo } = require('./demo-broken/server.cjs');
const { createWorkspaceStore } = require('./product-store.cjs');
const { createTraceStore, importEvidence } = require('./trace-store.cjs');
const { createProjectMapStore } = require('./project-map-store.cjs');
const { buildProjectMap, sourceFingerprint } = require('./engine/project-map.cjs');
const { createBundledModelProvider } = require('./engine/local-model.cjs');
const { MODEL_ASSET, RUNTIME_ASSET } = require('./engine/ai-assets.cjs');
const { makeAgentRequest, validateExplanation } = require('./engine/agent-coordinator.cjs');
const { verifiedEditorTarget } = require('./editor-source.cjs');
const { traceHealth, restartManagedSession } = require('./trace-health.cjs');
const { sessionNavigation } = require('./session-navigation.cjs');
const { runtimeProbe } = require('./page-runtime.cjs');
const { createDiagramStudio } = require('./diagram-studio.cjs');
const { traceToDiagram } = require('./trace-to-diagram.cjs');
const { diagnosticReport, redactDiagnosticText } = require('./product-diagnostics.cjs');
const { createGuidedSetup } = require('./adapters/tracing/guided.cjs');
const { createAutoAttach } = require('./adapters/tracing/auto-attach.cjs');
const guidedSetup = createGuidedSetup();
let setupPlan = null, setupBusy = false;

const root = __dirname;
const rendererUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const supportPayment = Object.freeze({ upiId: 'd369@axisbank' });
const profileSuffix = process.env.TRACE_ATLAS_TEST_PROFILE;
if (profileSuffix !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(profileSuffix)) throw Error('TRACE_ATLAS_TEST_PROFILE must be a short alphanumeric profile suffix.');
app.setName('Orivo');
const runtimeDirectory = profileSuffix
  ? path.join(app.isPackaged ? path.join(os.tmpdir(), 'orivo-tests') : path.join(root, '.tmp'), `test-profile-${profileSuffix}`)
  : app.isPackaged ? path.join(app.getPath('appData'), 'Orivo') : path.join(root, '.tmp', 'user-data');
fs.mkdirSync(runtimeDirectory, { recursive: true });
app.setPath('userData', runtimeDirectory);
app.setPath('sessionData', path.join(runtimeDirectory, 'sessions'));
const indexPreferenceFile = path.join(runtimeDirectory, 'source-index-profile.json');
let indexProfile = 'standard', indexingBusy = false;
try { if (fs.statSync(indexPreferenceFile).size <= 1024) { const preference = JSON.parse(fs.readFileSync(indexPreferenceFile, 'utf8')); if (Object.hasOwn(engine.INDEX_PROFILES, preference.profile)) indexProfile = preference.profile; } } catch {}
const indexRepository = folder => engine.indexRepository(folder, { profile: indexProfile });
const diagramStudio = createDiagramStudio({ runtimeDirectory: path.join(runtimeDirectory, 'diagrams') });
const diagramWindows = new Set();
let diagramPartition, diagramViewer;
const workspaces = createWorkspaceStore(runtimeDirectory);
const snapshots = createTraceStore(runtimeDirectory);
const projectMaps = createProjectMapStore(path.join(runtimeDirectory, 'project-maps'));
const localModel = createBundledModelProvider({
  runtimePath: path.join(root, 'resources', 'ai', 'runtime', RUNTIME_ASSET.release, 'llama-server.exe'),
  modelPath: path.join(root, 'model', MODEL_ASSET.file),
});
const recentErrors = [];
const ownsInstance = (!!profileSuffix && process.env.ORIVO_TEST_SINGLE_INSTANCE !== '1') || app.requestSingleInstanceLock();
if (!ownsInstance) {
  if (process.connected) process.send({ type: 'trace-atlas:existing' }, () => app.exit(0));
  else app.exit(0);
}
if (process.platform === 'win32') app.setAppUserModelId('com.orivo.desktop');
let window, preview, repoIndex = null, demoServer = null, demoServerPromise = null, demoKind = null, latestGraph = null, lastSelection = null, closing = false, shutdownPromise = null, shutdownExitCode = 0;
const capturedGraphs = new Map();
let contextRevision = 0, captureRevision = 0, repositoryRevision = 0, inspectRevision = 0, workspaceRevision = 0, desiredInspectMode = false;
let pageRuntimeRevision = 0;
let attachmentRevision = 0, attachmentBusy = false, automaticCleanup = Promise.resolve(), agentController = null;
let requestedBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }, dialogDepth = 0, previewResizing = false, resizeRevision = 0;
let state = { url: '', repository: null, loading: false, pageRuntime: 'unknown', inspectMode: false, previewMaximized: false, demo: false, onboarding: !profileSuffix || process.env.ORIVO_START_MODE === 'welcome', workspaceId: null, contextRevision: 0, attachment: null };
const send = (event, payload) => { if (window && !window.isDestroyed()) window.webContents.send(`trace-atlas:${event}`, payload); };
const publish = patch => { state = { ...state, ...patch }; send('state', state); return state; };
const reportError = error => { const message = String(error?.message || error).slice(0, 1200); recentErrors.push({ at: new Date().toISOString(), message }); if (recentErrors.length > 30) recentErrors.shift(); send('error', { message }); return message; };
const autoAttach = createAutoAttach({ runtimeDirectory: path.join(runtimeDirectory, 'automatic'), onState: (repository, attachment) => {
  if (!closing && state.repository?.path === repository) publish({ attachment });
} });
function stopAutomaticInBackground(repository) {
  attachmentRevision++;
  const previous = automaticCleanup;
  automaticCleanup = Promise.allSettled([previous, autoAttach.stop(repository)]).then(() => {});
}
function cancelAgent() { if (!agentController) return false; agentController.abort(); return true; }
function invalidateContext() { cancelAgent(); latestGraph = null; lastSelection = null; capturedGraphs.clear(); captureRevision++; inspectRevision++; desiredInspectMode = false; return { contextRevision: ++contextRevision }; }
function beginWorkspaceChange(preserveAutomatic = false) {
  const operation = ++workspaceRevision;
  if (!preserveAutomatic && state.repository?.path) stopAutomaticInBackground(state.repository.path);
  previewResizing = false; resizeRevision++;
  requestedBounds = { ...requestedBounds, visible: false }; renderPreviewBounds();
  publish({ ...invalidateContext(), inspectMode: false, previewMaximized: false, loading: true, workspaceId: null, attachment: preserveAutomatic ? state.attachment : null });
  if (preview && !preview.webContents.isDestroyed() && state.url) preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
  return operation;
}
function repositoryDetails(index) { return { name: path.basename(index.root), path: index.root, fileCount: index.files.length, skipped: index.skipped, truncated: index.truncated, limits: index.limits, profile: index.profile || 'standard', totalBytes: index.totalBytes }; }
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw Error('This action is available only to the trusted Orivo interface.');
}
function handle(name, fn) { ipcMain.handle(`trace-atlas:${name}`, async (event, ...args) => { trusted(event); try { return await fn(...args); } catch (error) { throw Error(reportError(error)); } }); }
function renderPreviewBounds() {
  if (!window || !preview) return;
  const [width, height] = window.getContentSize();
  const bounds = security.previewBounds(requestedBounds, { width, height });
  preview.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  preview.setVisible(bounds.visible && bounds.width > 5 && bounds.height > 5 && !dialogDepth && !previewResizing);
}
async function nativeDialog(operation) { dialogDepth++; renderPreviewBounds(); try { return await operation(); } finally { dialogDepth--; renderPreviewBounds(); } }
async function setPreviewResizing(value) {
  if (typeof value !== 'boolean') throw Error('Preview resizing state must be true or false.');
  const revision = ++resizeRevision, context = contextRevision;
  previewResizing = value;
  // A native child window can steal pointer capture as the divider crosses it.
  // Keep a temporary frame in the shell while the live view reflows behind it.
  const frame = value && preview && !preview.webContents.isDestroyed() && requestedBounds.visible
    ? preview.webContents.capturePage().catch(() => null) : null;
  renderPreviewBounds();
  const image = await frame;
  return image && revision === resizeRevision && context === contextRevision ? image.toDataURL() : null;
}
function setPreviewMaximized(value) {
  if (typeof value !== 'boolean') throw Error('Preview maximize state must be true or false.');
  if (value === state.previewMaximized) return state;
  requestedBounds = { ...requestedBounds, visible: false }; renderPreviewBounds();
  return publish({ previewMaximized: value });
}
async function connectRoot(directory, workspaceOperation = beginWorkspaceChange()) {
  const operation = ++repositoryRevision;
  const realRoot = await fsp.realpath(directory);
  const indexed = await indexRepository(realRoot);
  if (operation !== repositoryRevision || workspaceOperation !== workspaceRevision) return state;
  if (preview && !preview.webContents.isDestroyed() && state.url) await preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
  if (operation !== repositoryRevision || workspaceOperation !== workspaceRevision) return state;
  repoIndex = indexed;
  return publish({ ...invalidateContext(), inspectMode: false, loading: false, demo: demoServer?.root === realRoot, repository: repositoryDetails(indexed) });
}
async function refreshSource() {
  if (!repoIndex || !state.repository) throw Error('Connect a source folder before refreshing its index.');
  const authorizedRoot = state.repository.path, previousIndex = repoIndex, capturedContext = contextRevision, operation = ++repositoryRevision;
  const indexed = await security.rescanRepository(authorizedRoot, indexRepository);
  if (operation !== repositoryRevision || capturedContext !== contextRevision || repoIndex !== previousIndex || state.repository?.path !== authorizedRoot) throw Error('The source or application changed during refresh. Try refreshing the current source again.');
  repoIndex = indexed;
  const next = publish({ ...invalidateContext(), inspectMode: false, repository: repositoryDetails(indexed) });
  if (preview && !preview.webContents.isDestroyed() && state.url) preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
  return next;
}
async function setIndexProfile(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(engine.INDEX_PROFILES, profile)) throw Error('Choose a supported source index profile.');
  if (indexingBusy || attachmentBusy) throw Error('Wait for the current source or attachment operation.');
  if (!repoIndex || !state.repository) throw Error('Connect a source folder before changing its index profile.');
  const repository = state.repository.path, previousIndex = repoIndex, revision = contextRevision, operation = ++repositoryRevision;
  indexingBusy = true;
  try {
    const indexed = await security.rescanRepository(repository, folder => engine.indexRepository(folder, { profile }));
    if (operation !== repositoryRevision || revision !== contextRevision || previousIndex !== repoIndex || repository !== state.repository?.path) throw Error('The project changed during indexing. Apply the profile to the current project again.');
    // Commit the small preference synchronously after the ownership check, so
    // no workspace change can interleave persistence and index publication.
    fs.writeFileSync(indexPreferenceFile + '.tmp', JSON.stringify({ version: 1, profile }));
    fs.renameSync(indexPreferenceFile + '.tmp', indexPreferenceFile);
    indexProfile = profile;
    repoIndex = indexed;
    publish({ ...invalidateContext(), inspectMode: false, repository: repositoryDetails(indexed) });
    if (preview && !preview.webContents.isDestroyed() && state.url) preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
    return state;
  } finally { indexingBusy = false; }
}
async function readProjectMap() {
  if (!repoIndex || !state.repository || state.demo) throw Error('Connect your own source folder before building a local project map.');
  const repository = state.repository.path, initialContext = contextRevision, previousIndex = repoIndex;
  const indexed = await security.rescanRepository(repository, indexRepository);
  if (initialContext !== contextRevision || repository !== state.repository?.path) throw Error('The project changed while its local source map was being refreshed. Open the map again.');
  const fingerprint = sourceFingerprint(indexed), changed = sourceFingerprint(previousIndex) !== fingerprint;
  repoIndex = indexed;
  if (changed) {
    const next = publish({...invalidateContext(), repository: repositoryDetails(indexed)});
    if (preview && !preview.webContents.isDestroyed() && state.url) preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
    if (!next.repository || next.repository.path !== repository) throw Error('The project changed while its source map was being refreshed.');
  }
  const revision = contextRevision;
  const cached = await projectMaps.load(repository, fingerprint);
  if (revision !== contextRevision || repository !== state.repository?.path) throw Error('The project changed while its local source map was loading. Open the map again.');
  if (cached) return {map: cached, cached: true, cacheWarning: null};
  const map = await buildProjectMap(indexed);
  if (revision !== contextRevision || repository !== state.repository?.path) throw Error('The project changed while its local source map was being built. Open the map again.');
  let cacheWarning = null;
  try { await projectMaps.save(repository, map); }
  catch { cacheWarning = 'The map was built, but Orivo could not save its local cache.'; }
  return {map, cached: false, cacheWarning};
}
async function getLocalModels() {
  try {
    const models = await localModel.listModels();
    return {available: true, provider: 'Orivo Local AI', models, message: 'Bundled model ready · Qwen3 4B · runs on this machine.'};
  }
  catch (error) { return {available: false, provider: 'Orivo Local AI', models: [], message: error.message}; }
}
async function explainCapturedTrace(options) {
  if (agentController) throw Error('An explanation is already running. Cancel it before starting another.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['task', 'traceId', 'focusId', 'model'].includes(key))) throw Error('Invalid local explanation request.');
  const graph = latestGraph, repository = state.repository?.path, revision = contextRevision;
  if (!graph || graph.id !== options.traceId || !repository || state.demo || !repoIndex) throw Error('Capture a live trace in a connected project before asking for an explanation.');
  if (!['explain-trace', 'explain-gap'].includes(options.task)) throw Error('Choose Explain trace or Explain gap.');
  const controller = new AbortController();
  agentController = controller;
  try {
    send('agent-progress', {phase: 'model', message: 'Checking the bundled local model…'});
    const listedModels = await localModel.listModels({signal: controller.signal});
    if (!listedModels.includes(options.model)) throw Error('The bundled Orivo model is not ready. Refresh the model status and try again.');
    send('agent-progress', {phase: 'preparing', message: 'Preparing trace evidence and the local project map…'});
    const {map} = await readProjectMap();
    if (controller.signal.aborted || revision !== contextRevision || graph !== latestGraph || repository !== state.repository?.path) throw Error('The selected trace changed. Capture it again before explaining it.');
    const currentIndex = repoIndex;
    const built = await makeAgentRequest({graph, projectMap: map, index: currentIndex, task: options.task, focusId: options.focusId ?? null, readSource: engine.readSource});
    send('agent-progress', {phase: 'generating', message: 'Generating the explanation on this device…'});
    const raw = await localModel.explain({model: options.model, messages: built.messages, schema: built.schema, signal: controller.signal});
    if (controller.signal.aborted || revision !== contextRevision || graph !== latestGraph || repository !== state.repository?.path) throw Error('The selected trace changed before the explanation finished. Run it again on the current trace.');
    send('agent-progress', {phase: 'validating', message: 'Checking citations against the current source…'});
    const latestIndex = await security.rescanRepository(repository, indexRepository);
    if (controller.signal.aborted || revision !== contextRevision || repository !== state.repository?.path) throw Error('The project changed before the explanation could be checked.');
    if (sourceFingerprint(latestIndex) !== map.fingerprint) {
      repoIndex = latestIndex;
      publish({...invalidateContext(), repository: repositoryDetails(latestIndex)});
      throw Error('Project source changed during the explanation. Refresh and capture the trace again before asking the local model.');
    }
    repoIndex = latestIndex;
    const explanation = validateExplanation(raw, {graph, projectMap: map, request: built.request});
    return {explanation, model: options.model, provider: 'Orivo Local AI', traceId: graph.id, generatedAt: new Date().toISOString()};
  } finally { if (agentController === controller) agentController = null; }
}
async function captureElement(value) {
  if (!preview || preview.webContents.isDestroyed() || !state.url) throw Error('Open an application first.');
  const target = security.selection(value === undefined ? lastSelection : typeof value === 'string' ? (lastSelection?.selector === value ? lastSelection : { selector: value }) : value);
  if (target.cancelled) { inspectRevision++; desiredInspectMode = false; publish({ inspectMode: false }); return null; }
  const capturedContext = contextRevision, operation = ++captureRevision;
  const stopInspectOperation = ++inspectRevision;
  desiredInspectMode = false;
  await preview.webContents.executeJavaScript(engine.getPickerScript(false));
  if (capturedContext !== contextRevision || operation !== captureRevision) return null;
  if (stopInspectOperation === inspectRevision) publish({ inspectMode: false });
  send('selection', target);
  const snapshot = await preview.webContents.executeJavaScript(engine.getPageReaderScript(target.selector));
  if (capturedContext !== contextRevision || operation !== captureRevision) return null;
  if (!snapshot || typeof snapshot !== 'object' || JSON.stringify(snapshot).length > 2200000) throw Error('The application returned an invalid or oversized trace.');
  if(snapshot.selectionChanged===true)throw Error('The selected element changed while its trace was arriving. Select it again to capture its current value.');
  const graph = engine.resolveTrace({ index: repoIndex, url: preview.webContents.getURL(), trace: snapshot.trace, frames: snapshot.frames || [], target, runtimeAvailable: snapshot.runtimeAvailable, hierarchyNote: snapshot.hierarchyNote });
  cancelAgent();
  latestGraph = graph;
  lastSelection = target;
  capturedGraphs.set(graph.id, graph);
  while (capturedGraphs.size > 20) capturedGraphs.delete(capturedGraphs.keys().next().value);
  if (state.previewMaximized) setPreviewMaximized(false);
  send('trace', graph);
  return graph;
}
async function openUrl(value, demo = false, workspaceOperation) {
  const requested = security.appUrl(value);
  const navigation = sessionNavigation(requested, state.attachment);
  const url = security.appUrl(navigation.url);
  pageRuntimeRevision++;
  const sameSession = state.attachment?.active && state.attachment.url && new URL(url).origin === new URL(state.attachment.url).origin;
  const operation = workspaceOperation ?? beginWorkspaceChange(!!sameSession);
  if (operation !== workspaceRevision) return state;
  publish({ ...invalidateContext(), url, loading: true, pageRuntime: 'checking', inspectMode: false, demo, onboarding: false });
  try { await preview.webContents.loadURL(url); }
  catch (error) { if (operation !== workspaceRevision) return state; publish({ loading: false }); throw error; }
  return state;
}
async function openDemo(kind = 'working') {
  const operation = beginWorkspaceChange();
  if (demoKind !== kind && demoServer) { await demoServer.close(); demoServer = null; demoServerPromise = null; }
  demoKind = kind;
  if (!demoServerPromise) demoServerPromise = (kind === 'broken' ? startBrokenDemo : startDemo)().then(server => (demoServer = server)).catch(error => { demoServerPromise = null; throw error; });
  await demoServerPromise;
  if (operation !== workspaceRevision) return state;
  await connectRoot(demoServer.root, operation);
  if (operation !== workspaceRevision) return state;
  return openUrl(demoServer.url, true, operation);
}
async function openWorkspace(id) {
  const saved = await workspaces.get(id);
  let currentRoot;
  try { currentRoot = await fsp.realpath(saved.repositoryPath); }
  catch { throw Error('This workspace source folder is unavailable. Choose the folder again in Connect project.'); }
  if (currentRoot !== saved.repositoryPath) throw Error('This source folder now points somewhere else. Choose the folder again in Connect project.');
  const operation = beginWorkspaceChange();
  try {
    await connectRoot(currentRoot, operation);
    if (operation !== workspaceRevision) return state;
    if (saved.attachment) await startAutomaticAttachment(saved.attachment, operation, saved.url);
    else await openUrl(saved.url, false, operation);
    if (operation !== workspaceRevision) return state;
    await workspaces.touch(id);
    if (operation === workspaceRevision) publish({ workspaceId: id });
    return state;
  } catch (error) { if (operation === workspaceRevision) publish({ loading: false }); throw error; }
}
async function detectAutomaticAttachment() {
  if (!state.repository || state.demo) throw Error('Choose your project folder before attaching tracing.');
  const repository = state.repository.path, revision = contextRevision;
  const result = await security.rescanRepository(repository, async folder => ({ root: folder, detection: await autoAttach.detect(folder, { url: state.url || undefined }) }));
  if (revision !== contextRevision || repository !== state.repository?.path) throw Error('The project changed during detection. Attach the current project again.');
  return result.detection;
}
async function startAutomaticAttachment(options = {}, workspaceOperation, requestedUrl) {
  if (!state.repository || state.demo) throw Error('Choose your project folder before attaching tracing.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['frontend', 'backend', 'url', 'urlMode'].includes(key)) || ['frontend', 'backend'].some(key => options[key] !== undefined && options[key] !== null && (typeof options[key] !== 'string' || options[key].length > 500)) || options.urlMode !== undefined && !['provided', 'separate'].includes(options.urlMode)) throw Error('Choose detected applications and an application URL for automatic attachment.');
  const enteredUrl = options.url === undefined ? undefined : security.appUrl(options.url);
  if (attachmentBusy) throw Error('Wait for the current attachment operation or stop it.');
  const repository = state.repository.path, entryWorkspace = workspaceRevision, entryAttachment = attachmentRevision;
  let operation = workspaceOperation;
  attachmentBusy = true;
  try {
    await security.rescanRepository(repository, async folder => ({ root: folder }));
    await automaticCleanup;
    if (repository !== state.repository?.path || entryWorkspace !== workspaceRevision || entryAttachment !== attachmentRevision || (workspaceOperation !== undefined && workspaceOperation !== workspaceRevision)) throw Error('The project changed. Attach the current project again.');
    const previousUrl = requestedUrl || enteredUrl || state.url || undefined;
    operation = workspaceOperation ?? beginWorkspaceChange(true);
    const revision = ++attachmentRevision;
    const result = await autoAttach.start(repository, { ...options, url: previousUrl });
    if (revision !== attachmentRevision || operation !== workspaceRevision || repository !== state.repository?.path) {
      await autoAttach.stop(repository); return state;
    }
    if (result.status !== 'running' || !result.url) throw Error(result.notice || 'The traced development session could not start.');
    await openUrl(result.url, false, operation);
    if (operation === workspaceRevision) publish({ attachment: result });
    return state;
  } catch (error) {
    if (operation === workspaceRevision) publish({ loading: false });
    throw error;
  } finally { attachmentBusy = false; }
}
async function stopAutomaticAttachment() {
  if (!state.repository) return state;
  const repository = state.repository.path, operation = workspaceRevision;
  attachmentRevision++;
  const result = await autoAttach.stop(repository);
  if (operation === workspaceRevision && repository === state.repository?.path) {
    requestedBounds = { ...requestedBounds, visible: false }; renderPreviewBounds();
    if (preview && !preview.webContents.isDestroyed()) preview.webContents.stop();
    publish({ ...invalidateContext(), attachment: result, url: '', loading: false, inspectMode: false });
  }
  return state;
}
async function restartAndRecapture() {
  if (!state.repository || state.demo) throw Error('Connect your project before restarting a managed session.');
  if (attachmentBusy) throw Error('Wait for the current attachment operation.');
  const repository = state.repository.path, current = await autoAttach.state(repository);
  if (attachmentBusy || state.repository?.path !== repository || closing) throw Error('The project or attachment operation changed. Try restarting the current session again.');
  if (!current.frontend) throw Error('Attach tracing to a detected application before restarting its session.');
  const selection = lastSelection && { ...lastSelection }, expectsData = (latestGraph?.summary?.requests || 0) > 0, previousUrl = state.url || current.url;
  const operation = beginWorkspaceChange(true), revision = ++attachmentRevision;
  const check = () => { if (closing || operation !== workspaceRevision || revision !== attachmentRevision || repository !== state.repository?.path) throw Error('The project or session changed during restart.'); };
  attachmentBusy = true;
  try {
    await automaticCleanup; check();
    await restartManagedSession({ repository, options: { frontend: current.frontend, backend: current.backend }, url: previousUrl, check,
      stop: folder => autoAttach.stop(folder),
      rescan: folder => security.rescanRepository(folder, indexRepository),
      start: (folder, options) => autoAttach.start(folder, options),
      open: async (url, index, attachment) => { check(); repoIndex = index; publish({ repository: repositoryDetails(index), attachment }); await openUrl(url, false, operation); },
    });
    check();
    if (!selection) return { state, graph: null, recaptured: false, notice: 'Session restarted with the current source. Select an element to capture its path.' };
    // Reloading may require signing in again. Wait only for this selector's
    // binding; never replay application clicks or submit a previous action.
    const ready = await preview.webContents.executeJavaScript(`new Promise(resolve => { const selector=${JSON.stringify(selection.selector)},expectsData=${JSON.stringify(expectsData)}; const started=Date.now(); const selected=element=>({label:String(element.textContent||selector).trim().slice(0,200),tag:String(element.tagName||'element').toLowerCase()}); const poll=()=>{let element=null,map=null;try{element=document.querySelector(selector);map=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value;if(element&&map&&WeakMap.prototype.has.call(map,element)){const binding=WeakMap.prototype.get.call(map,element);if(!expectsData||Array.isArray(binding?.dependencies)&&binding.dependencies.length)return resolve(selected(element));}}catch{}if(Date.now()-started>6000)return resolve(element?selected(element):null);setTimeout(poll,100);};poll();})`);
    check();
    if (!ready) return { state, graph: null, recaptured: false, notice: 'Session restarted. The previous element is not on this page; sign in or navigate to it, then select it again.' };
    const graph = await captureElement({ ...selection, ...ready }); check();
    return { state, graph, recaptured: !!graph, notice: graph ? 'Session restarted and the previous element was captured from the current source.' : 'Session restarted. Select the element again to capture its path.' };
  } catch (error) {
    if (operation === workspaceRevision) publish({ loading: false });
    throw error;
  } finally { attachmentBusy = false; }
}
async function openInEditor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['graphId', 'nodeId'].includes(key)) || typeof options.graphId !== 'string' || typeof options.nodeId !== 'string') throw Error('Choose a current captured source block to open in VS Code.');
  const graph = capturedGraphs.get(options.graphId), node = graph?.nodes.find(row => row.id === options.nodeId);
  if (!repoIndex || !state.repository || !node || !repoIndex.files.some(file => file.path === node.file)) throw Error('Editor navigation is available for current captured repository source only.');
  const context = contextRevision, repository = state.repository.path;
  const target = await verifiedEditorTarget(repository, node);
  if (context !== contextRevision || repository !== state.repository?.path || capturedGraphs.get(options.graphId) !== graph) throw Error('The project changed. Capture the current element again before opening its source.');
  await shell.openExternal(target.url);
  return { path: target.path, line: target.line, editor: 'VS Code' };
}
async function toggleInspect() {
  if (!state.url || state.loading) throw Error('Wait for an application to finish loading.');
  const capturedContext = contextRevision, operation = ++inspectRevision, enabled = !desiredInspectMode;
  desiredInspectMode = enabled;
  try { await preview.webContents.executeJavaScript(engine.getPickerScript(enabled)); }
  catch (error) {
    if (capturedContext !== contextRevision || operation !== inspectRevision) return state;
    desiredInspectMode = state.inspectMode;
    throw error;
  }
  if (capturedContext !== contextRevision || operation !== inspectRevision) return state;
  return publish({ inspectMode: enabled });
}
function harden(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  const navigate = (event, url) => {
    try {
      const target = security.appUrl(event.url ?? url);
      const navigation = sessionNavigation(target, contents === preview?.webContents ? state.attachment : null);
      if (navigation.redirected) {
        event.preventDefault();
        openUrl(navigation.url).catch(reportError);
      }
    } catch (error) { event.preventDefault(); reportError(error); }
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
}
async function openDiagramViewer(id, appearance = 'dark') {
  if (!['dark','light'].includes(appearance)) throw Error('Choose a light or dark diagram appearance.');
  const artifact = diagramStudio.artifact(id), allowedOrigin = new URL(artifact.url).origin;
  if (diagramViewer && !diagramViewer.isDestroyed()) {
    diagramViewer.__diagramId = id;
    await diagramViewer.loadURL(artifact.url + '?theme=' + appearance);
    diagramViewer.setTitle(artifact.title + ' — Orivo Diagrams');
    diagramViewer.show();diagramViewer.focus();return { ...artifact, opened: true };
  }
  if (!diagramPartition) {
    diagramPartition = session.fromPartition('orivo-diagrams');
    diagramPartition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    diagramPartition.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    diagramPartition.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        if (['blob:','data:'].includes(url.protocol)) return callback({ cancel: false });
        const artifact = diagramStudio.artifact(url.pathname.slice(1));
        callback({ cancel: new URL(artifact.url).origin !== url.origin });
      } catch { callback({ cancel: true }); }
    });
  }
  const viewer = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 600, parent: window, title: artifact.title + ' — Orivo Diagrams', autoHideMenuBar: true, backgroundColor: appearance === 'light' ? '#f4f5f7' : '#020617', webPreferences: { session: diagramPartition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  diagramViewer = viewer;viewer.__diagramId = id;
  diagramWindows.add(viewer);
  viewer.on('closed', () => diagramWindows.delete(viewer));
  viewer.webContents.on('will-attach-webview', event => event.preventDefault());
  const guard = (event, fallback) => { try { const url = new URL(event.url ?? fallback); if (url.origin !== allowedOrigin || url.pathname !== '/' + viewer.__diagramId) event.preventDefault(); } catch { event.preventDefault(); } };
  viewer.webContents.on('will-navigate', guard);
  viewer.webContents.on('will-redirect', guard);
  viewer.webContents.setWindowOpenHandler(({ url }) => { try { const external = security.appUrl(url); if (new URL(external).protocol === 'https:') shell.openExternal(external).catch(reportError); } catch {} return { action: 'deny' }; });
  await viewer.loadURL(artifact.url + '?theme=' + appearance);
  return { ...artifact, opened: true };
}
function installIpc() {
  handle('get-state', () => state);
  handle('window-appearance', mode => {
    if (!['dark','light'].includes(mode)) throw Error('Choose a light or dark appearance.');
    if (process.platform === 'win32' && window && !window.isDestroyed()) window.setTitleBarOverlay({ color: mode === 'dark' ? '#191A1B' : '#E3EFF9', symbolColor: mode === 'dark' ? '#BFBFBF' : '#202020', height: 35 });
    return { overlay: process.platform === 'win32' };
  });
  handle('diagram-info', () => diagramStudio.info());
  handle('diagram-trace', () => JSON.stringify(traceToDiagram(latestGraph), null, 2));
  handle('diagram-appearance', async (preset, appearance) => {
    if (!['classic','signal-flow','blueprint','editorial'].includes(preset) || !['dark','light'].includes(appearance)) throw Error('Choose an original Archify theme and appearance.');
    await Promise.all([...diagramWindows].filter(viewer => !viewer.isDestroyed()).map(viewer => viewer.webContents.executeJavaScript(`(()=>{const mode=${JSON.stringify(appearance)},preset=${JSON.stringify(preset)};if(document.documentElement.dataset.theme!==mode)document.querySelector('#btn-theme')?.click();document.querySelector('[data-preset-value="'+preset+'"]')?.click();})()`).catch(() => {})));
    return { preset, appearance };
  });
  handle('diagram-example', type => diagramStudio.example(type));
  handle('diagram-comparison-example', () => diagramStudio.compareExample());
  handle('diagram-render', options => diagramStudio.render(options));
  handle('diagram-open', (id, appearance) => openDiagramViewer(id, appearance));
  handle('diagram-import', async () => {
    const selected = await nativeDialog(() => dialog.showOpenDialog(window, { title: 'Import Archify diagram source', properties: ['openFile'], filters: [{ name: 'Archify JSON', extensions: ['json'] }] }));
    if (selected.canceled || !selected.filePaths[0]) return null;
    const file = selected.filePaths[0], stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('Choose a diagram JSON file smaller than 2 MiB.');
    return { text: await fsp.readFile(file, 'utf8'), name: path.basename(file) };
  });
  handle('diagram-export', async (id, format) => {
    const artifact = diagramStudio.artifact(id), bytes = await diagramStudio.bytes(id, format);
    const extension = format === 'html' ? 'html' : 'json';
    const result = await nativeDialog(() => dialog.showSaveDialog(window, { title: 'Export Orivo diagram', defaultPath: 'orivo-' + artifact.type + (format === 'receipt' ? '-receipt' : '') + '.' + extension, filters: [{ name: format === 'html' ? 'Standalone interactive HTML' : 'Diagram JSON', extensions: [extension] }] }));
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, bytes);return { path: result.filePath, bytes: bytes.length };
  });
  handle('set-index-profile', setIndexProfile);
  handle('detect-attachment', detectAutomaticAttachment);
  handle('start-attachment', options => startAutomaticAttachment(options));
  handle('stop-attachment', stopAutomaticAttachment);
  handle('restart-and-recapture', restartAndRecapture);
  handle('get-trace-health', async () => traceHealth({ state, graph: latestGraph, managed: state.repository ? await autoAttach.state(state.repository.path) : null, busy: attachmentBusy, hasSelection: !!lastSelection }));
  handle('get-snapshots', () => snapshots.list());
  handle('pin-trace', async (graphId, name) => { const graph = capturedGraphs.get(graphId); if (!graph) throw Error('Select a captured session trace before saving a snapshot.'); if (name !== undefined && (typeof name !== 'string' || name.length > 100)) throw Error('Use a snapshot name of up to 100 characters.'); return snapshots.save(graph, { name, repositoryName: state.repository?.name || '', repositoryPath: state.repository?.path }); });
  handle('open-snapshot', id => snapshots.open(id));
  handle('remove-snapshot', id => snapshots.remove(id));
  handle('compare-snapshots', (leftId, rightId) => snapshots.compare(leftId, rightId));
  handle('import-trace', async () => { const result = await nativeDialog(() => dialog.showOpenDialog(window, { title: 'Import a read-only Orivo trace', properties: ['openFile'], filters: [{ name: 'Orivo evidence JSON', extensions: ['json'] }] })); if (result.canceled || !result.filePaths[0]) return null; const graph = await importEvidence(result.filePaths[0]); const snapshot = await snapshots.save(graph, { imported: true }); return { snapshot, graph: await snapshots.open(snapshot.id) }; });
  handle('open-in-editor', openInEditor);
  handle('tracing-setup', async () => {
    if(!state.repository)throw Error('Connect your source folder before checking tracing setup.');
    const revision=contextRevision,repository=state.repository.path;
    const [setup,guided]=await Promise.all([security.rescanRepository(repository,engine.describeSetup),guidedSetup.state(repository)]);
    if(revision!==contextRevision||state.repository?.path!==repository)throw Error('The project changed while checking tracing setup. Open setup again for the current project.');
    return {...setup,guided,canConfigure:!state.demo,url:state.url,runtime:{status:latestGraph?.captured?'captured':latestGraph?.reason||'unknown',reason:latestGraph?.reason||null}};
  });
  handle('preview-tracing-setup', async options => {
    if(!state.repository||state.demo)throw Error('Connect your own source folder before configuring tracing.');
    if(setupBusy)throw Error('Wait for the current tracing setup operation.');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['frontend','backend','backendOnly'].includes(key))||(options.backendOnly!==undefined&&typeof options.backendOnly!=='boolean'))throw Error('Invalid tracing setup options.');
    const revision=contextRevision,repository=state.repository.path;
    const setup=await security.rescanRepository(repository,engine.describeSetup);
    if(!options.backendOnly&&setup.existingTracing?.some(row=>row.directory===(options.frontend||setup.frontends.find(row=>row.guided)?.directory)))throw Error('This frontend already has tracing. Enable its existing configuration instead of adding another plugin.');
    const origin=state.url?new URL(state.url).origin:null;
    const plan=await guidedSetup.preview(repository,{...options,appOrigin:origin});
    if(revision!==contextRevision||state.repository?.path!==repository)throw Error('The project changed. Preview tracing setup again.');
    setupPlan={id:plan.id,revision,repository,origin};
    return plan;
  });
  handle('apply-tracing-setup', async id => {
    const plan=setupPlan;
    if(setupBusy)throw Error('Wait for the current tracing setup operation.');
    if(!plan||id!==plan.id||plan.revision!==contextRevision||plan.repository!==state.repository?.path||state.demo)throw Error('The project changed. Preview tracing setup again.');
    setupBusy=true;setupPlan=null;
    try{
      await security.rescanRepository(plan.repository,async root=>({root}));
      if(plan.revision!==contextRevision||plan.repository!==state.repository?.path)throw Error('The project changed. Preview tracing setup again.');
      return await guidedSetup.apply(plan.repository,id,state.url?new URL(state.url).origin:null);
    }finally{setupBusy=false;}
  });
  handle('undo-tracing-setup', async options => {
    if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='backendOnly')||typeof options.backendOnly!=='boolean'))throw Error('Invalid tracing removal options.');
    if(!state.repository||state.demo)throw Error('Connect your own source folder before changing tracing setup.');
    if(setupBusy)throw Error('Wait for the current tracing setup operation.');
    const repository=state.repository.path,revision=contextRevision;
    setupBusy=true;setupPlan=null;
    try{
      await security.rescanRepository(repository,async root=>({root}));
      if(revision!==contextRevision||repository!==state.repository?.path)throw Error('The project changed. Open tracing setup again.');
      return await guidedSetup.undo(repository,options);
    }finally{setupBusy=false;}
  });
  handle('product-info', async () => ({
    name: 'Orivo', version: app.getVersion(), channel: 'beta', packaged: app.isPackaged,
    platform: process.platform, architecture: process.arch, dataDirectory: runtimeDirectory,
    diagnosticsAvailable: true, storageWarning: await workspaces.warning(),
    support: [
      'Windows desktop for individual developers',
      'Automatic managed attachment for installed React/Vite frontends and detected Python or Node backend applications',
      'FastAPI / SQLAlchemy direct ORM and DTO fields, Node built-in SQLite and pg PostgreSQL result fields',
      'Next.js client / webpack and other framework configurations have limited beta coverage',
      'Complete paths require captured runtime and field-origin evidence. Unsupported mappings remain explicit.'
    ],
    supportPayment,
    privacy: 'No account or automatic telemetry. Automatic attachment runs your selected development app in owned local processes and preserves project source. Optional manual setup changes require Apply reviewed setup.'
  }));
  handle('get-workspaces', () => workspaces.list());
  handle('save-workspace', async options => {
    if (!state.repository || !state.url || state.demo) throw Error('Connect your source folder and open your running application before saving a workspace.');
    if (demoServer && state.repository.path === demoServer.root) throw Error('Choose your own source folder before saving a project. The demo source is not a saved project.');
    if (state.loading) throw Error('Wait for your application to finish loading before saving.');
    const savedContext = contextRevision;
    const managedOrigin = state.attachment?.status === 'running' && state.attachment.url && new URL(state.url).origin === new URL(state.attachment.url).origin;
    const attachment = managedOrigin ? { frontend: state.attachment.frontend, backend: state.attachment.backend ?? null } : undefined;
    const record = await workspaces.save({ name: options?.name || state.repository.name, url: state.url, repositoryPath: state.repository.path, attachment });
    if (savedContext === contextRevision) publish({ workspaceId: record.id });
    return record;
  });
  handle('open-workspace', openWorkspace);
  handle('remove-workspace', async id => { const records = await workspaces.remove(id); if (state.workspaceId === id) publish({ workspaceId: null }); return records; });
  handle('export-diagnostics', async () => {
    const result = await nativeDialog(() => dialog.showSaveDialog(window, { title: 'Export local diagnostics', defaultPath: 'orivo-diagnostics.json', filters: [{ name: 'JSON diagnostics', extensions: ['json'] }] }));
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, JSON.stringify(diagnosticReport({ version: app.getVersion(), packaged: app.isPackaged, state, errors: recentErrors }), null, 2), 'utf8');
    return { path: result.filePath };
  });
  handle('connect-repository', async () => {
    const result = await nativeDialog(() => dialog.showOpenDialog(window, { title: 'Connect a repository', properties: ['openDirectory'] }));
    if (result.canceled || !result.filePaths[0]) return null;
    const wasDemo = state.demo;
    const operation = beginWorkspaceChange();
    try {
      await connectRoot(result.filePaths[0], operation);
      if (operation !== workspaceRevision) return state;
      if (wasDemo) {
        preview.webContents.stop();
        publish({ demo: false, url: '', loading: false });
        requestedBounds = { ...requestedBounds, visible: false }; renderPreviewBounds();
      }
      return state;
    }
    catch (error) { if (operation === workspaceRevision) publish({ loading: false }); throw error; }
  });
  handle('open-app', url => openUrl(url));
  handle('open-demo', async () => { try { return await openDemo('working'); } catch (error) { publish({ loading: false }); throw error; } });
  handle('open-broken-demo', async () => { try { return await openDemo('broken'); } catch (error) { publish({ loading: false }); throw error; } });
  handle('inspect', toggleInspect);
  handle('capture', selector => captureElement(selector));
  handle('refresh', async () => { if (!state.url) return state; publish({ ...invalidateContext(), inspectMode: false, loading: true }); preview.webContents.reload(); return state; });
  handle('rescan-source', refreshSource);
  handle('get-project-map', readProjectMap);
  handle('get-local-models', getLocalModels);
  handle('explain-agent', explainCapturedTrace);
  handle('cancel-agent', () => ({cancelled: cancelAgent()}));
  handle('clear-project-map', async () => {
    if (!state.repository || state.demo) throw Error('Connect your own source folder before clearing its local project map.');
    const repository = state.repository.path, revision = contextRevision;
    const result = await projectMaps.clear(repository);
    if (revision !== contextRevision || repository !== state.repository?.path) throw Error('The project changed while its local map was being cleared.');
    return result;
  });
  handle('preview-bounds', bounds => { const [width, height] = window.getContentSize(); requestedBounds = security.previewBounds(bounds, { width, height }); renderPreviewBounds(); return true; });
  handle('preview-maximized', setPreviewMaximized);
  handle('preview-resizing', setPreviewResizing);
  handle('read-source', async options => {
    if (!repoIndex || !state.repository) throw Error('Connect a repository to open its source.');
    const sourcePath = security.relativePath(options?.path);
    const line = options?.line === undefined ? 1 : options.line;
    if (!Number.isInteger(line) || line < 1 || line > 1000000) throw Error('Invalid source line.');
    const file = await fsp.realpath(path.join(state.repository.path, sourcePath));
    if (!security.within(state.repository.path, file)) throw Error('Source path is outside the connected repository.');
    return engine.readSource(repoIndex, sourcePath, line);
  });
  handle('export-trace', async graphId => {
    const graph = graphId === undefined || graphId === null ? latestGraph : capturedGraphs.get(graphId);
    if (!graph) throw Error('Select an element before exporting its trace. Only captured session traces can be exported.');
    const result = await nativeDialog(() => dialog.showSaveDialog(window, { title: 'Export captured trace', defaultPath: 'orivo-evidence.json', filters: [{ name: 'JSON evidence', extensions: ['json'] }] }));
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, JSON.stringify({ format: 'trace-atlas-evidence', version: 1, exportedAt: new Date().toISOString(), graph }, null, 2), 'utf8');
    return { path: result.filePath };
  });
  handle('export-kit', async () => {
    const result = await nativeDialog(() => dialog.showOpenDialog(window, { title: 'Choose a parent folder for a NEW integration kit', properties: ['openDirectory', 'createDirectory'] }));
    if (result.canceled || !result.filePaths[0]) return null;
    const name = `orivo-kit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const destination = path.join(result.filePaths[0], name);
    await fsp.mkdir(destination, { recursive: false });
    await fsp.cp(path.join(root, 'adapters', 'tracing'), path.join(destination, 'adapters'), { recursive: true, force: false, errorOnExist: true });
    const guide = '# Orivo integration kit\n\nThese opt-in development adapters record evidence from your running application. They do not infer a database column from matching text. Keep them restricted to development.\n\n1. Serve adapters/browser.mjs and its adjacent trace-codec.mjs from your app origin, then import request, bind, derive and action from browser.mjs.\n2. Replace the request you want to observe with request("/api/products"). Use result.field("products.0.price") and bind(element, {path:"src/Product.js",line:12,hash:"SHA256_OF_SOURCE"}, [field]). Source paths are relative to your selected repository.\n3. For Node built-in SQLite, use begin(repositoryRoot, request.headers["x-studio-trace"]); then trace.read(database, sql, parameters). Call result.field(rowIndex, resultColumn, "response.field.path") for each mapped response field. Return trace.header() in the Studio-Trace response header.\n4. Connect the same repository in Orivo, open your development URL, select an element. Changed source hashes and missing adapters are shown as gaps.\n\nThe bundled demo in Orivo demonstrates a full, runnable implementation. Other databases and frameworks require adapters; unsupported paths remain explicit. Do not expose this instrumentation to untrusted users or production traffic.\n';
    await fsp.writeFile(path.join(destination, 'README.md'), guide, { flag: 'wx' });
    return { path: destination };
  });
}
async function createWindow() {
  const partition = session.fromPartition('trace-atlas-preview');
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    const protocol = new URL(details.url).protocol;
    const allowedSubresource = ['http:', 'https:', 'data:', 'blob:'].includes(protocol);
    callback({ cancel: !allowedSubresource });
  });
  window = new BrowserWindow({ width: 1580, height: 980, minWidth: 1100, minHeight: 700, title: 'Orivo', icon: path.join(root, 'resources', 'orivo.ico'), backgroundColor: '#191A1B', show: false, autoHideMenuBar: true, ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#191A1B', symbolColor: '#BFBFBF', height: 35 } } : {}), webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-finish-load', () => { previewResizing = false; resizeRevision++; renderPreviewBounds(); send('state', state); if (latestGraph) send('trace', latestGraph); });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (closing || !window || window.isDestroyed()) return;
    requestedBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
    reportError(Error(`The workspace interface stopped (${details.reason}).`));
    const result = await nativeDialog(() => dialog.showMessageBox(window, { type: 'error', title: 'Restore Orivo', message: 'The workspace interface stopped responding.', detail: 'Reload the interface to restore the current application and captured path.', buttons: ['Reload workspace', 'Close Orivo'], defaultId: 0, cancelId: 1 }));
    if (closing || !window || window.isDestroyed()) return;
    if (result.response === 0) window.webContents.reload(); else app.quit();
  });
  preview = new WebContentsView({ webPreferences: { partition: 'trace-atlas-preview', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false } });
  window.contentView.addChildView(preview);
  preview.setVisible(false);
  harden(preview.webContents);
  preview.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isAutoRepeat || !state.previewMaximized || state.inspectMode) return;
    event.preventDefault();
    setPreviewMaximized(false);
    if (window && !window.isDestroyed()) window.webContents.focus();
  });
  // A navigation attempt may be cancelled by will-navigate. Publish its URL
  // only after commitment, so a blocked link cannot mislabel the preview.
  preview.webContents.on('did-start-loading', () => publish({ loading: true }));
  preview.webContents.on('did-stop-loading', () => publish({ loading: false }));
  preview.webContents.on('did-navigate', (_event, url) => { pageRuntimeRevision++; publish({ ...invalidateContext(), url, pageRuntime: 'checking', inspectMode: false }); });
  preview.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    publish({ ...invalidateContext(), url, inspectMode: false });
    preview.webContents.executeJavaScript(engine.getPickerScript(false)).catch(() => {});
  });
  preview.webContents.on('render-process-gone', (_event, details) => { publish({ ...invalidateContext(), loading: false, inspectMode: false }); reportError(new Error(`The application preview stopped (${details.reason}). Reload the app to reconnect.`)); });
  preview.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { publish({ loading: false }); reportError(new Error(`Unable to open the application: ${description}`)); } });
  preview.webContents.on('console-message', (...args) => {
    const message = args[0]?.message ?? args[2];
    if (!state.inspectMode || typeof message !== 'string' || !message.startsWith('__TRACE_ATLAS_PICK__') || message.length > 5000) return;
    try { captureElement(security.selection(JSON.parse(message.slice('__TRACE_ATLAS_PICK__'.length)))).catch(reportError); } catch (error) { reportError(error); }
  });
  preview.webContents.on('did-finish-load', async () => {
    const contents = preview.webContents, revision = pageRuntimeRevision;
    try {
      // Compiler-injected modules may finish just after the document loads.
      let available = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (closing || contents.isDestroyed() || revision !== pageRuntimeRevision) return;
        available = await contents.executeJavaScript(runtimeProbe);
        if (available) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!closing && !contents.isDestroyed() && revision === pageRuntimeRevision) publish({ pageRuntime: available ? 'available' : 'missing' });
    } catch { if (revision === pageRuntimeRevision) publish({ pageRuntime: 'unknown' }); }
    if (!state.demo) return;
    try {
      await preview.webContents.executeJavaScript(`new Promise(resolve => { let attempts=0; const poll=()=>{if(document.documentElement.dataset.traceReady==='true'||++attempts>120)resolve();else setTimeout(poll,50);};poll(); })`);
      if (state.demo) await captureElement({ selector: '[data-trace-id="price-orbit"]', label: demoKind === 'broken' ? '$12,900' : '$129', tag: 'span' });
    } catch (error) { reportError(error); }
  });
  window.on('resize', renderPreviewBounds);
  window.on('closed', () => { for (const viewer of diagramWindows) if (!viewer.isDestroyed()) viewer.destroy(); if (preview && !preview.webContents.isDestroyed()) preview.webContents.close(); preview = null; window = null; });
  await window.loadURL(rendererUrl);
  window.show();
  window.moveTop();
  window.focus();
  if (profileSuffix && process.env.ORIVO_START_MODE !== 'welcome') await openDemo();
  if (process.connected) process.send({ type: 'trace-atlas:ready', pid: process.pid, visible: window.isVisible() });
}
installIpc();
app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
if (ownsInstance) app.whenReady().then(createWindow).catch(error => {
  shutdownExitCode = 1;
  const message = redactDiagnosticText(error?.message || error);
  try { fs.appendFileSync(path.join(runtimeDirectory, 'startup.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
  dialog.showErrorBox('Orivo could not start', `${message}\n\nStartup details were saved in the local Orivo profile.`);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  cancelAgent();
  closing = true;
  captureRevision++; inspectRevision++; desiredInspectMode = false;
  const ownedPreview = preview;
  preview = null;
  if (ownedPreview) {
    try { ownedPreview.setVisible(false); if (window && !window.isDestroyed()) window.contentView.removeChildView(ownedPreview); } catch {}
    try { if (!ownedPreview.webContents.isDestroyed()) { ownedPreview.webContents.stop(); ownedPreview.webContents.close({ waitForBeforeUnload: false }); } } catch {}
  }
  shutdownPromise = (async () => {
    let deadline;
    try {
      const demoCleanup = demoServer ? demoServer.close() : demoServerPromise ? demoServerPromise.then(server => server.close()) : Promise.resolve();
      for (const viewer of diagramWindows) if (!viewer.isDestroyed()) viewer.destroy();
      const cleanup = Promise.allSettled([demoCleanup, autoAttach.close(), automaticCleanup, localModel.stop(), diagramStudio.close()]);
      await Promise.race([cleanup, new Promise(resolve => { deadline = setTimeout(resolve, 12000); })]);
    } finally {
      clearTimeout(deadline);
      try { if (window && !window.isDestroyed()) window.destroy(); } catch {}
      app.exit(shutdownExitCode);
    }
  })();
  return shutdownPromise;
}
app.on('before-quit', event => { event.preventDefault(); if (!closing) shutdown(); });
if (process.connected) { process.on('message', message => { if (message?.type === 'trace-atlas:shutdown') app.quit(); }); process.on('disconnect', () => app.quit()); }
