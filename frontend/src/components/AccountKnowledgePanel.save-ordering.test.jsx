import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountKnowledgePanel } from './AccountKnowledgePanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const initial = { memory: 'Baseline.', skills: [], defaultAgent: '', selection: null };
const manual = 'Manual draft.';
const fact = 'Approved fact.';
const proposal = { id: '00000000-0000-4000-8000-000000000010', title: 'Approved fact', reason: 'Synthetic test', status: 'pending', operations: [{ kind: 'memoryAppend', content: fact }] };
const reply = value => ({ ok: true, json: async () => structuredClone(value) });
const saveButton = () => screen.getByRole('button', { name: 'Save account knowledge' });
const acceptButton = () => screen.getByRole('button', { name: 'Accept Approved fact' });
const editor = () => screen.getByLabelText('Account knowledge');

function controlledStore() {
  let saved = structuredClone(initial);
  let receipt = 'pending';
  const paused = new Map();
  const pending = new Map();
  apiFetch.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET';
    const operation = method === 'PUT' ? 'save' : method === 'POST' ? 'accept' : url.endsWith('/proposals') ? 'list' : 'load';
    if (paused.has(operation)) await new Promise((resolve, reject) => pending.set(operation, { resolve, reject }));
    if (operation === 'save') saved = structuredClone(options.body);
    if (operation === 'accept') {
      saved.memory += '\n\n' + fact;
      receipt = 'accepted';
      return reply({ profile: saved });
    }
    return reply(operation === 'list' ? { proposals: [{ ...proposal, status: receipt }] } : saved);
  });
  return {
    pause: operation => paused.set(operation, true),
    finish: async (operation, failure) => {
      await waitFor(() => expect(pending.has(operation)).toBe(true));
      await act(async () => {
        const request = pending.get(operation);
        pending.delete(operation); paused.delete(operation);
        if (failure) request.reject(new Error(failure)); else request.resolve();
      });
    },
    saved: () => structuredClone(saved),
    externalChange: memory => { saved = { ...saved, memory }; },
    writes: () => apiFetch.mock.calls.filter(([, options]) => ['PUT', 'POST'].includes(options?.method)).map(([url, options]) => ({ url, method: options.method })),
  };
}

async function openEditor() {
  render(<AccountKnowledgePanel />);
  await screen.findByRole('button', { name: 'Accept Approved fact' });
  fireEvent.change(editor(), { target: { value: manual } });
}

