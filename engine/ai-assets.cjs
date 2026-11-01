'use strict';

const {createHash} = require('node:crypto');
const {createReadStream} = require('node:fs');
const {lstat, readFile, stat} = require('node:fs/promises');
const path = require('node:path');

const MODEL_ASSET = Object.freeze({
  id: 'Qwen/Qwen3-4B-GGUF@bc640142c66e1fdd12af0bd68f40445458f3869b',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  sizeBytes: 2_497_280_256,
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  license: 'Apache-2.0',
});
const RUNTIME_ASSET = Object.freeze({
  repository: 'ggml-org/llama.cpp',
  release: 'b11852',
  filename: 'llama-b11852-bin-win-cpu-x64.zip',
  license: 'MIT',
});

function selectRuntimeAsset(assets) {
  if (!Array.isArray(assets)) throw Error('The llama.cpp release metadata did not include an asset list.');
  const matches = assets.filter(row => row?.name === RUNTIME_ASSET.filename);
  if (matches.length !== 1) throw Error('Expected exactly one pinned Windows x64 CPU runtime asset in the llama.cpp release.');
  const row = matches[0];
  if (typeof row.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.digest)) throw Error('The llama.cpp runtime asset is missing its published SHA-256 digest.');
  let url;
  try { url = new URL(row.browser_download_url); } catch { throw Error('The llama.cpp runtime asset has an invalid download URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== `/ggml-org/llama.cpp/releases/download/${RUNTIME_ASSET.release}/${RUNTIME_ASSET.filename}`) throw Error('The llama.cpp runtime asset URL does not match the pinned release.');
  return Object.freeze({name: row.name, url: url.href, sha256: row.digest.slice(7)});
}

function validateModelMetadata(sizeBytes, sha256) {
  if (sizeBytes !== MODEL_ASSET.sizeBytes) throw Error('The bundled Qwen model size does not match its pinned release.');
  if (sha256 !== MODEL_ASSET.sha256) throw Error('The bundled Qwen model SHA-256 does not match its pinned release.');
  return true;
}

function validatePreparedManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.model?.id !== MODEL_ASSET.id || manifest.model?.file !== MODEL_ASSET.file) throw Error('The prepared Orivo model manifest is missing or does not match the pinned model.');
  validateModelMetadata(manifest.model.sizeBytes, manifest.model.sha256);
  if (manifest.runtime?.repository !== RUNTIME_ASSET.repository || manifest.runtime?.release !== RUNTIME_ASSET.release || manifest.runtime?.directory !== RUNTIME_ASSET.release || manifest.runtime?.filename !== RUNTIME_ASSET.filename || !/^[a-f0-9]{64}$/.test(manifest.runtime?.sha256 || '')) throw Error('The prepared Orivo runtime manifest does not match the pinned release.');
  if (!Array.isArray(manifest.runtime.files) || !manifest.runtime.files.length) throw Error('The prepared Orivo runtime manifest contains no runtime files.');
  const paths = new Set();
  for (const file of manifest.runtime.files) {
    const name = file?.path;
    if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw Error('The prepared Orivo runtime manifest contains an invalid file record.');
    if (paths.has(name.toLowerCase())) throw Error('The prepared Orivo runtime manifest contains duplicate files.');
    paths.add(name.toLowerCase());
  }
  if (!paths.has('llama-server.exe')) throw Error('The prepared Orivo runtime does not include llama-server.exe.');
  return true;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyPreparedAssets({runtimeDirectory, modelPath, manifestPath, statImpl = stat, lstatImpl = lstat, readFileImpl = readFile, hashFileImpl = hashFile}) {
  let manifest;
  try {manifest = JSON.parse(await readFileImpl(manifestPath, 'utf8'));}
  catch {throw Error('Orivo’s bundled AI assets are not prepared. Run `npm.cmd run prepare:ai` before building or starting the AI agent.');}
  validatePreparedManifest(manifest);
  const modelInfo = await statImpl(modelPath).catch(() => null);
  if (!modelInfo?.isFile?.() || modelInfo.size !== MODEL_ASSET.sizeBytes || await hashFileImpl(modelPath) !== MODEL_ASSET.sha256) throw Error('The bundled Qwen model is missing, has the wrong size, or failed SHA-256 verification. Run `npm run prepare:ai` again.');
  const runtimeInfo = await statImpl(runtimeDirectory).catch(() => null);
  if (!runtimeInfo?.isDirectory?.()) throw Error('The bundled llama.cpp runtime directory is missing. Run `npm run prepare:ai` again.');
  const root = path.resolve(runtimeDirectory);
  for (const entry of manifest.runtime.files) {
    const file = path.resolve(root, ...entry.path.split('/'));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('The bundled llama.cpp manifest contains an unsafe file path.');
    const info = await lstatImpl(file).catch(() => null);
    if (!info?.isFile?.() || info.isSymbolicLink() || info.size !== entry.sizeBytes || await hashFileImpl(file) !== entry.sha256) throw Error(`The bundled llama.cpp runtime file failed verification: ${entry.path}`);
  }
  return manifest;
}

module.exports = {MODEL_ASSET, RUNTIME_ASSET, selectRuntimeAsset, validateModelMetadata, validatePreparedManifest, verifyPreparedAssets};
