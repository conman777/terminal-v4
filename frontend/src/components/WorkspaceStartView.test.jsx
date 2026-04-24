import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceStartView } from './WorkspaceStartView';
import { AutocorrectProvider } from '../contexts/AutocorrectContext';

vi.mock('../hooks/useAutocorrectInput', () => ({
  useAutocorrectInput: () => ({
    handleKeyDown: () => false,
    handleSelectionChange: () => {},
  }),
}));

describe('WorkspaceStartView', () => {
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
