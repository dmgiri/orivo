'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { relativePath, within } = require('./host-security.cjs');
// Only the host's current captured node may call this function. A file claim
// from an imported snapshot is deliberately never an editor authorization.
async function verifiedEditorTarget(repository, node) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository) || !node || !/^[a-f0-9]{64}$/i.test(node.meta?.sourceHash || '')) throw Error('This block has no verified current source location. Recapture it before opening the editor.');
  const source = relativePath(node.file), line = node.line;
  if (!Number.isInteger(line) || line < 1 || line > 1000000) throw Error('Invalid source line.');
  if (await fs.realpath(repository) !== repository) throw Error('The connected repository changed. Connect it again before opening the editor.');
  const file = await fs.realpath(path.join(repository, source));
  if (!within(repository, file)) throw Error('Source path is outside the connected repository.');
  const handle = await fs.open(file, 'r');
  let content;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw Error('This source file is unavailable or too large to verify.');
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > 8 * 1024 * 1024) throw Error('This source file is too large to verify.');
    content = buffer.subarray(0, length);
  } finally { await handle.close(); }
  if (createHash('sha256').update(content).digest('hex') !== node.meta.sourceHash.toLowerCase()) throw Error('This source changed after capture. Restart and recapture before opening its trace location.');
  if (line > content.toString('utf8').split('\n').length) throw Error('The captured source line no longer exists.');
  // Fixed VS Code protocol; paths are URL-encoded, never shell command text.
  const url = new URL(`vscode://file${pathToFileURL(file).pathname}:${line}:1`);
  if (await fs.realpath(repository) !== repository || await fs.realpath(path.join(repository, source)) !== file) throw Error('The source folder changed during verification. Try again.');
  return { url: url.href, path: source, line };
}
module.exports = { verifiedEditorTarget };
