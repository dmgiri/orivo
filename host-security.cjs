'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
function appUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Enter a valid application URL.');
  let url; try { url = new URL(value.trim()); } catch { throw Error('Enter a full application URL, including http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP or HTTPS URLs without embedded credentials are supported.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Use HTTPS for a remote application, or HTTP on localhost.');
  return url.href;
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || value.includes('\0') || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw Error('Choose a repository-relative source path.');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === '..' || part === '.' || !part)) throw Error('Source path is outside the connected repository.');
  return normalized;
}
function within(root, file) { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function rescanRepository(authorizedRoot, indexRepository) {
  if (typeof authorizedRoot !== 'string' || !path.isAbsolute(authorizedRoot) || typeof indexRepository !== 'function') throw Error('Connect a source folder before refreshing its index.');
  const currentRoot = await fsp.realpath(authorizedRoot);
  if (currentRoot !== authorizedRoot) throw Error('The connected source folder now points somewhere else. Choose the source folder again.');
  const indexed = await indexRepository(authorizedRoot);
  if (!indexed || indexed.root !== authorizedRoot || await fsp.realpath(authorizedRoot) !== authorizedRoot) throw Error('The source folder changed during refresh. Choose the source folder again.');
  return indexed;
}
function previewBounds(value, viewport) {
  if (!value || typeof value !== 'object') throw Error('Invalid preview bounds.');
  const nums = ['x', 'y', 'width', 'height'].map(key => value[key]);
  if (nums.some(number => !Number.isFinite(number) || Math.abs(number) > 50000)) throw Error('Invalid preview dimensions.');
  const [rawX, rawY, rawW, rawH] = nums.map(Math.round);
  const x = Math.max(0, Math.min(rawX, viewport.width)), y = Math.max(0, Math.min(rawY, viewport.height));
  return { x, y, width: Math.max(0, Math.min(rawW - Math.max(0, x - rawX), viewport.width - x)), height: Math.max(0, Math.min(rawH - Math.max(0, y - rawY), viewport.height - y)), visible: value.visible === true };
}
function selection(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid element selection.');
  if (value.cancelled === true) return { cancelled: true };
  if (typeof value.selector !== 'string' || !value.selector || value.selector.length > 2000) throw Error('Element selector is missing or too long.');
  return { selector: value.selector, label: String(value.label || value.selector).slice(0, 200), tag: String(value.tag || 'element').slice(0, 40) };
}
module.exports = { appUrl, relativePath, within, rescanRepository, previewBounds, selection };
