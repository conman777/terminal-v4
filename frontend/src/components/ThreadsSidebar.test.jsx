import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThreadsSidebar from './ThreadsSidebar';

function buildSession(id, title, overrides = {}) {
  return {
    id,
    title,
    shell: 'claude',
    updatedAt: '2026-03-05T18:00:00.000Z',
    thread: {
      topic: title,
      ...overrides.thread
    },
    ...overrides
  };
}

function buildProps(overrides = {}) {
  return {
    isCollapsed: false,
    onToggle: vi.fn(),
    sessionsGroupedByProject: [
      {
        projectName: 'terminal v4',
        projectPath: 'C:\\repo',
        sessions: [buildSession('session-1', 'Implement feature'), buildSession('session-2', 'Fix layout')]
      }
    ],
    pinnedSessions: [buildSession('session-3', 'Pinned work', { thread: { pinned: true, topic: 'Pinned work' } })],
    archivedSessions: [buildSession('session-4', 'Archived work', { thread: { archived: true, topic: 'Archived work' } })],
    activeSessionId: 'session-1',
    sessionActivity: {},
    onSelectSession: vi.fn(),
    onPinSession: vi.fn(),
    onUnpinSession: vi.fn(),
    onArchiveSession: vi.fn(),
    onUnarchiveSession: vi.fn(),
    onTopicChange: vi.fn(),
    onCloseSession: vi.fn(),
    onCreateSession: vi.fn(),
    onToggleSidebarMode: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSidebar', () => {
  it('renders overview counts for active, pinned, and archived sessions', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('3 active')).toBeInTheDocument();
    expect(screen.getByText('1 pinned')).toBeInTheDocument();
    expect(screen.getByText('1 archived')).toBeInTheDocument();
  });
});
