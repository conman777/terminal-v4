import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from './DesktopConversationView';

const props = { turns: [], mode: 'structured', aiType: 'codex', sessionId: 'native-session', connectionState: 'online', isSendReady: true, showHeader: false, isStreaming: true };
const request = changes => ({ id: 'exact-broker-id', label: 'codex:native-session:exact-nonce', name: 'browser_tabs', arguments: {}, target: { url: 'https://example.test/review' }, ...changes });
const tool = changes => ({ toolName: 'terminal_v4_browser.browser_tabs', toolInput: {}, turnId: 'current-turn', toolCallId: 'tabs-call', ...changes });

describe('DesktopConversationView inline broker decisions', () => {
  it('shows the broker request in chat with a concise purpose, visible page and collapsed exact action', () => {
    const row = request();
    render(<DesktopConversationView {...props} browserApprovals={[row]} />);
    expect(screen.getByText('View open browser tabs?')).toBeVisible();
    expect(screen.getByText('Waiting for approval')).toBeVisible();
    expect(screen.getByText('Page: https://example.test/review', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText(/Waiting for the first visible message/)).not.toBeInTheDocument();
    expect(screen.getByText(row.label, { selector: 'code' })).not.toBeVisible();
    const details = screen.getByText('Details', { selector: 'summary' });
    fireEvent.click(details);
    expect(screen.getByText(row.label, { selector: 'code' })).toBeVisible();
    expect(screen.getByText(row.name, { selector: 'code' })).toBeVisible();
    expect(screen.getByText(row.id, { selector: 'code' })).toBeVisible();
    expect(screen.getByLabelText('Browser approval details').textContent).toBe('{}');
    expect(screen.getByLabelText('Browser approval target').textContent).toBe(JSON.stringify(row.target, null, 2));
  });

  it.each([true, false])('binds a boolean decision %s to exactly the displayed row ID', approved => {
    const onBrowserApprove = vi.fn();
    const rows = [request(), request({ id: 'second-request', name: 'browser_close', arguments: { tabId: 'second-tab' } })];
    render(<DesktopConversationView {...props} browserApprovals={rows} onBrowserApprove={onBrowserApprove} />);
    const groups = screen.getAllByRole('group', { name: 'Browser approval required' });
    fireEvent.click(within(groups[1]).getByRole('button', { name: approved ? 'Approve' : 'Reject', exact: true }));
    expect(onBrowserApprove.mock.calls).toEqual([['second-request', approved]]);
  });

  it.each(['isBrowserApproving', 'isApproving', 'isInterrupting', 'requiresCleanup'])('disables all broker row decisions while %s is active', gate => {
    const onBrowserApprove = vi.fn();
    render(<DesktopConversationView {...props} browserApprovals={[request(), request({ id: 'second-request' })]} onBrowserApprove={onBrowserApprove} {...{ [gate]: true }} />);
    for (const button of screen.getAllByRole('button', { name: /^(Approve|Reject)$/ })) { expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(onBrowserApprove).not.toHaveBeenCalled();
  });

  it('keeps requests visible in a read-only conversation with disabled buttons', () => {
    render(<DesktopConversationView {...props} browserApprovals={[request()]} />);
    expect(screen.getByText('View open browser tabs?')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
    expect(screen.getByText('Approval actions are unavailable in this view.')).toBeVisible();
  });

  it('preserves native approval controls and displays broker failures and retries separately', () => {
    const pendingApproval = { approvalId: 'native-command-id', toolName: 'Bash', description: 'Run the exact native command?', toolInput: { command: 'echo native' } };
    const onApprove = vi.fn(), onBrowserApprove = vi.fn();
    const { rerender } = render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} browserApprovals={[request()]} onBrowserApprove={onBrowserApprove} browserApprovalError="Broker decision was not accepted. Retry." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Broker decision was not accepted. Retry.');
    const native = screen.getByRole('group', { name: 'Approval required' });
    fireEvent.click(within(native).getByRole('button', { name: 'Approve', exact: true }));
    expect(onApprove).toHaveBeenCalledWith(true, pendingApproval);
    const broker = screen.getByRole('group', { name: 'Browser approval required' });
    fireEvent.click(within(broker).getByRole('button', { name: 'Reject', exact: true }));
    expect(onBrowserApprove).toHaveBeenCalledWith('exact-broker-id', false);
    rerender(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} browserApprovals={[request()]} onBrowserApprove={onBrowserApprove} isBrowserApproving />);
    expect(within(native).getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(screen.getByText('Submitting browser approval decision…')).toBeVisible();
  });

  it('matches normalized tool names and reordered arguments while retaining unrelated work and partial output', () => {
    const row = request({ name: 'browser_evaluate', arguments: { script: 'window.changed = true;', tabId: 'exact-tab' } });
    const calls = [
      tool({ toolName: 'mcp__terminal_v4_browser__browser_evaluate', toolInput: { tabId: 'exact-tab', script: 'window.changed = true;' }, result: 'Retained partial output' }),
      tool({ toolCallId: 'unrelated', toolName: 'browser_evaluate', toolInput: { script: 'window.parallel = true;', tabId: 'other-tab' } }),
      tool({ toolCallId: 'command', toolName: 'Bash', toolInput: { command: 'echo parallel' } }),
    ];
    const { container } = render(<DesktopConversationView {...props} browserApprovals={[row]} structuredToolCalls={calls} />);
    expect(screen.getByLabelText('Action arguments')).toHaveTextContent('window.changed = true;');
    expect(screen.getByLabelText('Partial tool output')).toHaveTextContent('Retained partial output');
    const running = [...container.querySelectorAll('.structured-tool-running-line')].map(element => element.textContent);
    expect(running).toEqual(['Running Run JavaScript in browser script: window.parallel = true; · tabId: other-tab…', 'Running Run command echo parallel…']);
  });

  it('uses broker tool-call and turn identity when available instead of matching parallel identical arguments', () => {
    const { container } = render(<DesktopConversationView {...props} browserApprovals={[request({ toolCallId: 'tabs-call', turnId: 'current-turn' })]} structuredToolCalls={[tool(), tool({ toolCallId: 'other-call' }), tool({ turnId: 'old-turn' })]} />);
    expect(container.querySelectorAll('.structured-tool-running-line')).toHaveLength(2);
  });

  it('keeps ambiguous identical tool calls running and does not suppress a different target', () => {
    const { container } = render(<DesktopConversationView {...props} browserApprovals={[request()]} structuredToolCalls={[tool(), tool({ toolCallId: 'parallel-call' }), tool({ toolCallId: 'other-target', toolInput: { tabId: 'other' } })]} />);
    expect(container.querySelectorAll('.structured-tool-running-line')).toHaveLength(3);
  });

  it('shows meaningful arguments and exact scripts without requiring the Details disclosure', () => {
    const row = request({ name: 'browser_evaluate', arguments: { script: 'document.body.textContent = "changed";\nwindow.confirmed = true;', tabId: 'selected-tab' } });
    render(<DesktopConversationView {...props} browserApprovals={[row]} />);
    expect(screen.getByText('Run JavaScript in browser?')).toBeVisible();
    const preview = screen.getByLabelText('Action arguments');
    expect(preview).toBeVisible(); expect(preview.textContent).toContain(row.arguments.script); expect(preview).toHaveTextContent('selected-tab');
    expect(screen.getByLabelText('Browser approval details')).not.toBeVisible();
  });

  it('does not render broker actions in terminal mode', () => {
    render(<DesktopConversationView {...props} mode="terminal" browserApprovals={[request()]} />);
    expect(screen.queryByRole('group', { name: 'Browser approval required' })).not.toBeInTheDocument();
  });
});
