import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadsSessionItem from './ThreadsSessionItem';

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}));

function buildSession(overrides = {}) {
  return {
    id: 'session-1',
    title: 'Old title',
    createdAt: '2026-03-05T18:00:00.000Z',
    thread: {
      topic: 'Old title',
      ...overrides.thread,
    },
    ...overrides,
  };
}

describe('ThreadsSessionItem', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renames the terminal label from the explicit rename action', () => {
    const onRenameSession = vi.fn();

    render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={true}
        hasActivity={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={onRenameSession}
        onClose={vi.fn()}
      />
    );

    fireEvent.mouseEnter(screen.getByText('Old title').closest('.threads-session-item'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('Old title');
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSession).toHaveBeenCalledWith('session-1', 'New title');
  });

  it('shows a ready dot for inactive threads with completed activity', () => {
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={false}
        hasActivity={true}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.threads-session-indicator.ready')).toBeTruthy();
    expect(screen.getByLabelText('Ready to review')).toBeInTheDocument();
  });

  it('does not show the ready dot for the active thread', () => {
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={true}
        hasActivity={true}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.threads-session-indicator.ready')).toBeNull();
  });
});
