// UNAPPLIED additive consumer fixture. Native storage is a controlled port.
// This file performs no byte validation, migration, CAS or persistence.
// Keep the original join fixture and all its assertions byte-for-byte intact.
import { vi } from 'vitest';
import { A, B, L1, L2, R1, R2, SESSION, ports, intent, snapshot } from './userImagesJoinFixture';
import { getComposerDraftStore } from '../utils/composerDraftStore';

export const L3 = '88888888-8888-4888-8888-888888888888';
export const OTHER_REQUEST = '99999999-9999-4999-8999-999999999999';
export const NEWER_LOCAL = 'abababab-abab-4bab-8bab-abababababab';
export const NEWER_IMAGE = { ...A, attachmentId: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', artifactId: 'f'.repeat(64), name: 'newer.png' };
export const NEWER_TEXT = 'Keep newer raw B\ufeff\rtext';
export const originalFile = descriptor => new File([new Uint8Array([1, 2, 3, 4])], descriptor.name, { type: descriptor.mimeType });

export function previous(overrides = {}) {
  // Deliberately not submitted-array order. The native API consumes missing-pin
  // order; duplicate A occurrences have distinct original local identities.
  const attachments = [A, B, A], localIds = [L1, L2, L3];
  return intent({ attachments, submittedLocalIds: localIds,
    missingBytePins: [{ localId: L2, attachment: B }, { localId: L1, attachment: A }, { localId: L3, attachment: A }],
    rawSourceEvidence: { kind: 'draft', revision: R1, localIds },
    serializedBody: JSON.stringify({ requestId: intent().requestId, text: intent().text, attachments }), ...overrides });
}

export function recoveredSnapshot(pending = previous()) {
  return snapshot({ pending, text: NEWER_TEXT, revision: R2, localIds: [NEWER_LOCAL],
    items: [{ ...snapshot().items[0], localId: NEWER_LOCAL, name: NEWER_IMAGE.name,
      uploadId: NEWER_IMAGE.attachmentId, descriptor: NEWER_IMAGE }] });
}

export function seedPrevious(pending = previous()) {
  const value = recoveredSnapshot(pending); ports.native.publish(value);
  ports.native.getBlob.mockImplementation(async localId => {
    const current = ports.native.getPendingIntent();
    const index = current?.submittedLocalIds.indexOf(localId) ?? -1;
    const descriptor = localId === NEWER_LOCAL ? NEWER_IMAGE : current?.attachments?.[index];
    if (!descriptor || current?.missingBytePins.some(pin => pin.localId === localId)) throw Object.assign(new Error('Missing original bytes'), { code: 'missing_bytes' });
    return { blob: originalFile(descriptor), localId, uploadId: descriptor.attachmentId, mimeType: descriptor.mimeType,
      bytes: descriptor.bytes, name: descriptor.name, artifactId: descriptor.artifactId, rawSha256: 'd'.repeat(64) };
  });
  const store = getComposerDraftStore(SESSION.id); store.setText(NEWER_TEXT);
  const key = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id));
  if (!key) throw new Error('The real facade did not create its legacy draft key.');
  localStorage.setItem(key, JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: JSON.parse(value.scopeKey),
    authorityId: value.authorityId, legacySourceSha256: 'd'.repeat(64) }));
  return { pending, value, store };
}

export const committed = value => ({ committed: true, headRevision: value.headRevision, revision: value.revision, snapshot: value });
export function installSuccessfulRestore(pending = ports.native.getPendingIntent()) {
  const restored = recoveredSnapshot(Object.freeze({ ...pending, missingBytePins: [] }));
  ports.native.restorePendingBytes.mockImplementation(async () => { ports.native.publish(restored); return committed(restored); });
  return restored;
}

export function noMutationSpies(native) {
  return [native.addFiles, native.beginUpload, native.completeUpload, native.failUpload, native.removeImage,
    native.completeRemoval, native.prepareIntent, native.confirmIntent, native.flush, native.setText];
}

export function presentation(previousOverrides = {}, overrides = {}) {
  return { scopeKey: JSON.stringify(['join-fixture-owner', window.location.origin + '/', 'home', SESSION.id]), generation: 1,
    items: [], admission: { state: 'blocked', reason: 'This model does not accept images.' },
    canAdd: false, canSend: false, error: '', isHydrating: false, isSaving: false,
    pendingPreviousSend: { requestId: previous().requestId, status: 'missing_bytes', body: { text: previous().text, attachments: [A, B, A] },
      originalsRevision: 1, originalsState: 'missing', originalsError: '', originalsCanChoose: true, originalsCanSave: false,
      originals: previous().missingBytePins.map((pin, slot) => ({ slot, name: pin.attachment.name, mimeType: pin.attachment.mimeType, bytes: pin.attachment.bytes, selected: false })), ...previousOverrides },
    addFiles: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}), removeImage: vi.fn(async () => {}),
    selectOriginalImage: vi.fn(async () => ({ selected: true })), saveOriginalImages: vi.fn(async () => ({ committed: true })),
    checkPreviousSend: vi.fn(async () => {}), retryPreviousSend: vi.fn(async () => {}), ...overrides };
}

export const statusBarProps = (userImages, overrides = {}) => ({ sessionId: SESSION.id, userImages, attachmentsEnabled: false,
  composerValue: NEWER_TEXT, composerAttachments: [], onComposerChange: vi.fn(), onComposerSubmit: vi.fn(),
  onComposerAttachmentAdd: vi.fn(), onComposerAttachmentRemove: vi.fn(), showTopRow: false, showComposerFooter: false,
  showAiSelector: false, showMicButtons: false, showAutocorrectToggle: false, ...overrides });
