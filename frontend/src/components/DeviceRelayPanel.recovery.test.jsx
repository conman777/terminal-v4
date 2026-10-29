import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DeviceRelayPanel } from './DeviceRelayPanel';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

it('retries a failed identity/status read while preserving the pairing draft', async () => {
  apiFetch.mockRejectedValueOnce(new Error('Synthetic relay unavailable')).mockResolvedValueOnce({ ok: true, json: async () => ({ deviceId: 'synthetic-device', configured: false }) });
  render(<DeviceRelayPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic relay unavailable');
  fireEvent.change(screen.getByLabelText('Relay device name'), { target: { value: 'Retained synthetic name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh relay status' }));
  expect(await screen.findByText('synthetic-device')).toBeVisible();
  expect(screen.getByLabelText('Relay device name')).toHaveValue('Retained synthetic name');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(apiFetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});
