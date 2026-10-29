import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runNativeImageMessage } from './nativeImageMessage';

const ports = vi.hoisted(() => ({ fetch: vi.fn(), admission: vi.fn() }));
vi.mock('./api', () => ({ apiFetch: (...args) => ports.fetch(...args) }));
vi.mock('./userImageComposerController', () => ({ readUserImageAdmission: (...args) => ports.admission(...args) }));
const auth = { userId: 'owner', home: 'https://home.test/' }, sessionId = 'ss-image';
const requestId = '11111111-1111-4111-8111-111111111111';
const ref = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 5, name: 'chart.png' };
const receipt = { status: 'accepted', requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1, input: { text: 'Look', attachments: [ref] } };

function fixture() {
  const body = JSON.stringify({ requestId, text: 'Look', attachments: [ref] });
  const intent = { kind: 'images-v1', requestId, text: 'Look', attachments: [ref], submittedLocalIds: ['local'], serializedBody: body, acceptedReceipt: null };
  const native = { getSnapshot: () => ({ scopeKey: JSON.stringify([auth.userId, auth.home, 'home', sessionId]), storageState: 'ready', text: ' Look ', revision: 'draft-revision', localIds: ['local'], pending: null }),
    getPendingIntent: () => intent };
  const store = { getImageStore: () => native, getSnapshot: () => ({}), prepareIntent: vi.fn(async () => intent), confirmIntent: vi.fn(async () => ({})) };
  const onAccepted = vi.fn(), onNotice = vi.fn();
  return { intent, store, onAccepted, onNotice, options: { mode: 'send', text: ' Look ', attachments: [ref], sessionId, composerStore: store,
    auth, selection: { aiType: 'openai-api', model: 'model' }, signal: new AbortController().signal, current: () => true, requestId, onAccepted, onNotice } };
}

beforeEach(() => { ports.fetch.mockReset(); ports.admission.mockReset(); ports.admission.mockResolvedValue({ state: 'allowed' }); });

describe('session image message admission', () => {
  it('commits the selected request identity before posting and confirms the exact receipt', async () => {
    const value = fixture();
    ports.fetch.mockImplementation(async () => { expect(value.store.prepareIntent).toHaveBeenCalledOnce(); return { ok: true, json: async () => receipt }; });
    const result = await runNativeImageMessage(value.options);
    expect(result).toMatchObject({ accepted: true, requestId, draftManaged: true });
    expect(value.store.prepareIntent).toHaveBeenCalledWith('Look', [ref], { draftRevision: 'draft-revision', localIds: ['local'] }, requestId);
    expect(ports.fetch).toHaveBeenCalledWith('/api/structured/sessions/ss-image/attachments/send', expect.objectContaining({ method: 'POST', body: value.intent.serializedBody }));
    expect(value.store.confirmIntent).toHaveBeenCalledWith(requestId, receipt);
    expect(value.onAccepted).toHaveBeenCalledOnce();
  });

  it('checks the same receipt after a lost send response', async () => {
    const value = fixture();
    ports.fetch.mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce({ ok: true, json: async () => receipt });
    expect(await runNativeImageMessage(value.options)).toMatchObject({ accepted: true, requestId });
    expect(ports.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-image/attachments/send', `/api/structured/sessions/ss-image/requests/${requestId}`]);
    expect(value.store.confirmIntent).toHaveBeenCalledOnce();
  });

  it('does not post if the prepared request belongs to another start', async () => {
    const value = fixture();
    value.store.prepareIntent.mockResolvedValue({ ...value.intent, requestId: '33333333-3333-4333-8333-333333333333', serializedBody: JSON.stringify({ requestId: '33333333-3333-4333-8333-333333333333', text: 'Look', attachments: [ref] }) });
    await expect(runNativeImageMessage(value.options)).rejects.toThrow(/does not match this start/i);
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it('does not post after the user changes scope while the intent is being saved', async () => {
    const value = fixture(); let live = true;
    value.store.prepareIntent.mockImplementation(async () => { live = false; return value.intent; });
    expect(await runNativeImageMessage({ ...value.options, current: () => live })).toEqual({ accepted: false, stale: true });
    expect(ports.fetch).not.toHaveBeenCalled();
  });
});
