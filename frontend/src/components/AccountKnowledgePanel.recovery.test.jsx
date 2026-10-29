import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountKnowledgePanel } from './AccountKnowledgePanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const loadAccountKnowledge = vi.hoisted(() => vi.fn());
vi.mock('../utils/workspaceProfile', () => ({ loadAccountKnowledge, saveAccountKnowledge: vi.fn() }));
vi.mock('./WorkspaceProposalsPanel', () => ({ AccountProposalsPanel: () => null }));
afterEach(() => { cleanup(); setActiveEnvironment(null); });

it('retries an initial account knowledge failure without leaving settings', async () => {
  loadAccountKnowledge.mockRejectedValueOnce(new Error('Synthetic knowledge unavailable')).mockResolvedValueOnce({ memory: 'Synthetic saved preference', skills: [] });
  render(<AccountKnowledgePanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic knowledge unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading account knowledge' }));
  expect(await screen.findByLabelText('Account knowledge')).toHaveValue('Synthetic saved preference');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(loadAccountKnowledge).toHaveBeenCalledTimes(2);
});

it('explains Home ownership on paired hosts without requesting blocked knowledge routes', () => {
  setActiveEnvironment({ id: 'synthetic-remote' });
  loadAccountKnowledge.mockClear();
  render(<AccountKnowledgePanel />);
  expect(screen.getByText(/Select Home to manage account knowledge/i)).toBeVisible();
  expect(loadAccountKnowledge).not.toHaveBeenCalled();
});
