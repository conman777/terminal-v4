import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThreadsSidebar from './ThreadsSidebar';

function buildSession(id, title, overrides = {}) {
  return {
    id,
    title,
    shell: 'claude',
    updatedAt: '2026-03-05T18:00:00.000Z',
    cwd: 'C:\\repo',
    thread: {
      topic: title,
      projectPath: 'C:\\repo',
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
    pinnedSessions: [buildSession('session-3', 'Pinned work', { thread: { pinned: true, topic: 'Pinned work', projectPath: 'C:\\repo' } })],
    archivedSessions: [buildSession('session-4', 'Archived work', { thread: { archived: true, topic: 'Archived work', projectPath: 'C:\\repo' } })],
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
    onCloseProject: vi.fn(),
    projects: [{ path: 'C:\\repo', name: 'terminal v4' }],
    onAddProject: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSidebar', () => {
  it('renders new thread button and threads section', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('New thread')).toBeInTheDocument();
    expect(screen.getByText('Threads')).toBeInTheDocument();
  });

  it('renders add project button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('Add project')).toBeInTheDocument();
  });

  it('renders settings button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows empty state when no projects and no sessions', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [],
      sessionsGroupedByProject: [],
      pinnedSessions: [],
      archivedSessions: []
    })} />);

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('renders manually added projects without sessions', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [{ path: 'C:\\manual-project', name: 'manual-project' }],
      sessionsGroupedByProject: [],
      pinnedSessions: [],
      archivedSessions: []
    })} />);

    expect(screen.getByText('manual-project')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('does not duplicate a manual project when a session group uses forward slashes', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [{ path: 'C:\\repo\\uplifting', name: 'uplifting' }],
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:/repo/uplifting',
          sessions: [buildSession('session-1', 'Implement feature', { thread: { projectPath: 'C:/repo/uplifting' } })]
        }
      ],
      pinnedSessions: [],
      archivedSessions: []
    })} />);

    expect(screen.getAllByText('uplifting')).toHaveLength(1);
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
  });

  it('renders pinned section when pinned sessions exist', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('calls onCloseProject with the project path and session ids', async () => {
    const onCloseProject = vi.fn();

    render(<ThreadsSidebar {...buildProps({ onCloseProject })} />);

    await screen.getByLabelText('Close project').click();

    expect(onCloseProject).toHaveBeenCalledWith('C:\\repo', ['session-1', 'session-2']);
  });

  it('uses theme-aware sidebar palette tokens', () => {
    const { container } = render(<ThreadsSidebar {...buildProps()} />);
    const styles = Array.from(container.querySelectorAll('style'))
      .map((styleNode) => styleNode.textContent || '')
      .join('\n');

    expect(styles).toContain('var(--bg-primary)');
    expect(styles).toContain('var(--text-primary)');
    expect(styles).toContain('var(--text-muted)');
  });
});
