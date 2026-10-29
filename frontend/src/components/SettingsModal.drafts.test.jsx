import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
vi.mock('./McpSettingsPanel', () => ({ McpSettingsPanel: () => null }));
vi.mock('./AccountKnowledgePanel', () => ({ AccountKnowledgePanel: () => null }));
vi.mock('./ProviderConnectionsPanel', () => ({ ProviderConnectionsPanel: () => null }));
vi.mock('./FolderBrowserModal', () => ({ FolderBrowserModal: () => null }));

it('loads browser settings only when visited and preserves their unsaved draft across section navigation', async () => {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] }) });
  render(<SettingsModal isOpen onClose={vi.fn()} recentFolders={[]} terminalFontSize={14} />);
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Agent browser', exact: true }));
  fireEvent.change(await screen.findByLabelText('Allowed origins'), { target: { value: 'https://synthetic.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Terminal', exact: true }));
  expect(screen.getByLabelText('Allowed origins')).not.toBeVisible();
  expect(screen.getByText(/Unsaved changes in Agent browser/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Agent browser', exact: true }));
  expect(await screen.findByLabelText('Allowed origins')).toHaveValue('https://synthetic.test');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
