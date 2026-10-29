import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentBrowserSettingsPanel } from './AgentBrowserSettingsPanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const config = { enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] };
beforeEach(() => { apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => config }); });

it('puts saving before the origin editor and keeps policy and standalone options in accessible disclosures', async () => {
  render(<AgentBrowserSettingsPanel />);
  const save = await screen.findByRole('button', { name: 'Save browser settings' });
  const origins = screen.getByLabelText('Allowed origins');
  expect(save.compareDocumentPosition(origins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const policy = screen.getByText('Browser access and save behavior', { selector: 'summary' }).closest('details');
  expect(policy).not.toHaveAttribute('open');
  expect(within(policy).getByText(/email access requires separate consent and the exact account address/i)).not.toBeVisible();
  fireEvent.click(within(policy).getByText('Browser access and save behavior'));
  expect(within(policy).getByText(/email access requires separate consent and the exact account address/i)).toBeVisible();
  const advanced = screen.getByText('Advanced browser options', { selector: 'summary' }).closest('details');
  expect(advanced).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Browser executable path')).not.toBeVisible();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
