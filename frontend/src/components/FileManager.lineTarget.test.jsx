import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileManager } from './FileManager';
import { apiFetch, apiGet } from '../utils/api';
vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../utils/auth', async importOriginal => ({ ...await importOriginal(), getAccessToken: () => null }));

const target = { root: '/canonical/workspace', path: 'src/main.js', line: 3 };
const preview = { root: '/canonical/workspace', path: 'src/main.js', line: 3, totalLines: 4, lines: [{ line: 3, text: 'needle now', truncated: false }] };

describe('FileManager initial line target', () => {
  beforeEach(() => {
    apiGet.mockReset().mockImplementation(async url => ({ path: new URL(url, 'http://fixture.invalid').searchParams.get('path'), items: [] }));
    apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => preview });
  });

  it('opens the bounded preview for a cited file and line exactly once', async () => {
    const { rerender } = render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" initialLineTarget={target} onClose={() => {}} />);
    const region = await screen.findByRole('region', { name: 'Current file preview' });
    expect(region.querySelector('[aria-current="true"]')).toHaveTextContent('needle now');
    const params = new URL(apiFetch.mock.calls[0][0], 'http://fixture.invalid').searchParams;
    expect([params.get('sessionId'), params.get('root'), params.get('path'), params.get('line'), params.get('query')]).toEqual(['ss-owned', '/canonical/workspace', 'src/main.js', '3', '']);
    rerender(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" initialLineTarget={target} onClose={() => {}} />);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('shows the server error instead of a preview when the file is unavailable', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Project file is unavailable' }) });
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" initialLineTarget={target} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Project file is unavailable');
  });

  it('does nothing without a thread scope', async () => {
    render(<FileManager isOpen initialPath="/canonical/workspace" initialLineTarget={target} onClose={() => {}} />);
    await screen.findByText('Empty folder');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
