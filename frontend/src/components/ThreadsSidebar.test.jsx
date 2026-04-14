import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ThreadsSidebar from './ThreadsSidebar';

const toggleTheme = vi.fn();
const downloadProjectArchiveMock = vi.fn();
const sidebarCss = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ThreadsSidebar.css'), 'utf8');

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme
  })
}));

vi.mock('../utils/projectArchiveDownload', () => ({
  downloadProjectArchive: (...args) => downloadProjectArchiveMock(...args)
}));

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
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    showPreview: false,
    onTogglePreview: vi.fn(),
    showFileManager: false,
    onToggleFileManager: vi.fn(),
    logout: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSidebar', () => {
  beforeEach(() => {
    downloadProjectArchiveMock.mockReset();
  });

  it('renders the utility toolbar and projects section', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Bookmarks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('PROJECTS')).toBeInTheDocument();
  });

  it('opens sidebar utility actions above new thread', () => {
    const onOpenBookmarks = vi.fn();
    const onOpenNotes = vi.fn();
    const onToggleFileManager = vi.fn();
    const onTogglePreview = vi.fn();

    render(<ThreadsSidebar {...buildProps({ onOpenBookmarks, onOpenNotes, onToggleFileManager, onTogglePreview })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(onOpenBookmarks).toHaveBeenCalledTimes(1);
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
    expect(onToggleFileManager).toHaveBeenCalledTimes(1);
    expect(onTogglePreview).toHaveBeenCalledTimes(1);
  });

  it('renders add project button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Add Project' })).toBeInTheDocument();
  });

  it('renders settings button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });

  it('shows empty state when no projects and no sessions', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [],
      sessionsGroupedByProject: [],
      pinnedSessions: [],
      archivedSessions: []
    })} />);

    expect(screen.getByText('No active projects')).toBeInTheDocument();
  });

  it('renders manually added projects without sessions', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [{ path: 'C:\\manual-project', name: 'manual-project' }],
      sessionsGroupedByProject: [],
      pinnedSessions: [],
      archivedSessions: []
    })} />);

    expect(screen.getByText('manual-project')).toBeInTheDocument();
    expect(screen.queryByText('No active projects')).not.toBeInTheDocument();
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

    expect(screen.getByText('PINNED')).toBeInTheDocument();
  });

  it('calls onCloseProject with the project path and session ids', async () => {
    const onCloseProject = vi.fn();

    render(<ThreadsSidebar {...buildProps({ onCloseProject })} />);

    await screen.getByLabelText('Close project').click();

    expect(onCloseProject).toHaveBeenCalledWith('C:\\repo', ['session-1', 'session-2']);
  });

  it('downloads a zipped project from the project group header', async () => {
    render(<ThreadsSidebar {...buildProps()} />);

    await screen.getByLabelText('Zip and download terminal v4').click();

    expect(downloadProjectArchiveMock).toHaveBeenCalledWith('C:\\repo');
  });

  it('uses the sidebar palette tokens defined in the stylesheet', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(sidebarCss).toContain('var(--pro-sidebar-bg)');
    expect(sidebarCss).toContain('var(--pro-sidebar-text)');
    expect(sidebarCss).toContain('var(--pro-sidebar-muted)');
  });
});
