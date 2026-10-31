import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../utils/api';
import { TurnChangesCard } from './TurnChangesCard';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));

const REPO = '/work/repo';
const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const changes = { from: FROM, to: TO, added: 5, removed: 2, files: [
  { path: 'src/app.js', status: 'M', added: 4, removed: 2 },
  { path: 'README.md', status: 'A', added: 1, removed: 0 },
] };

beforeEach(() => { vi.mocked(apiGet).mockReset(); });

describe('TurnChangesCard', () => {
  it('summarises the files a turn changed and lists them on Open diff', () => {
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    const card = screen.getByRole('region', { name: 'Files changed in this turn' });
    expect([card.querySelector('.turn-changes-title').textContent, screen.queryByRole('button', { name: /src\/app\.js/ })]).toEqual(['2 changed files+5−2', null]);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(screen.getAllByRole('button', { name: /^(src|README)/ }).map(button => button.textContent)).toEqual(['app.js+4−2', 'README.md+1−0']);
  });

  it('loads one file\'s patch between the turn snapshots', async () => {
    vi.mocked(apiGet).mockResolvedValue({ patch: '@@ -1 +1 @@\n-old\n+new\n' });
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.js/ }));
    const diff = await screen.findByLabelText('Diff for src/app.js');
    expect([...diff.querySelectorAll('.diff-text')].map(cell => cell.textContent)).toEqual(['old', 'new']);
    expect(vi.mocked(apiGet).mock.calls).toEqual([[`/api/workspace/git/diff?${new URLSearchParams({ path: REPO, mode: 'turn', from: FROM, to: TO, file: 'src/app.js' })}`, { signal: expect.any(AbortSignal) }]]);
  });

  it('uses the singular for one file', () => {
    render(<TurnChangesCard changes={{ ...changes, files: changes.files.slice(0, 1) }} workspacePath={REPO} />);
    expect(screen.getByText('1 changed file')).toBeTruthy();
  });

  it('groups paths by directory and can collapse and reopen them', () => {
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(screen.getByRole('button', { name: 'Collapse src' })).toHaveTextContent('+4−2');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse src' }));
    expect(screen.queryByRole('button', { name: /src\/app\.js/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand src' }));
    expect(screen.getByRole('button', { name: /src\/app\.js/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all folders' }));
    expect(screen.queryByRole('button', { name: /src\/app\.js/ })).toBeNull();
  });

  it('does not show an older file response in the newly selected file', async () => {
    let finishFirst;
    vi.mocked(apiGet)
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ patch: '@@ -1 +1 @@\n-readme old\n+readme new\n' });
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.js/ }));
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }));
    expect(await screen.findByText('readme new')).toBeTruthy();
    await act(async () => finishFirst({ patch: '@@ -1 +1 @@\n-app old\n+app new\n' }));
    expect(screen.getByText('readme new')).toBeTruthy();
    expect(screen.queryByText('app new')).toBeNull();
  });

  it('discards an outstanding diff when the turn snapshots change', async () => {
    let finish;
    vi.mocked(apiGet).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.js/ }));
    view.rerender(<TurnChangesCard changes={{ ...changes, to: 'c'.repeat(40) }} workspacePath={REPO} />);
    await act(async () => finish({ patch: '@@ -1 +1 @@\n-old\n+stale\n' }));
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
