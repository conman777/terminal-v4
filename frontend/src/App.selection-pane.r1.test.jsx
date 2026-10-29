import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

// Proposed target: frontend/src/App.selection-pane.r1.test.jsx.
// Public Profiler reads committed DOM. No provider, hook or pane effect is mocked.
function rowFor(host, topic) {
  return [...host.querySelectorAll('.threads-session-item')].find(row =>
    row.querySelector('.threads-session-topic')?.textContent === topic);
}
function committedDom(host, phase) {
  const composers = [...host.querySelectorAll('textarea.status-composer-input[aria-label="Command composer"]')];
  const input = composers[0];
  let visible = Boolean(input && host.contains(input));
  for (let node = input; visible && node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
      || style.visibility === 'hidden' || style.visibility === 'collapse') visible = false;
    if (node === host) break;
  }
  return {
    phase,
    selected: [...host.querySelectorAll('.threads-session-item.active .threads-session-topic')].map(node => node.textContent),
    paneCount: host.querySelectorAll('.split-terminal-pane').length,
    composerCount: composers.length,
    draft: input?.value ?? null,
    editable: Boolean(visible && !input.disabled && !input.readOnly),
  };
}

describe('real App single-pane selection and editable draft coherence', () => {
  let fixture, host;
  beforeEach(() => {
    fixture = installSelectionPaneR1Fixture();
    host = document.createElement('div'); document.body.appendChild(host);
  });
  afterEach(() => {
    cleanup(); host?.remove(); fixture?.restore();
  });

  it('R1 keeps each committed same-provider sidebar selection coherent with its editable composer, and retains both drafts without sending', async () => {
    const commits = [];
    let recordCommits = false;
    render(<Profiler id="selection-pane-r1-real-app" onRender={(_id, phase) => {
      if (recordCommits) commits.push(committedDom(host, phase));
    }}><App /></Profiler>, { container: host });

    // Exercise the actual login page and AuthProvider against declared API I/O.
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));

    // A curated empty group can mount before inventory and retain its real collapsed state.
    // Expand it through the public UI before the session-handoff oracle is armed.
    await waitFor(() => expect(host.querySelector('.threads-card')).toBeInTheDocument());

    await waitFor(() => {
      expect(rowFor(host, R1.a.topic), JSON.stringify({ topics: [...host.querySelectorAll('.threads-session-topic')].map(node => node.textContent), composers: [...host.querySelectorAll('.status-composer-input')].map(node => node.value), calls: fixture.fetchCalls.map(call => [call.method, call.path]), unexpected: fixture.unexpected })).toHaveClass('active');
      expect(rowFor(host, R1.b.topic)).not.toHaveClass('active');
      const input = screen.getByRole('textbox', { name: 'Command composer' });
      expect(input).toBeVisible(); expect(input).toBeEnabled(); expect(input).toHaveValue(R1.a.text);
      expect(host.querySelectorAll('.split-terminal-pane')).toHaveLength(1);
      expect(host.querySelectorAll('textarea.status-composer-input')).toHaveLength(1);
    }, { onTimeout: error => new Error('R1_SETUP_DIAGNOSTICS ' + JSON.stringify({ sidebar: host.querySelector('.pro-sidebar-panel')?.innerHTML.slice(-12000), topics: [...host.querySelectorAll('.threads-session-topic')].map(node => node.textContent), composers: [...host.querySelectorAll('.status-composer-input')].map(node => node.value), calls: fixture.fetchCalls.map(call => [call.method, call.path]), unexpected: fixture.unexpected }) + '\n' + error.message) });
    expect(fixture.unexpected).toEqual([]);

    recordCommits = true;
    // One actual sidebar click. Its handler and all passive/layout effects are real.
    fireEvent.click(rowFor(host, R1.b.topic));
    await waitFor(() => {
      expect(rowFor(host, R1.b.topic)).toHaveClass('active');
      expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text);
    });
    recordCommits = false;

    const bCommits = commits.filter(commit => commit.selected.includes(R1.b.topic));
    expect(bCommits.length, 'The public Profiler must observe the selected-B transition').toBeGreaterThan(0);
    expect(bCommits.every(commit => commit.selected.length === 1), JSON.stringify(commits)).toBe(true);
    expect(bCommits.every(commit => commit.paneCount === 1 && commit.composerCount === 1), JSON.stringify(commits)).toBe(true);
    expect(bCommits.filter(commit => commit.editable && commit.draft !== R1.b.text),
      'A committed selected-B row must not expose an editable old/blank draft: ' + JSON.stringify(commits)).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBeEnabled();

    // This is deliberately after the coherence oracle: if RED, record these as
    // not reached rather than crediting draft retention or no-send completion.
    fireEvent.click(rowFor(host, R1.a.topic));
    await waitFor(() => {
      expect(rowFor(host, R1.a.topic)).toHaveClass('active');
      expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text);
    });
    fireEvent.click(rowFor(host, R1.b.topic));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text));
    expect(fixture.sendCalls()).toEqual([]);
    expect(fixture.socketWrites).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});
