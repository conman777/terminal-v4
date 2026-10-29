import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { ProjectScripts } from './ProjectScripts';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const json = body => ({ ok: true, json: async () => body });

beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('ProjectScripts', () => {
  it('runs a saved script and saves new ones for the project', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, options) => options?.method === 'PUT' ? json(options.body) : json({ scripts: [{ name: 'Dev server', command: 'npm run dev' }] }));
    const onRun = vi.fn();
    render(<ProjectScripts cwd="/work" onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project scripts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Dev server' }));
    fireEvent.change(screen.getByLabelText('Script name'), { target: { value: 'Tests' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npm test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add script' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Tests' })).toBeInTheDocument());
    const saved = vi.mocked(apiFetch).mock.calls.find(([, options]) => options?.method === 'PUT');
    expect([onRun.mock.calls, saved[0], saved[1].body]).toEqual([
      [[{ name: 'Dev server', command: 'npm run dev' }]],
      '/api/workspace/scripts?path=%2Fwork',
      { scripts: [{ name: 'Dev server', command: 'npm run dev' }, { name: 'Tests', command: 'npm test' }] },
    ]);
  });
});