describe('AccountKnowledgePanel write ownership', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('finishes a manual save before allowing acceptance and preserves both changes', async () => {
    const store = controlledStore(); store.pause('save');
    await openEditor();
    fireEvent.click(saveButton());
    expect(acceptButton()).toBeDisabled();
    fireEvent.click(acceptButton());
    expect(store.writes()).toEqual([{ url: '/api/account/knowledge', method: 'PUT' }]);
    await store.finish('save');
    await waitFor(() => expect(acceptButton()).toBeEnabled());
    fireEvent.click(acceptButton());
    const combined = manual + '\n\n' + fact;
    await waitFor(() => expect(editor()).toHaveValue(combined));
    expect(store.saved()).toEqual({ ...initial, memory: combined });
    expect(screen.queryByRole('button', { name: 'Reload saved knowledge' })).not.toBeInTheDocument();
  });

  it('blocks stale manual submission while acceptance owns the write and retains the draft', async () => {
    const store = controlledStore(); store.pause('accept');
    await openEditor();
    fireEvent.click(acceptButton());
    expect(saveButton()).toBeDisabled();
    fireEvent.submit(saveButton().closest('form'));
    expect(store.writes()).toEqual([{ url: '/api/account/knowledge/proposals/' + proposal.id + '/accept', method: 'POST' }]);
    await store.finish('accept');
    await screen.findByText(/unsaved edits were kept/);
    expect(editor()).toHaveValue(manual);
    expect(store.saved()).toEqual({ ...initial, memory: initial.memory + '\n\n' + fact });
    fireEvent.submit(saveButton().closest('form'));
    expect(store.writes()).toHaveLength(1);
  });

  it('allows a later manual edit based on the completed acceptance', async () => {
    const store = controlledStore(); store.pause('accept');
    render(<AccountKnowledgePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Approved fact' }));
    expect(saveButton()).toBeDisabled();
    await store.finish('accept');
    const combined = initial.memory + '\n\n' + fact + '\nManual addition.';
    await waitFor(() => expect(editor()).toBeEnabled());
    expect(editor()).toHaveValue(initial.memory + '\n\n' + fact);
    fireEvent.change(editor(), { target: { value: combined } }); fireEvent.click(saveButton());
    await screen.findByText('Account knowledge saved.');
    expect(store.saved()).toEqual({ ...initial, memory: combined });
  });

  it('retains accepted knowledge and releases ownership when suggestion refresh fails', async () => {
    const store = controlledStore();
    await openEditor(); store.pause('list');
    fireEvent.click(acceptButton());
    await store.finish('list', 'Synthetic list failure');
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic list failure');
    expect(editor()).toHaveValue(manual);
    expect(store.saved()).toEqual({ ...initial, memory: initial.memory + '\n\n' + fact });
    const reload = screen.getByRole('button', { name: 'Reload saved knowledge' });
    expect(reload).toBeEnabled(); fireEvent.click(reload);
    await waitFor(() => expect(editor()).toHaveValue(initial.memory + '\n\n' + fact));
    expect(saveButton()).toBeEnabled();
  });

  it('reloads current server knowledge instead of the cached acceptance response', async () => {
    const store = controlledStore();
    await openEditor(); fireEvent.click(acceptButton());
    await screen.findByText(/unsaved edits were kept/);
    const fresh = initial.memory + '\n\n' + fact + '\n\nLater saved knowledge.';
    store.externalChange(fresh);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved knowledge' }));
    await waitFor(() => expect(editor()).toHaveValue(fresh));
    expect(screen.getByText('Saved knowledge reloaded.')).toBeInTheDocument();
    fireEvent.change(editor(), { target: { value: fresh + '\nManual addition.' } });
    fireEvent.click(saveButton());
    await screen.findByText('Account knowledge saved.');
    expect(store.saved()).toEqual({ ...initial, memory: fresh + '\nManual addition.' });
  });

  it('keeps the draft and conflict after failed reload and permits a fresh retry', async () => {
    const store = controlledStore();
    await openEditor(); fireEvent.click(acceptButton());
    await screen.findByText(/unsaved edits were kept/);
    store.pause('load');
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved knowledge' }));
    await store.finish('load', 'Synthetic reload failure');
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic reload failure');
    expect(editor()).toHaveValue(manual);
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved knowledge' }));
    await waitFor(() => expect(editor()).toHaveValue(initial.memory + '\n\n' + fact));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('releases failed save ownership so the retained draft remains editable and retryable', async () => {
    const store = controlledStore(); store.pause('save');
    await openEditor(); fireEvent.click(saveButton());
    await store.finish('save', 'Synthetic save failure');
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic save failure');
    expect(editor()).toHaveValue(manual); expect(editor()).toBeEnabled(); expect(acceptButton()).toBeEnabled();
    const revised = manual + ' Retry edit.';
    fireEvent.change(editor(), { target: { value: revised } }); fireEvent.click(saveButton());
    await screen.findByText('Account knowledge saved.');
    expect(store.saved()).toEqual({ ...initial, memory: revised });
  });

  it('releases failed acceptance ownership and permits retry without losing unsaved edits', async () => {
    const store = controlledStore(); store.pause('accept');
    await openEditor(); fireEvent.click(acceptButton());
    await store.finish('accept', 'Synthetic acceptance failure');
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic acceptance failure');
    expect(editor()).toHaveValue(manual); expect(editor()).toBeEnabled(); expect(saveButton()).toBeEnabled();
    fireEvent.click(acceptButton());
    await screen.findByText(/unsaved edits were kept/);
    expect(editor()).toHaveValue(manual);
    expect(store.saved()).toEqual({ ...initial, memory: initial.memory + '\n\n' + fact });
  });

  it.each(['save-first', 'accept-first'])('claims ownership synchronously before React renders: %s', async ordering => {
    const store = controlledStore(); store.pause('save'); store.pause('accept');
    await openEditor();
    const form = saveButton().closest('form'); const accept = acceptButton();
    act(() => {
      if (ordering === 'save-first') {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); accept.click();
      } else {
        accept.click(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    expect(store.writes()).toEqual([ordering === 'save-first'
      ? { url: '/api/account/knowledge', method: 'PUT' }
      : { url: '/api/account/knowledge/proposals/' + proposal.id + '/accept', method: 'POST' }]);
    await store.finish(ordering === 'save-first' ? 'save' : 'accept');
  });
});
