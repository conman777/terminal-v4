import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, SESSION, A, B, L1, L2, R1, R2, CATALOG, RAW, CANONICAL, file, snapshot, intent, accepted, response, deferred, Socket } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn(), uploadScreenshot: vi.fn(async () => { throw new Error('Legacy upload must not run in this owned-image test'); }), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));
vi.mock('../utils/clipboardImage', () => ({ getImageFileFromDataTransfer: vi.fn(async () => null) }));
vi.mock('../utils/autocorrect', () => ({ getSpellChecker: vi.fn(async () => ({ correct: () => true, suggest: () => [] })), getTerminalAutocorrectEdit: vi.fn(() => null), shouldResetTerminalAutocorrectState: vi.fn(() => false) }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ listSessionGitBranches: vi.fn(), checkoutSessionGitBranch: vi.fn(), sendToSession: vi.fn(), updateThreadMetadata: vi.fn() }) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
// The unrelated PTY hook has no agent transport in these owned V4 tests.
vi.mock('../hooks/useMobileChatTurns', () => ({ useMobileChatTurns: () => ({ turns: [], isLoading: false, isSendReady: true, handleTurn: vi.fn(), handleRegisterSendText: vi.fn(), handleChatSend: vi.fn(), handleRawSend: vi.fn(), handleInterrupt: vi.fn() }) }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { TerminalPane } from './TerminalPane';
import { MobileShell } from './MobileShell';
import { DesktopConversationView } from './DesktopConversationView';

const previousSocket = globalThis.WebSocket;
const previousObserver = globalThis.IntersectionObserver;
const previousCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const previousRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const commit = value => ({ committed: true, headRevision: value.headRevision, revision: value.revision, snapshot: value });
function scriptIngress(raw) {
  const empty = snapshot({ text: raw, localIds: [], items: [] });
  const local = snapshot({ text: raw, items: [{ ...snapshot().items[0], uploadState: 'local', descriptor: null }] });
  const ready = snapshot({ text: raw });
  ports.native.publish(snapshot({ ...empty, storageState: 'legacy' }));
  ports.native.promoteLegacy.mockImplementation(async () => { ports.native.publish(empty); return empty; });
  ports.native.addFiles.mockImplementation(async () => { ports.native.publish(local); return commit(local); });
  ports.native.completeUpload.mockImplementation(async () => { ports.native.publish(ready); return { applied: true, snapshot: ready }; });
  const original = intent({ text: raw ? CANONICAL : '', serializedBody: JSON.stringify({ requestId: intent().requestId, text: raw ? CANONICAL : '', attachments: [A] }) });
  ports.native.prepareIntent.mockResolvedValue(original);
  return original;
}
const desktopProps = session => ({ pane: { id: 'pane-fixture', sessionId: session.id }, sessions: [session], isActive: true, onFocus: vi.fn(),
  canSplit: false, canClose: false, sessionActivity: {}, sessionAiTypes: {}, projectInfo: { cwd: session.cwd }, viewportHeight: 900 });
const parent = (kind, session = SESSION) => kind === 'desktop' ? <TerminalPane {...desktopProps(session)} /> : <MobileShell sessions={[session]} activeSessionId={session.id} viewportHeight={844} sessionAiTypes={{}} />;
async function connect() { await act(async () => { for (const socket of Socket.instances) socket.onopen?.(); }); }
async function chooseReady() {
  const add = screen.getByRole('button', { name: 'Add image' });
  await waitFor(() => expect(add).toBeEnabled()); fireEvent.click(add);
  fireEvent.change(screen.getByLabelText('Choose images'), { target: { files: [file()] } });
  await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
}
beforeEach(() => {
  resetFixture(); globalThis.WebSocket = Socket; Socket.instances = [];
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:join-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  apiFetch.mockReset().mockImplementation(async (url, options) => {
    if (url === '/api/agent/catalog') return response(CATALOG);
    if (url.endsWith('/attachments')) return response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201);
    if (url.endsWith('/attachments/send')) return response(accepted({ ...JSON.parse(options.body) }));
    return response(null, 404);
  });
});
afterEach(async () => {
  await cleanFixture(); globalThis.WebSocket = previousSocket; globalThis.IntersectionObserver = previousObserver;
  if (previousCreate) Object.defineProperty(URL, 'createObjectURL', previousCreate); else delete URL.createObjectURL;
  if (previousRevoke) Object.defineProperty(URL, 'revokeObjectURL', previousRevoke); else delete URL.revokeObjectURL;
});

describe('actual desktop/mobile parents with shared real StatusBar and structured hook', () => {
  it.each(['desktop', 'mobile'])('[P01/P02] %s accepts known-model image-only file ingress through the actual picker and typed Send', async kind => {
    const original = scriptIngress(''); render(parent(kind)); await connect(); await chooseReady();
    const send = screen.getByRole('button', { name: 'Send message' }); expect(send).toBeEnabled(); fireEvent.click(send);
    await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.endsWith('/attachments/send'))).toBe(true));
    const [, options] = apiFetch.mock.calls.find(([url]) => url.endsWith('/attachments/send'));
    expect(options.body).toBe(original.serializedBody); expect(JSON.parse(options.body)).toMatchObject({ text: '', attachments: [A] });
    expect(apiFetch.mock.calls.some(([url]) => url.endsWith('/input'))).toBe(false);
  });

  it('[P01 unknown] an unknown custom model retains the disabled image gate and permits normal text', async () => {
    ports.native.publish(snapshot({ storageState: 'legacy', localIds: [], items: [], text: '' }));
    render(parent('desktop', { ...SESSION, model: 'custom-unconfirmed' })); await connect();
    expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'healthy plain text' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(ports.nativeFactory).not.toHaveBeenCalled();
  });

  it('[P02 remount] desktop to mobile preserves one original pending request without a lifecycle upload/lookup/send', async () => {
    const original = intent(); ports.native.publish(snapshot({ pending: original, text: 'new raw B', revision: R2, localIds: [L2], items: [] }));
    // The precise promotion marker is written through the native legacy port;
    // it is a local recovery trigger, not authority to choose another scope.
    const facade = getComposerDraftStore(SESSION.id); facade.setText('new raw B');
    const key = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id));
    localStorage.setItem(key, JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: JSON.parse(ports.native.getSnapshot().scopeKey), authorityId: R2, legacySourceSha256: 'd'.repeat(64) }));
    const first = render(parent('desktop')); await connect(); await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous send' })).toBeInTheDocument());
    first.unmount(); apiFetch.mockClear(); render(parent('mobile')); await connect();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('new raw B'));
    expect(ports.native.getSnapshot().pending.requestId).toBe(original.requestId);
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments') || url.includes('/requests/'))).toEqual([]);
    expect(ports.native.beginUpload).not.toHaveBeenCalled();
  });

  it('[P03] a delayed accepted A preserves newer raw B and changed image IDs without independent parent cleanup', async () => {
    const original = scriptIngress(RAW), held = deferred();
    apiFetch.mockImplementation(async (url, options) => url === '/api/agent/catalog' ? response(CATALOG)
      : url.endsWith('/attachments/send') ? held.promise : response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201));
    const facade = getComposerDraftStore(SESSION.id); facade.setText(RAW);
    render(parent('desktop')); await connect(); await chooseReady(); fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.endsWith('/attachments/send'))).toBe(true));
    const newer = snapshot({ text: 'new raw B', revision: R2, committedRevision: R2, localIds: [L2], items: [{ ...snapshot().items[0], localId: L2, descriptor: B, name: B.name }], pending: original });
    await act(async () => { ports.native.publish(newer); });
    ports.native.confirmIntent.mockImplementation(async () => { const settled = { ...newer, pending: null }; ports.native.publish(settled); return { ...commit(settled), clearedDraft: false }; });
    await act(async () => { held.resolve(response(accepted(original))); });
    await waitFor(() => expect(ports.native.confirmIntent).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('new raw B');
    expect(screen.getByText(B.name)).toBeInTheDocument(); expect(ports.native.setText).not.toHaveBeenCalledWith('');
    expect(ports.native.removeImage).not.toHaveBeenCalled();
  });

  it('[P04] the actual canonical user bubble renders unchanged text and ordered owned image refs without a duplicate surface', () => {
    const canonical = 'Canonical event text\rkeeps interior CR';
    const { container } = render(<DesktopConversationView mode="structured" sessionId={SESSION.id} connectionState="online" turns={[]}
      structuredMessages={[{ role: 'user', requestId: intent().requestId, messageId: 'join-message', content: canonical, attachments: [A, B] }]} />);
    const images = screen.getByRole('region', { name: 'Attached images' });
    expect([...images.querySelectorAll('figcaption')].map(node => node.textContent)).toEqual([A.name, B.name]);
    const bubble = images.closest('.cc-user-bubble'); expect(bubble).not.toBeNull();
    expect(bubble.closest('.cc-user').querySelector('.cc-message-author')).toHaveTextContent('You');
    expect(bubble.querySelector('.cc-user-content').textContent).toBe(canonical + images.textContent);
    expect(container.querySelectorAll('.cc-user-bubble')).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Attached images' })).toHaveLength(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
