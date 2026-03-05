import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThreadsSessionItem from './ThreadsSessionItem';

function buildProps(overrides = {}) {
  return {
    session: {
      id: 'session-1',
      title: 'Claude Workspace',
      shell: 'claude',
      isBusy: false,
      updatedAt: '2026-03-05T18:00:00.000Z',
      thread: {
        topic: 'Implement feature',
        lastActivityAt: '2026-03-05T18:00:00.000Z'
      }
    },
    isActive: false,
    hasActivity: false,
    onSelect: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onTopicChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSessionItem', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T18:05:00.000Z'));
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows inferred provider metadata and relative time', () => {
    render(<ThreadsSessionItem {...buildProps()} />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('shows a responding status for busy sessions', () => {
    render(<ThreadsSessionItem {...buildProps({ session: { ...buildProps().session, isBusy: true } })} />);

    expect(screen.getByText('Responding')).toBeInTheDocument();
  });
});
