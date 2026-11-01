import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';

const panel = vi.hoisted(() => ({ unavailable: false }));
vi.mock('./FolderBrowserModal', () => ({ FolderBrowserModal: () => null }));
vi.mock('./DeliveryChannelsPanel', () => ({
  DeliveryChannelsPanel: ({ onUnavailable }) => {
    useEffect(() => { if (panel.unavailable) onUnavailable(); }, [onUnavailable]);
    return panel.unavailable ? null : <div>Delivery test panel</div>;
  },
}));
vi.mock('../utils/auth', () => ({ getAccessToken: () => null }));

const props = { isOpen: true, onClose: vi.fn(), sessionId: 's', currentCwd: '/w', recentFolders: [], onSave: vi.fn(), onAddRecentFolder: vi.fn(), onFontSizeChange: vi.fn(), onWebglChange: vi.fn(), onDesktopTerminalInputChange: vi.fn(), onOpenProcessManager: vi.fn(), onTabStatusLabelsChange: vi.fn() };

describe('SettingsModal delivery channels section', () => {
  it('opens the delivery panel from the section nav', () => {
    panel.unavailable = false;
    render(<SettingsModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delivery channels' }));
    expect(screen.getByText('Delivery test panel')).toBeVisible();
  });

  it('removes the nav entry and returns to Workspace when the server lacks the route', async () => {
    panel.unavailable = true;
    render(<SettingsModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delivery channels' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delivery channels' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
  });
});
