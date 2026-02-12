import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionTabBar } from './SessionTabBar';

function renderTabBar({ sessions, sessionActivity = {}, activeSessionId = sessions[0]?.id || null }) {
  return render(
    <SessionTabBar
      sessions={sessions}
      activeSessionId={activeSessionId}
      sessionActivity={sessionActivity}
      onSelectSession={vi.fn()}
      onCreateSession={vi.fn()}
      onCloseSession={vi.fn()}
      onRenameSession={vi.fn()}
      onReorderSessions={vi.fn()}
    />
  );
}

describe('SessionTabBar', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterAll(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('uses backend busy state when local activity is not yet available', () => {
    const sessions = [
      {
        id: 'session-1',
        title: 'Terminal 1',
        isBusy: true,
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      }
    ];
    const { container } = renderTabBar({ sessions });
    expect(container.querySelector('.session-tab-item')).toHaveClass('busy');
  });

  it('uses backend snapshot busy state over stale local activity', () => {
    const sessions = [
      {
        id: 'session-1',
        title: 'Terminal 1',
        isBusy: false,
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      }
    ];
    const { container } = renderTabBar({
      sessions,
      sessionActivity: {
        'session-1': {
          isBusy: true,
          hasUnread: false
        }
      }
    });
    expect(container.querySelector('.session-tab-item')).not.toHaveClass('busy');
  });

  it('does not show inactive sessions as busy', () => {
    const sessions = [
      {
        id: 'session-1',
        title: 'Terminal 1',
        isBusy: false,
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      },
      {
        id: 'session-2',
        title: 'Terminal 2',
        isBusy: true,
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      }
    ];

    const { container } = renderTabBar({
      sessions,
      activeSessionId: 'session-1'
    });

    const tabs = container.querySelectorAll('.session-tab-item');
    expect(tabs[0]).not.toHaveClass('busy');
    expect(tabs[1]).not.toHaveClass('busy');
  });

  it('shows only idle status dots when no session is busy', () => {
    const sessions = [
      { id: 'session-1', title: 'Terminal 1', isBusy: false },
      { id: 'session-2', title: 'Terminal 2', isBusy: false }
    ];
    const { container } = renderTabBar({ sessions });
    const dots = container.querySelectorAll('.tab-status-dot-modern');
    dots.forEach(dot => {
      expect(dot).toHaveClass('idle');
      expect(dot).not.toHaveClass('busy');
    });
  });
});
