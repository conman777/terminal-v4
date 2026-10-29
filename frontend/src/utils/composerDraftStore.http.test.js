import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getComposerDraftStore } from './composerDraftStore';
import { getCompactionIntentStore } from './compactionIntentStore';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';

const SESSION = 'ss-1234567890abcdef1234567890abcdef';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  localStorage.clear();
  setEnvironmentIdentity('http-composer-fixture', window.location.origin);
  setActiveEnvironment(null);
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setEnvironmentIdentity(null);
  localStorage.clear();
});

describe('composer stores without secure-context randomUUID', () => {
  it('mounts, edits and retains a retryable message identity', () => {
    const store = getComposerDraftStore(SESSION);
    store.setText('Keep this draft');
    const intent = store.prepareIntent('Keep this draft');
    expect({ text: store.getSnapshot().text, revision: UUID_V4.test(store.getSnapshot().revision),
      requestId: UUID_V4.test(intent.requestId), retry: store.prepareIntent('Keep this draft') }).toEqual({
      text: 'Keep this draft', revision: true, requestId: true, retry: { ...intent, reused: true },
    });
  });

  it('mounts compaction instructions and persists a valid command identity', () => {
    const store = getCompactionIntentStore(SESSION);
    store.setInstructions('Keep decisions');
    const intent = store.prepareIntent('a'.repeat(64));
    expect({ instructions: intent.body.instructions, requestId: UUID_V4.test(intent.body.requestId),
      draftRevision: UUID_V4.test(intent.draftRevision), pending: store.getSnapshot().pending }).toEqual({
      instructions: 'Keep decisions', requestId: true, draftRevision: true, pending: intent,
    });
  });
});
