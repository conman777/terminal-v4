import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentNotificationSetting } from './AgentNotificationSetting';
import { agentNotificationsEnabled } from '../utils/agentNotifications';

afterEach(() => { delete globalThis.Notification; localStorage.clear(); });

describe('AgentNotificationSetting', () => {
  it('asks the browser for permission before turning notifications on', async () => {
    globalThis.Notification = { permission: 'default', requestPermission: async () => 'granted' };
    render(<AgentNotificationSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'On' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(agentNotificationsEnabled()).toBe(false);
  });

  it('explains when the browser blocks notifications', async () => {
    globalThis.Notification = { permission: 'denied', requestPermission: async () => 'denied' };
    render(<AgentNotificationSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'On' }));
    expect(await screen.findByText('Notifications are blocked for this site in your browser settings.')).toBeInTheDocument();
  });
});
