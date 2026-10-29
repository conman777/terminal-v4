import { captureAuthScope, getAccessToken, getRefreshToken, getUser } from './auth';
import { getActiveEnvironment } from './remoteEnvironments';

export const WEB_CONTAINER_PATH = '/webcontainer';
const STORAGE_KEY = 'terminal_webcontainer_launches_v1';
const LAUNCH_TTL = 120000;
const MAX_LAUNCHES = 8;
const ID_PATTERN = /^[a-f0-9]{32}$/;

export function isWebContainerRoute(pathname) {
  return pathname === WEB_CONTAINER_PATH || pathname === WEB_CONTAINER_PATH + '/';
}

function environmentSelectionKey(scope) {
  return `identity:${encodeURIComponent(new URL(scope.home).origin)}:${encodeURIComponent(scope.userId)}:selectedEnvironment`;
}

export function isWebContainerLaunchCurrent(record) {
  try {
    const scope = captureAuthScope();
    return Boolean(record && scope.userId && scope.userId === record.ownerId
      && scope.session === record.session && scope.home === record.home
      && (getAccessToken() || getRefreshToken()) && !getActiveEnvironment()
      && !localStorage.getItem(environmentSelectionKey(scope)));
  } catch { return false; }
}

export function getWebContainerLaunchSupport({ projectPath } = {}) {
  if (!globalThis.isSecureContext) return { supported: false, reason: 'WebContainer requires HTTPS or localhost.' };
  if (!/Chrome|Chromium|Edg/.test(navigator.userAgent) || /Firefox/.test(navigator.userAgent)) return { supported: false, reason: 'Open WebContainer in Chrome or Edge.' };
  if (!navigator.locks?.request) return { supported: false, reason: 'Web Locks are required to open a project safely.' };
  if (getActiveEnvironment()) return { supported: false, reason: 'WebContainer cannot open a paired host project. Select the home environment.' };
  if (!projectPath) return { supported: false, reason: 'Select a local Node.js project first.' };
  return { supported: true, reason: null };
}

function readLaunches() {
  const raw = localStorage.getItem(STORAGE_KEY) || '{}';
  if (raw.length > 32768) throw new Error('WebContainer launch metadata exceeds its limit.');
  const records = JSON.parse(raw);
  if (!records || Array.isArray(records) || typeof records !== 'object') throw new Error('Invalid WebContainer launch metadata.');
  return Object.fromEntries(Object.entries(records).filter(([id, record]) => ID_PATTERN.test(id) && record?.expiresAt > Date.now()));
}

function validateProject(projectPath, startCommand) {
  if (typeof projectPath !== 'string' || projectPath.length > 2048 || !/^(\/|[A-Za-z]:[\\/])/.test(projectPath) || /[\u0000-\u001f]/.test(projectPath)) throw new Error('A local project path is required.');
  if (typeof startCommand !== 'string' || !startCommand.trim() || startCommand.length > 512 || /[\u0000-\u001f]/.test(startCommand)) throw new Error('A valid project start command is required.');
}

export function createWebContainerLaunch({ projectPath, startCommand = 'npm run dev' }) {
  const support = getWebContainerLaunchSupport({ projectPath });
  if (!support.supported) throw new Error(support.reason);
  validateProject(projectPath, startCommand);
  const scope = captureAuthScope();
  const record = { version: 1, ownerId: scope.userId, session: scope.session, home: scope.home, environment: 'home', projectPath, startCommand, expiresAt: Date.now() + LAUNCH_TTL };
  if (!isWebContainerLaunchCurrent(record)) throw new Error('Sign in and select the home environment before opening WebContainer.');
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  // Request the lock before opening the tab; do not await it and lose user activation.
  const ready = navigator.locks.request('terminal-webcontainer-launches', { mode: 'exclusive' }, () => {
    if (!isWebContainerLaunchCurrent(record) || record.expiresAt <= Date.now()) throw new Error('The launch account, environment, or expiry changed. Open a new launch.');
    const records = readLaunches();
    if (Object.keys(records).length >= MAX_LAUNCHES) throw new Error('Too many pending WebContainer launches. Retry in two minutes.');
    records[id] = record;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  });
  return { id, href: `${WEB_CONTAINER_PATH}#${id}`, ready };
}

export async function claimWebContainerLaunch(id) {
  if (!navigator.locks?.request) throw new Error('Web Locks are required to claim a project safely.');
  if (!ID_PATTERN.test(id || '')) throw new Error('Open this window from a project in the normal app.');
  return await navigator.locks.request('terminal-webcontainer-launches', { mode: 'exclusive' }, () => {
    const records = readLaunches();
    const record = records[id];
    if (!record) throw new Error('This launch is expired, missing, or already consumed. Open it again from the app.');
    validateProject(record.projectPath, record.startCommand);
    if (record.version !== 1 || record.environment !== 'home' || !isWebContainerLaunchCurrent(record)) throw new Error('The launch account or home environment changed. Open a new launch from the app.');
    delete records[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    if (!isWebContainerLaunchCurrent(record)) throw new Error('The launch account or environment changed.');
    return record;
  });
}

export function isTrustedWebContainerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.origin !== window.location.origin
      && url.hostname.endsWith('.local-corp.webcontainer-api.io');
  } catch { return false; }
}

export function validateWebContainerFiles(files) {
  let entries = 0, total = 0;
  function visit(tree, depth) {
    if (!tree || typeof tree !== 'object' || Array.isArray(tree) || depth > 32) throw new Error('Invalid or excessively deep project tree.');
    for (const [name, node] of Object.entries(tree)) {
      if (++entries > 10000 || !name || name.length > 255 || /[\\/\u0000-\u001f]/.test(name) || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('Unsafe project entry or project entry limit exceeded.');
      if (!node || typeof node !== 'object' || Object.keys(node).length !== 1) throw new Error('Invalid project file node.');
      if ('directory' in node) { visit(node.directory, depth + 1); continue; }
      const contents = node.file?.contents;
      const size = typeof contents === 'string' ? new TextEncoder().encode(contents).length
        : Array.isArray(contents) && contents.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? contents.length : -1;
      if (size < 0 || size > 1024 * 1024 || (total += size) > 50 * 1024 * 1024) throw new Error('Invalid file bytes or project size limit exceeded.');
    }
  }
  visit(files, 0);
  if (!files['package.json']?.file) throw new Error('The exported project has no package.json.');
  return files;
}

export async function readWebContainerExport(response, { signal, assertCurrent, maxBytes = 64 * 1024 * 1024 } = {}) {
  const check = () => { signal?.throwIfAborted(); assertCurrent?.(); };
  check();
  if (Number(response.headers?.get('Content-Length')) > maxBytes) throw new Error('Project export exceeds the 64MiB decoded response budget. Use proxy preview.');
  if (!response.body?.getReader) throw new Error('The project export response cannot be read safely.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  const text = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      check();
      const { done, value } = await reader.read();
      check();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Project export exceeds the 64MiB decoded response budget. Use proxy preview.');
      text.push(decoder.decode(value, { stream: true }));
    }
    text.push(decoder.decode());
    check();
    return JSON.parse(text.join(''));
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
