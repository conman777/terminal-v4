import { describe, expect, it, vi } from 'vitest';
import { sendPreparedStartImages } from './startImageSend';

const ports = vi.hoisted(() => ({ retain: vi.fn(), run: vi.fn(), messageId: vi.fn(async () => 'message-id') }));
vi.mock('./userImageComposerController', () => ({ retainUserImageComposer: (...args) => ports.retain(...args) }));
vi.mock('./nativeImageMessage', () => ({ runNativeImageMessage: (...args) => ports.run(...args) }));
vi.mock('./startImageTransfer', () => ({ startImageMessageRequestId: (...args) => ports.messageId(...args) }));

const ref = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 5, name: 'chart.png' };
function fixture() {
  const storage = { storageState: 'ready', text: 'Look', revision: 'target-revision', localIds: ['local'], pending: null, items: [{ localId: 'local', uploadState: 'local' }] };
  const lease = { getSnapshot: () => ({ admission: { state: 'allowed' }, storage }), subscribe: () => () => {}, release: vi.fn(),
    retryUpload: vi.fn(async () => { storage.items = [{ localId: 'local', uploadState: 'ready', expiresAt: Date.now() + 60000, descriptor: ref }]; }) };
  ports.retain.mockReturnValue(lease); ports.run.mockResolvedValue({ accepted: true });
  const draft = { claimSend: vi.fn(() => 'lease'), releaseSend: vi.fn() };
  const controller = new AbortController(), bind = vi.fn(() => true);
  return { storage, lease, draft, bind, options: { draft, session: { id: 'ss-one', runtime: 'v4', aiType: 'openai-api', model: 'model' },
    auth: { userId: 'owner', home: 'https://home.test/' }, signal: controller.signal, environmentSignal: controller.signal,
    current: () => true, binding: { text: 'Look', requestId: 'start-id', targetRevision: 'target-revision' }, localIds: ['local'], bind } };
}

describe('explicit start image submission', () => {
  it('uploads, saves the exact message binding, and uses the shared receipt path', async () => {
    const value = fixture();
    ports.run.mockImplementation(async options => { expect(value.bind).toHaveBeenCalledOnce(); expect(options.requestId).toBe('message-id'); return { accepted: true }; });
    await expect(sendPreparedStartImages(value.options)).resolves.toEqual({ accepted: true });
    expect(value.lease.retryUpload).toHaveBeenCalledWith('local');
    expect(value.bind).toHaveBeenCalledWith({ text: 'Look', requestId: 'start-id', targetRevision: 'target-revision', messageRequestId: 'message-id', targetLocalIds: ['local'], attachments: [ref] });
    expect(value.draft.releaseSend).toHaveBeenCalledWith('lease');
    expect(value.lease.release).toHaveBeenCalled();
  });

  it('never posts when the binding or upload cannot be committed', async () => {
    const value = fixture(); value.bind.mockReturnValue(false); ports.run.mockClear();
    await expect(sendPreparedStartImages(value.options)).rejects.toThrow(/identity could not be saved/i);
    expect(ports.run).not.toHaveBeenCalled();
    const failed = fixture(); ports.run.mockClear(); failed.lease.retryUpload.mockRejectedValue(new Error('Upload uncertain'));
    await expect(sendPreparedStartImages(failed.options)).rejects.toThrow('Upload uncertain');
    expect(ports.run).not.toHaveBeenCalled();
  });

  it('holds a destination draft that changed and returned to the same visible text', async () => {
    const value = fixture(); ports.run.mockClear();
    value.lease.retryUpload.mockImplementation(async () => {
      value.storage.revision = 'another-revision';
      value.storage.items = [{ localId: 'local', uploadState: 'ready', expiresAt: Date.now() + 60000, descriptor: ref }];
    });
    await expect(sendPreparedStartImages(value.options)).rejects.toThrow(/destination draft changed/i);
    expect(value.bind).not.toHaveBeenCalled();
    expect(ports.run).not.toHaveBeenCalled();
  });

  it('keeps the start held when an accepted send still has unresolved local cleanup', async () => {
    const value = fixture(); ports.run.mockResolvedValue({ accepted: true, localCleanupPending: true });
    await expect(sendPreparedStartImages(value.options)).rejects.toThrow(/cleanup needs review/i);
    expect(value.bind).toHaveBeenCalledOnce();
  });
});
