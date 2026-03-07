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
    projects: [
      { name: 'terminal v4', path: 'C:\\repo' },
      { name: 'uplifting', path: 'C:\\uplifting' }
    ],
    projectsLoading: false,
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
    onAddProject: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleSidebarMode: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSidebar', () => {
  it('renders folder groups with their terminal sessions underneath', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new thread/i })).toBeInTheDocument();
    expect(screen.getByText('terminal v4')).toBeInTheDocument();
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
    expect(screen.getByText('Fix layout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
  });

  it('shows scanned folders even before they have terminal sessions', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('uplifting')).toBeInTheDocument();
    expect(screen.getByText('No terminals yet')).toBeInTheDocument();
  });
});
