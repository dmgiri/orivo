'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MODEL_ASSET, RUNTIME_ASSET, selectRuntimeAsset, validateModelMetadata, validatePreparedManifest, verifyPreparedAssets} = require('../engine/ai-assets.cjs');

test('selects only the pinned Windows x64 CPU llama.cpp asset with a published SHA-256 digest', () => {
  const selected = selectRuntimeAsset([
    {name: 'llama-b11852-bin-win-cpu-arm64.zip', browser_download_url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11852/arm.zip', digest: `sha256:${'a'.repeat(64)}`},
    {name: 'llama-b11852-bin-win-cpu-x64.zip', browser_download_url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11852/llama-b11852-bin-win-cpu-x64.zip', digest: `sha256:${'b'.repeat(64)}`},
  ]);
  assert.equal(selected.name, 'llama-b11852-bin-win-cpu-x64.zip');
  assert.equal(selected.sha256, 'b'.repeat(64));
  assert.throws(() => selectRuntimeAsset([{...selected, name: 'llama-b11852-bin-win-cuda-x64.zip'}]), /exactly one pinned Windows x64 CPU runtime/);
  assert.throws(() => selectRuntimeAsset([{...selected, digest: null}]), /published SHA-256/);
});

test('accepts the exact pinned Qwen GGUF size and digest and rejects corrupted or substituted model assets', () => {
  assert.equal(validateModelMetadata(MODEL_ASSET.sizeBytes, MODEL_ASSET.sha256), true);
  assert.throws(() => validateModelMetadata(MODEL_ASSET.sizeBytes - 1, MODEL_ASSET.sha256), /size does not match/);
  assert.throws(() => validateModelMetadata(MODEL_ASSET.sizeBytes, '0'.repeat(64)), /SHA-256 does not match/);
});

test('release manifest requires the pinned model, runtime, safe runtime paths, and llama server', () => {
  const manifest = {schemaVersion: 1, model: {...MODEL_ASSET}, runtime: {...RUNTIME_ASSET, directory: RUNTIME_ASSET.release, sha256: 'b'.repeat(64), files: [{path: 'llama-server.exe', sizeBytes: 1024, sha256: 'c'.repeat(64)}, {path: 'ggml.dll', sizeBytes: 2048, sha256: 'd'.repeat(64)}]}};
  assert.equal(validatePreparedManifest(manifest), true);
  assert.throws(() => validatePreparedManifest({...manifest, model: {...manifest.model, file: 'other.gguf'}}), /does not match the pinned model/);
  assert.throws(() => validatePreparedManifest({...manifest, runtime: {...manifest.runtime, files: [{path: '../llama-server.exe', sizeBytes: 1, sha256: 'c'.repeat(64)}]}}), /invalid file record/);
  assert.throws(() => validatePreparedManifest({...manifest, runtime: {...manifest.runtime, files: [{path: 'llama.dll', sizeBytes: 1, sha256: 'c'.repeat(64)}]}}), /does not include llama-server.exe/);
});

test('release asset verification rejects missing and corrupted AI files', async () => {
  const manifest = {schemaVersion: 1, model: {...MODEL_ASSET}, runtime: {...RUNTIME_ASSET, directory: RUNTIME_ASSET.release, sha256: 'b'.repeat(64), files: [{path: 'llama-server.exe', sizeBytes: 16, sha256: 'c'.repeat(64)}]}};
  const paths = {runtimeDirectory: 'C:/virtual/ai/runtime', modelPath: 'C:/virtual/ai/models/model.gguf', manifestPath: 'C:/virtual/ai/manifest.json'};
  const statImpl = async file => file === paths.runtimeDirectory ? {isDirectory: () => true} : file === paths.modelPath ? {isFile: () => true, size: MODEL_ASSET.sizeBytes} : {isFile: () => true, size: 16};
  const lstatImpl = async () => ({isFile: () => true, isSymbolicLink: () => false, size: 16});
  const readFileImpl = async () => JSON.stringify(manifest);
  const hashes = async file => file === paths.modelPath ? MODEL_ASSET.sha256 : 'c'.repeat(64);
  assert.deepEqual(await verifyPreparedAssets({...paths, statImpl, lstatImpl, readFileImpl, hashFileImpl: hashes}), manifest);
  await assert.rejects(verifyPreparedAssets({...paths, statImpl: async file => file === paths.runtimeDirectory ? {isDirectory: () => true} : null, lstatImpl, readFileImpl, hashFileImpl: hashes}), /wrong size|missing/);
});
