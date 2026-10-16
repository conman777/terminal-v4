import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceSkillsPanel } from './WorkspaceSkillsPanel';
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const path = '/projects/example';
const skill = { id: 'skill-1', provider: 'claude', scope: 'project', name: 'review', path: '/projects/example/.claude/skills/review/SKILL.md', instructions: 'Check error boundaries.' };

describe('WorkspaceSkillsPanel', () => {
  beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true, json: async () => ({ skills: [skill], warnings: [] }) }); });
  it('loads real installed Markdown and adds selected text to an editable prompt', async () => {
    const onInsertContext = vi.fn();
    render(<WorkspaceSkillsPanel workspacePath={path} onInsertContext={onInsertContext} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include review (claude, project)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add installed skills to prompt' }));
    expect(onInsertContext).toHaveBeenCalledWith('Installed skill: review (claude, project)\nSource: ' + skill.path + '\n\nCheck error boundaries.');
    expect(apiFetch).toHaveBeenCalledWith('/api/workspace/skills?path=' + encodeURIComponent(path), { signal: expect.any(AbortSignal) });
  });
  it('reports bounded scan warnings and errors without offering invented skills', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ skills: [], warnings: ['Some skills were too large.'] }) });
    render(<WorkspaceSkillsPanel workspacePath={path} onInsertContext={vi.fn()} />);
    expect(await screen.findByText('Some skills were too large.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add installed skills to prompt' })).toBeDisabled();
  });
  it('does not use a previous workspace selection after changing project', async () => {
    const onInsertContext = vi.fn();
    const { rerender } = render(<WorkspaceSkillsPanel workspacePath={path} onInsertContext={onInsertContext} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include review (claude, project)' }));
    rerender(<WorkspaceSkillsPanel workspacePath="/projects/next" onInsertContext={onInsertContext} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add installed skills to prompt' })).toBeDisabled());
  });
});
