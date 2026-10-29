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

  it('edits a script in place, keeping order and its neighbours', async () => {
    const scripts = [{ name: 'Dev', command: 'npm run dev' }, { name: 'Tests', command: 'npm test' }];
    vi.mocked(apiFetch).mockImplementation(async (url, options) => options?.method === 'PUT' ? json(options.body) : json({ scripts }));
    render(<ProjectScripts cwd="/work" />);
    fireEvent.click(screen.getByRole('button', { name: 'Project scripts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Dev' }));
    expect([screen.getByLabelText('Script name').value, screen.getByLabelText('Command').value]).toEqual(['Dev', 'npm run dev']);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npm run dev -- --port 3041' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add script' })).toBeInTheDocument());
    const saved = vi.mocked(apiFetch).mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(saved[1].body).toEqual({ scripts: [{ name: 'Dev', command: 'npm run dev -- --port 3041' }, scripts[1]] });
  });

  it('keeps the edit open and shows the error when saving fails, and cancel discards it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, options) => options?.method === 'PUT'
      ? { ok: false, json: async () => ({ error: 'Scripts are read-only' }) }
      : json({ scripts: [{ name: 'Dev', command: 'npm run dev' }] }));
    render(<ProjectScripts cwd="/work" />);
    fireEvent.click(screen.getByRole('button', { name: 'Project scripts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Dev' }));
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Scripts are read-only');
    expect(screen.getByLabelText('Command').value).toBe('x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect([screen.getByLabelText('Command').value, screen.queryByRole('alert')]).toEqual(['', null]);
  });
});
