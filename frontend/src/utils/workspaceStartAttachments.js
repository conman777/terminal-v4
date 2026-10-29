import { captureAuthScope, isAuthScopeCurrent } from './auth';
import { getEnvironmentSignal, getEnvironmentStorage } from './remoteEnvironments';
import { cloneImageAttachments } from './userImageInput';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Uploaded paths and the launch hold belong to the account and environment that created them.
export function createWorkspaceStartAttachments() {
  const auth = captureAuthScope();
  const signal = getEnvironmentSignal();
  const storage = getEnvironmentStorage();
  const key = `workspaceStartAttachments:v1:${encodeURIComponent(auth.home)}:${encodeURIComponent(auth.userId || '')}`;
  const listeners = new Set();
  let raw, corrupt = false;
  let state = { attachments: [], pending: false, pendingKind: 'task', imageTransfer: null, error: '' };
  const current = () => Boolean(auth.userId) && !signal.aborted && isAuthScopeCurrent(auth);
  const publish = next => { state = next; listeners.forEach(listener => listener()); };
  try {
    if (!current()) throw new Error('Authentication is unavailable.');
    raw = storage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !Array.isArray(saved.attachments) || typeof saved.pending !== 'boolean'
        || saved.attachments.some(item => !item || typeof item.name !== 'string' || typeof item.path !== 'string' || !item.path)) throw new Error('Invalid attachment draft.');
      if (saved.pendingKind != null && !['task', 'conversation', 'image'].includes(saved.pendingKind)) throw new Error('Invalid pending request.');
      if (saved.imageTransfer != null && (!saved.pending || saved.pendingKind !== 'image'
        || typeof saved.imageTransfer !== 'object' || !UUID.test(saved.imageTransfer.requestId)
        || !Array.isArray(saved.imageTransfer.sourceScope)
        || !Array.isArray(saved.imageTransfer.sourceLocalIds) || typeof saved.imageTransfer.sourceAuthorityId !== 'string'
        || typeof saved.imageTransfer.sourceRevision !== 'string' || typeof saved.imageTransfer.text !== 'string'
        || (saved.imageTransfer.targetScope != null && (!Array.isArray(saved.imageTransfer.targetScope) || saved.imageTransfer.targetScope.length !== 4))
        || (saved.imageTransfer.targetRevision != null && !UUID.test(saved.imageTransfer.targetRevision))
        || (saved.imageTransfer.targetLocalIds != null && (!Array.isArray(saved.imageTransfer.targetLocalIds) || saved.imageTransfer.targetLocalIds.some(id => !UUID.test(id))))
        || (saved.imageTransfer.messageRequestId != null && !UUID.test(saved.imageTransfer.messageRequestId)))) throw new Error('Invalid image request.');
      if (saved.imageTransfer?.attachments != null) cloneImageAttachments(saved.imageTransfer.attachments);
      state = { attachments: saved.attachments, pending: saved.pending, pendingKind: saved.pendingKind || 'task', imageTransfer: saved.imageTransfer || null, error: '' };
    }
  } catch {
    corrupt = true;
    state = { ...state, error: 'Saved attachments could not be read. Restore device storage before starting.' };
  }
  function save(next) {
    if (!current()) return false;
    try {
      if (corrupt || storage.getItem(key) !== raw) throw new Error('Attachment draft changed.');
      const value = JSON.stringify({ version: 1, attachments: next.attachments, pending: next.pending, pendingKind: next.pendingKind, imageTransfer: next.imageTransfer || null });
      storage.setItem(key, value);
      raw = value;
      publish({ ...next, error: '' });
      return true;
    } catch {
      publish({ ...next, error: 'Attachments could not be saved on this device. Keep this tab open and restore device storage before starting.' });
      return false;
    }
  }
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    add: item => save({ ...state, attachments: [...state.attachments, item] }),
    remove: path => save({ ...state, attachments: state.attachments.filter(item => item.path !== path) }),
    begin: (kind = 'task') => !state.pending && ['task', 'conversation'].includes(kind) && save({ ...state, pending: true, pendingKind: kind }),
    beginImage: source => !state.pending && typeof source?.requestId === 'string' && save({ ...state, pending: true, pendingKind: 'image', imageTransfer: source }),
    bindImage: binding => state.pending && state.pendingKind === 'image' && state.imageTransfer
      && ['requestId', 'sourceAuthorityId', 'sourceRevision', 'text'].every(key => binding?.[key] === state.imageTransfer[key])
      && JSON.stringify(binding.sourceScope) === JSON.stringify(state.imageTransfer.sourceScope)
      && JSON.stringify(binding.sourceLocalIds) === JSON.stringify(state.imageTransfer.sourceLocalIds)
      && (!state.imageTransfer.targetScope || JSON.stringify(binding.targetScope) === JSON.stringify(state.imageTransfer.targetScope))
      && (!state.imageTransfer.creation || JSON.stringify(binding.creation) === JSON.stringify(state.imageTransfer.creation))
      && (!state.imageTransfer.messageRequestId || binding.messageRequestId === state.imageTransfer.messageRequestId)
      && (!state.imageTransfer.targetRevision || binding.targetRevision === state.imageTransfer.targetRevision)
      && (!state.imageTransfer.targetLocalIds || JSON.stringify(binding.targetLocalIds) === JSON.stringify(state.imageTransfer.targetLocalIds))
      && (!state.imageTransfer.attachments || JSON.stringify(binding.attachments) === JSON.stringify(state.imageTransfer.attachments))
      && save({ ...state, imageTransfer: binding }),
    complete: submitted => {
      if (!current()) return;
      const matching = state.attachments.length === submitted.length && state.attachments.every((item, i) => item.path === submitted[i].path);
      save({ ...state, attachments: matching ? [] : state.attachments, pending: false, imageTransfer: null });
    },
    release: () => save({ ...state, pending: false, imageTransfer: null }),
    retrySave: () => save(state),
  };
}
