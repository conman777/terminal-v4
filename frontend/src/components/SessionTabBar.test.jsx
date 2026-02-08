import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionTabBar } from './SessionTabBar';

function renderTabBar({ sessions, sessionActivity = {} }) {
  return render(
    <SessionTabBar
      sessions={sessions}
      activeSessionId={sessions[0]?.id || null}
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

  it('prefers local session activity state over snapshot busy flag', () => {
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
          hasUnread: false,
          isDone: false
        }
      }
    });
    expect(container.querySelector('.session-tab-item')).toHaveClass('busy');
  });
});
