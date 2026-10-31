import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StructuredActivityGroup, summarizeActivity } from './StructuredActivityGroup';
import userEvent from '@testing-library/user-event';

describe('StructuredActivityGroup', () => {
  it('passes workspace file navigation to grouped tool results', async () => {
    const open = vi.fn();
    render(<StructuredActivityGroup workspacePath="/work/project" onProjectFileClick={open} messages={[
      { toolCallId: 'one', toolName: 'Bash', toolInput: { command: 'check' }, result: 'src/app.js:2:3' },
    ]} />);
    fireEvent.click(screen.getByText('Ran 1 command').closest('summary'));
    fireEvent.click(await screen.findByRole('button', { name: /Run command.*check/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.js:2:3 at line 2' }));
    expect(open).toHaveBeenCalledWith({ path: 'src/app.js', line: 2 });
  });

  it('does not leave an empty disclosure when there is no activity', () => {
    const { container } = render(<StructuredActivityGroup messages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps expanded tool controls keyboard accessible and preserves a result with no textual output', async () => {
    const user = userEvent.setup();
    render(<StructuredActivityGroup messages={[{ messageId: 'empty-read', toolName: 'read', toolInput: { path: '/work/empty.txt' }, result: '' }]} />);
    const summary = screen.getByText('Read 1 file').closest('summary');
    fireEvent.click(summary);
    const tool = await screen.findByRole('button', { name: /Read.*empty.txt.*Completed/ });
    summary.focus();
    await user.tab();
    expect(tool).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByText('No output', { selector: '.cc-tool-empty-output' })).toBeVisible();
  });
  it('keeps completed command output collapsed while exposing failures and full details on demand', async () => {
    render(<StructuredActivityGroup messages={[
      { toolCallId: 'read', toolName: 'run_command', toolInput: { command: 'cat README.md' }, result: 'Project overview' },
      { toolCallId: 'test', toolName: 'run_command', toolInput: { command: 'npm test' }, result: 'Test failure details', isError: true },
    ]} />);
    const toggle = screen.getByText('Read 1 file, ran 1 command').closest('summary');
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.queryByText('Test failure details')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByRole('button', { name: /Run tests.*Failed/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Run tests.*Failed/ }));
    expect(screen.getByText('Test failure details')).toBeVisible();
  });
});

describe('summarizeActivity', () => {
  it.each([
    [['/bin/zsh -lc "sed -n \'1,80p\' a.md"', '/bin/zsh -lc "rg -n useState src"', 'git status --short && cat b.md'], 'Read 1 file, 1 search, ran 1 command'],
    [['cat a.md b.md', 'ls src'], 'Read 2 files, listed files'],
  ])('describes %j as %s', (commands, expected) => {
    const messages = commands.map(command => ({ toolName: 'run_command', toolInput: { command } }));
    expect(summarizeActivity(messages)).toBe(expected);
  });
});
