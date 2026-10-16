import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as environments from '../utils/remoteEnvironments';
import { WorkspaceStartView } from './WorkspaceStartView';
import { AutocorrectProvider } from '../contexts/AutocorrectContext';

vi.mock('../hooks/useAutocorrectInput', () => ({
  useAutocorrectInput: () => ({
    handleKeyDown: () => false,
    handleSelectionChange: () => {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe('WorkspaceStartView', () => {
  it('keeps the new workspace composer read-only on observer hosts', () => {
    vi.spyOn(environments, 'getActiveEnvironment').mockReturnValue({ id: 'observer-host', capabilities: { terminalInput: false } });
    const onCreateSession = vi.fn();
    const onSubmitPrompt = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath='C:/remote' onCreateSession={onCreateSession} onSubmitPrompt={onSubmitPrompt} /></AutocorrectProvider>);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(screen.getByText('This environment is read-only. Select an existing thread to view its output.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it('shows a workspace-first start screen before opening a terminal', () => {
    const onCreateSession = vi.fn();
    const onSubmitPrompt = vi.fn();
    const onAddWorkspace = vi.fn();

    render(
      <AutocorrectProvider>
        <WorkspaceStartView
          currentPath="C:/work/terminal-v4"
          onCreateSession={onCreateSession}
          onSubmitPrompt={onSubmitPrompt}
          onAddWorkspace={onAddWorkspace}
        />
      </AutocorrectProvider>
    );

    expect(screen.getByText('C:/work/terminal-v4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What are we building?' })).toBeInTheDocument();
    expect(screen.getByText('Your agents. Your machines. One workspace.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), {
      target: { value: 'Open the API project and inspect auth' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));

    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(onSubmitPrompt).toHaveBeenCalledWith('Open the API project and inspect auth');
  });
});
