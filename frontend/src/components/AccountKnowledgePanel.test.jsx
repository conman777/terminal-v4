import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountKnowledgePanel } from './AccountKnowledgePanel';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const profile = { memory: 'Prefer concise explanations.', skills: [], defaultAgent: '', selection: null };
const proposal = { id: '00000000-0000-4000-8000-000000000010', title: 'Cross-project preference', reason: 'Explicitly requested.', status: 'pending', operations: [{ kind: 'memoryAppend', content: 'Use accessible controls.' }] };
const response = payload => ({ ok: true, json: async () => payload });

describe('AccountKnowledgePanel', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async url => response(url.includes('/proposals') ? { proposals: [proposal] } : profile));
  });
  it('loads and manually saves only account knowledge without a workspace query', async () => {
    render(<AccountKnowledgePanel />);
    fireEvent.change(await screen.findByLabelText('Account knowledge'), { target: { value: 'Use keyboard-accessible UI.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save account knowledge' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/account/knowledge', { method: 'PUT', body: { ...profile, memory: 'Use keyboard-accessible UI.' } }));
    expect(apiFetch.mock.calls.every(([url]) => url.startsWith('/api/account/knowledge') && !url.includes('?'))).toBe(true);
  });
  it('keeps automatic suggestions staged until explicit acceptance then reloads the editor', async () => {
    apiFetch.mockImplementation(async (url, options) => response(options?.method === 'POST' ? { profile: { ...profile, memory: 'Approved knowledge.' } } : url.includes('/proposals') ? { proposals: [proposal] } : profile));
    render(<AccountKnowledgePanel />);
    expect(await screen.findByText('Use accessible controls.')).toBeInTheDocument();
    expect(screen.getByLabelText('Account knowledge')).toHaveValue(profile.memory);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept Cross-project preference' }));
    await waitFor(() => expect(screen.getByLabelText('Account knowledge')).toHaveValue('Approved knowledge.'));
    expect(apiFetch).toHaveBeenCalledWith('/api/account/knowledge/proposals/' + proposal.id + '/accept', { method: 'POST' });
  });
  it('retains an unsaved edit when another staged proposal is accepted', async () => {
    let saved = profile;
    apiFetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') { saved = { ...profile, memory: 'Accepted elsewhere.' }; return response({ profile: saved }); }
      return response(url.includes('/proposals') ? { proposals: [proposal] } : saved);
    });
    render(<AccountKnowledgePanel />);
    fireEvent.change(await screen.findByLabelText('Account knowledge'), { target: { value: 'Unsaved manual knowledge.' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Cross-project preference' }));
    expect(await screen.findByText(/unsaved edits were kept/)).toBeInTheDocument();
    expect(screen.getByLabelText('Account knowledge')).toHaveValue('Unsaved manual knowledge.');
    expect(screen.getByRole('button', { name: 'Save account knowledge' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload saved knowledge' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved knowledge' }));
    await waitFor(() => expect(screen.getByLabelText('Account knowledge')).toHaveValue('Accepted elsewhere.'));
  });
});
