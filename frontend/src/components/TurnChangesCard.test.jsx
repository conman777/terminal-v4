import { fireEvent, render, screen } from '@testing-library/react';
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

beforeEach(() => vi.mocked(apiGet).mockReset());

describe('TurnChangesCard', () => {
  it('summarises the files a turn changed and lists them on Open diff', () => {
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    const card = screen.getByRole('region', { name: 'Files changed in this turn' });
    expect([card.querySelector('.turn-changes-title').textContent, screen.queryByRole('button', { name: /src\/app\.js/ })]).toEqual(['2 changed files+5−2', null]);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(screen.getAllByRole('button', { name: /^(src|README)/ }).map(button => button.textContent)).toEqual(['src/app.js+4−2', 'README.md+1−0']);
  });

  it('loads one file\'s patch between the turn snapshots', async () => {
    vi.mocked(apiGet).mockResolvedValue({ patch: '@@ -1 +1 @@\n-old\n+new\n' });
    render(<TurnChangesCard changes={changes} workspacePath={REPO} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.js/ }));
    const diff = await screen.findByLabelText('Diff for src/app.js');
    expect([...diff.querySelectorAll('.diff-text')].map(cell => cell.textContent)).toEqual(['old', 'new']);
    expect(vi.mocked(apiGet).mock.calls).toEqual([[`/api/workspace/git/diff?${new URLSearchParams({ path: REPO, mode: 'turn', from: FROM, to: TO, file: 'src/app.js' })}`]]);
  });

  it('uses the singular for one file', () => {
    render(<TurnChangesCard changes={{ ...changes, files: changes.files.slice(0, 1) }} workspacePath={REPO} />);
    expect(screen.getByText('1 changed file')).toBeTruthy();
  });
});
