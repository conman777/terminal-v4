// Controlled native port, not IndexedDB or a replica storage reducer.
// Each publication is an explicit test-authored snapshot. No hashing, protocol
// validation, migration, CAS, persistence, quota or transactions are modeled.
import { vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { clearTokens, setAuthInitializing, setTokens, setUser } from '../utils/auth';
import { getEnvironmentSignal, setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';

const originalFetch = globalThis.fetch;
export const OWNER = 'join-fixture-owner';
export const SESSION = { id: 'ss-image-join-fixture', runtime: 'v4', aiType: 'openai', model: 'gpt-5.4', cwd: '/synthetic/workspace', title: 'Image fixture' };
export const R1 = '11111111-1111-4111-8111-111111111111';
export const R2 = '22222222-2222-4222-8222-222222222222';
export const L1 = '33333333-3333-4333-8333-333333333333';
export const L2 = '44444444-4444-4444-8444-444444444444';
export const REQUEST = '55555555-5555-4555-8555-555555555555';
export const A = Object.freeze({ attachmentId: '66666666-6666-4666-8666-666666666666', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 4, name: 'first.png' });
export const B = Object.freeze({ attachmentId: '77777777-7777-4777-8777-777777777777', artifactId: 'b'.repeat(64), mimeType: 'image/png', bytes: 4, name: 'second.png' });
export const CATALOG = { agents: [{ id: 'openai', runtime: 'v4', models: [{ id: 'gpt-5.4', imageInput: true, default: true }, { id: 'text-only', imageInput: false }, { id: 'unknown-capability' }] }] };
export const RAW = '\u0085\ufeffCafe\u0301\r\nsnow\rright\ufeff\u0085';
export const CANONICAL = '\ufeffCafe\u0301\nsnow\rright\ufeff';
export const scopeFor = (sessionId = SESSION.id, home = `${window.location.origin}/`) => [OWNER, home, 'home', sessionId];
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
export const readyResponse = { status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 };
export const accepted = (intent, overrides = {}) => ({ status: 'completed', requestId: intent.requestId, turnId: 'join-turn', messageId: 'join-message', acceptedSeq: 7, input: { text: intent.text, attachments: intent.attachments }, ...overrides });
export const file = () => new File([new Uint8Array([1, 2, 3, 4])], A.name, { type: A.mimeType });
export function intent(overrides = {}) {
  const value = { kind: 'images-v1', requestId: REQUEST, text: CANONICAL, attachments: [A], draftRevision: R1,
    submittedLocalIds: [L1], missingBytePins: [], serializedBody: JSON.stringify({ requestId: REQUEST, text: CANONICAL, attachments: [A] }),
    serializedBodySha256: 'c'.repeat(64), rawSourceEvidence: { kind: 'draft', revision: R1, localIds: [L1] }, acceptedReceipt: null, reused: false, ...overrides };
  return Object.freeze(value);
}
export function snapshot(overrides = {}) {
  return { scopeKey: JSON.stringify(scopeFor()), storageState: 'ready', authorityId: R2, headRevision: 1,
    text: RAW, revision: R1, committedRevision: R1, localIds: [L1],
    items: [{ localId: L1, name: A.name, mimeType: A.mimeType, bytes: A.bytes, durability: 'saved', uploadState: 'ready', uploadId: A.attachmentId, uploadGeneration: 1, descriptor: A, errorCode: null }],
    pending: null, removals: [], isHydrating: false, isSaving: false, error: null, conflict: null, migration: null, ...overrides };
}
export function nativePort(initial = snapshot()) {
  let current = initial;
  const listeners = new Set();
  const commit = () => ({ committed: true, headRevision: current.headRevision, revision: current.revision, snapshot: current });
  const blob = { blob: file(), localId: L1, uploadId: A.attachmentId, mimeType: A.mimeType, bytes: A.bytes, name: A.name, artifactId: A.artifactId, rawSha256: 'd'.repeat(64) };
  const native = {
    getSnapshot: vi.fn(() => current), subscribe: vi.fn(listener => { listeners.add(listener); return () => listeners.delete(listener); }),
    hydrate: vi.fn(async () => current), promoteLegacy: vi.fn(async () => current), setText: vi.fn(), flush: vi.fn(async () => commit()),
    addFiles: vi.fn(async () => commit()), getBlob: vi.fn(async () => blob),
    beginUpload: vi.fn(async () => ({ ...blob, scopeKey: current.scopeKey, authorityId: R2, uploadGeneration: 1 })),
    completeUpload: vi.fn(async () => ({ applied: true, snapshot: current })), failUpload: vi.fn(async () => ({ applied: true, snapshot: current })),
    removeImage: vi.fn(async () => commit()), completeRemoval: vi.fn(async () => commit()),
    prepareIntent: vi.fn(async () => intent()), getPendingIntent: vi.fn(() => current.pending),
    confirmIntent: vi.fn(async () => ({ ...commit(), clearedDraft: false })), restorePendingBytes: vi.fn(async () => commit()), close: vi.fn(),
    publish(next) { current = next; for (const listener of listeners) listener(); },
  };
  return native;
}
export const ports = { native: null, nativeFactory: vi.fn() };
export function resetFixture() {
  globalThis.fetch = vi.fn(async () => { throw new Error('Unmocked HTTP is forbidden in this consumer fixture'); });
  clearTokens(true); localStorage.clear(); setAuthInitializing(false);
  setEnvironmentIdentity(OWNER, window.location.origin); setActiveEnvironment(null);
  const token = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: OWNER, exp: Math.floor(Date.now() / 1000) + 300 }))}.fixture-signature`;
  setTokens(token, 'synthetic-refresh'); setUser({ id: OWNER });
  ports.native = nativePort(); ports.nativeFactory.mockReset().mockImplementation(() => ports.native);
}
export async function cleanFixture() {
  await act(async () => { cleanup(); });
  vi.restoreAllMocks(); globalThis.fetch = originalFetch; setActiveEnvironment(null); setEnvironmentIdentity(null); clearTokens(true); localStorage.clear();
}
export function controllerOptions(overrides = {}) {
  return { scope: scopeFor(), store: getComposerDraftStore(SESSION.id), session: SESSION,
    signal: getEnvironmentSignal(), isCurrent: () => true, ...overrides };
}
// This replaces ONLY the required storage port for real-hook consumer tests.
// Facade delegation itself is independently exercised through the real facade.
export function nativeBoundary(store, native = ports.native) {
  store.getImageStore = () => native;
  vi.spyOn(store, 'prepareIntent').mockImplementation((text, attachments, source) => native.prepareIntent({ text, attachments, ...source }));
  vi.spyOn(store, 'confirmIntent').mockImplementation((requestId, receipt) => native.confirmIntent({ requestId, receipt }));
  return native;
}
export class Socket {
  static instances = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  close() { this.onclose?.({ code: 1000 }); }
}
