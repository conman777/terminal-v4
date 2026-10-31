import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from './DesktopConversationView';

const props = { turns: [], mode: 'structured', aiType: 'codex', connectionState: 'online', isSendReady: true, showHeader: false, isStreaming: true };
const toolName = 'terminal_v4_browser.browser_tabs';
const approval = { approvalId: 'exact-approval', turnId: 'current-turn', toolCallId: 'tabs-call', toolName, toolInput: {}, description: 'Run MCP tool terminal_v4_browser.browser_tabs?' };
const tool = { turnId: 'current-turn', toolCallId: 'tabs-call', toolName, toolInput: {} };

describe('DesktopConversationView browser approvals', () => {
  it.each(['background_start', 'background_write', 'background_write_bytes', 'background_close_input'])('shows a readable, exact %s approval', toolName => {
    const description = 'Write interactive input\nCommand (escaped):\n"read value"\nExact text (escaped):\n"hello\\n"';
    const pendingApproval = { approvalId: 'input-approval', toolName, description, toolInput: { actionId: 'a'.repeat(64), text: 'hello\n' } };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={vi.fn()} allowApprovalForSession />);
    expect(screen.getByLabelText('Background action review').textContent).toBe(description);
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Allow for this session' })).not.toBeInTheDocument();
  });
  it('uses the private output review instead of ordinary or session-wide approval', () => {
    const onApprove = vi.fn();
    const pendingApproval = { approvalId: 'private-review', toolName: 'background_read_output', toolInput: { actionId: 'a'.repeat(64) } };
    const { rerender } = render(<DesktopConversationView {...props} sessionId="session-1" pendingApproval={pendingApproval} onApprove={onApprove} allowApprovalForSession />);
    expect(screen.getByRole('group', { name: 'Private output review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review output' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow for this session' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onApprove).toHaveBeenCalledWith(false, pendingApproval);
    rerender(<DesktopConversationView {...props} sessionId="session-1" pendingApproval={pendingApproval} onApprove={onApprove} privateReviewVisible={false} />);
    expect(screen.queryByRole('group', { name: 'Private output review' })).not.toBeInTheDocument();
  });

  it('shows a readable background investigation approval while retaining exact details', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const pendingApproval = {
      approvalId: 'delegation-approval', toolName: 'delegate_task_background', description: 'Verbose internal description',
      toolInput: { prompt: 'Inspect the project', workspace: '/tmp/fixture-project', provider: 'deepseek', model: 'deepseek-chat', permission: 'read_only_child', operation_id: 'internal-operation-id' },
    };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} />);
    expect(screen.getByText('Run a read-only background investigation?')).toBeVisible();
    expect(screen.getByText('Inspect the project')).toBeVisible();
    expect(screen.getByText('/tmp/fixture-project')).toBeVisible();
    expect(screen.getByText('deepseek · deepseek-chat')).toBeVisible();
    expect(screen.getByText(/If delivered, the result is held for review/)).toBeVisible();
    expect(screen.getByLabelText('Approval details')).not.toBeVisible();
    expect(screen.queryByText('Verbose internal description')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    expect(onApprove).toHaveBeenCalledWith(true, pendingApproval);
    await user.click(screen.getByText('More details'));
    expect(screen.getByLabelText('Approval details')).toHaveTextContent('internal-operation-id');
  });
  it('explains automatic delivery for a locally authorized investigation', () => {
    const pendingApproval = {
      approvalId: 'local-delegation', toolName: 'delegate_task_background',
      toolInput: { prompt: 'Inspect', workspace: '/tmp/fixture-project', provider: 'deepseek', model: 'deepseek-chat', permission: 'read_only_child', authorization: { generation: 1, expires_at_ms: 9999999999999, session_incarnation: 'fixture' } },
    };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={vi.fn()} />);
    expect(screen.getByText(/can run the result automatically while your authorization remains valid/)).toBeVisible();
    expect(screen.queryByText(/If delivered, the result is held for review/)).not.toBeInTheDocument();
  });
  it('explains conditional automatic delivery for a paired investigation', () => {
    const pendingApproval = {
      approvalId: 'paired-delegation', toolName: 'delegate_task_background',
      toolInput: { prompt: 'Inspect', workspace: '/tmp/fixture-project', provider: 'deepseek', model: 'deepseek-chat', permission: 'read_only_child', paired_authorization: { owner: 'owner' } },
    };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={vi.fn()} />);
    expect(screen.getByText(/can run the result automatically while your authorization remains valid/)).toBeVisible();
    expect(screen.queryByText(/If delivered, the result is held for review/)).not.toBeInTheDocument();
  });
  it('falls back to the exact approval for an unrecognized permission', () => {
    const pendingApproval = { toolName: 'delegate_task_background', description: 'Review the unknown permission', toolInput: { prompt: 'Inspect', permission: 'unknown' } };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={vi.fn()} />);
    expect(screen.getByText('Review the unknown permission')).toBeVisible();
    expect(screen.getByLabelText('Approval details')).toHaveTextContent('unknown');
    expect(screen.queryByText('Run a read-only background investigation?')).not.toBeInTheDocument();
  });
  it.each(['create_schedule', 'manage_schedule'])('keeps %s review readable while preserving exact details', name => {
    const prompt = 'Review the workspace. '.repeat(1000);
    const request = { approvalId: 'schedule-review', toolName: name, description: `Review schedule:\n${prompt}`, toolInput: { action: 'run', schedule: { prompt } } };
    render(<DesktopConversationView {...props} pendingApproval={request} onApprove={vi.fn()} />);
    const fullDescription = screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === `Review schedule:\n${prompt}`);
    expect(fullDescription).not.toBeVisible();
    expect(screen.getByLabelText('Approval details')).toHaveTextContent(prompt.trim());
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    fireEvent.click(screen.getByText('Full approval description'));
    expect(fullDescription).toBeVisible();
  });
  it.each([toolName, 'mcp__terminal_v4_browser__browser_tabs', 'browser_tabs'])('asks a readable question for %s and keeps exact request details collapsed', async name => {
    const user = userEvent.setup();
    const pendingApproval = { ...approval, toolName: name };
    const onApprove = vi.fn();
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} structuredToolCalls={[{ ...tool, toolName: name }]} onApprove={onApprove} />);
    expect(screen.getByText('View open browser tabs?')).toBeVisible();
    expect(screen.getByText('Waiting for approval')).toBeVisible();
    expect(screen.queryByText(/^Running/)).not.toBeInTheDocument();
    expect(screen.getByText(pendingApproval.description)).not.toBeVisible();
    expect(screen.getByLabelText('Approval details')).not.toBeVisible();
    const details = screen.getByText('Details', { selector: 'summary' });
    await user.click(details);
    expect(details.parentElement).toHaveAttribute('open');
    expect(screen.getByText(name, { selector: 'code' })).toBeVisible();
    if (name !== 'browser_tabs') expect(screen.getByText('terminal_v4_browser', { selector: 'code' })).toBeVisible();
    expect(screen.getByLabelText('Approval details').textContent).toBe('{}');
    expect(screen.getByText(pendingApproval.description)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Reject', exact: true }));
    expect(onApprove.mock.calls).toEqual([[true, pendingApproval], [false, pendingApproval]]);
  });

  it.each([
    ['browser_navigate', { url: 'https://example.test/review?change=42', tabId: 'review-tab' }, 'Navigate browser tab?', 'https://example.test/review?change=42'],
    ['browser_evaluate', { script: 'document.body.textContent = "changed";\nwindow.review = true;', tabId: 'review-tab' }, 'Run JavaScript in browser?', 'document.body.textContent = "changed";'],
    ['browser_type', { ref: 'element-7', text: '', clear: true }, 'Type in browser?', 'clear: true'],
    ['browser_select', { ref: 'element-8', value: 'publish' }, 'Select browser option?', 'value: publish'],
  ])('shows meaningful %s arguments before a decision', (name, toolInput, question, target) => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, toolName: name, toolInput }} />);
    expect(screen.getByText(question)).toBeVisible();
    const argumentsPreview = screen.getByLabelText('Action arguments');
    expect(argumentsPreview).toBeVisible();
    expect(argumentsPreview).toHaveTextContent(target);
    if (name === 'browser_type') expect(argumentsPreview).toHaveTextContent('text: ""');
    expect(screen.getByLabelText('Approval details').textContent).toBe(JSON.stringify(toolInput, null, 2));
  });

  it.each(['isApproving', 'isInterrupting', 'requiresCleanup'])('retains the exact approval with disabled decisions during %s', gate => {
    const onApprove = vi.fn();
    render(<DesktopConversationView {...props} pendingApproval={approval} onApprove={onApprove} {...{ [gate]: true }} />);
    expect(screen.getByText('View open browser tabs?')).toBeVisible();
    for (const name of ['Approve', 'Reject']) {
      const button = screen.getByRole('button', { name, exact: true });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('keeps read-only decisions disabled and explains their absence', () => {
    render(<DesktopConversationView {...props} pendingApproval={approval} />);
    expect(screen.getByText('Approval actions are unavailable in this view.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  });

  it('preserves approval errors and retry callbacks for the displayed request', () => {
    const onApprove = vi.fn();
    render(<DesktopConversationView {...props} pendingApproval={approval} onApprove={onApprove} actionError="Decision could not be confirmed. Retry." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Decision could not be confirmed. Retry.');
    fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    expect(onApprove).toHaveBeenCalledWith(true, approval);
  });

  it('requires inspection before acknowledging an uncertain decision and never offers a retry', () => {
    const onApprove = vi.fn(), onReviewApproval = vi.fn();
    const pendingApproval = { ...approval, decisionUncertain: true, approved: true };
    render(<DesktopConversationView {...props} isStreaming={false} pendingApproval={pendingApproval} onApprove={onApprove} onReviewApproval={onReviewApproval} />);
    expect(screen.getByText('The decision may have been delivered. Stop the session and inspect the action and its results before continuing.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject', exact: true })).not.toBeInTheDocument();
    const acknowledge = screen.getByRole('button', { name: 'Acknowledge review' });
    expect(acknowledge).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I inspected the action/i }));
    fireEvent.click(acknowledge);
    expect(onReviewApproval).toHaveBeenCalledWith(pendingApproval);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('requires stopping the session before acknowledging an uncertain decision', () => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, decisionUncertain: true, approved: true }} onReviewApproval={vi.fn()} />);
    expect(screen.getByText('Stop the session before acknowledging this review.')).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: /I inspected the action/i }));
    expect(screen.getByRole('button', { name: 'Acknowledge review' })).toBeDisabled();
  });

  it('explains when legacy approval review is unavailable', () => {
    render(<DesktopConversationView {...props} isStreaming={false} pendingApproval={{ ...approval, decisionUnconfirmed: true, reviewUnavailable: true }} onReviewApproval={vi.fn()} />);
    expect(screen.getByText(/cannot safely acknowledge/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Acknowledge review' })).not.toBeInTheDocument();
  });

  it('does not offer decision buttons when the response is lost before the started event', () => {
    const onReviewApproval = vi.fn(), pendingApproval = { ...approval, decisionUnconfirmed: true };
    render(<DesktopConversationView {...props} isStreaming={false} pendingApproval={pendingApproval} onApprove={vi.fn()} onReviewApproval={onReviewApproval} />);
    const notice = screen.getByRole('group', { name: 'Uncertain approval decision' });
    expect(notice).toHaveTextContent('The decision may have been delivered');
    expect(within(notice).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(notice).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('checkbox', { name: /I inspected the action/i }));
    fireEvent.click(within(notice).getByRole('button', { name: 'Acknowledge review' }));
    expect(onReviewApproval).toHaveBeenCalledWith(pendingApproval);
  });

  it('suppresses only the matching call and retains output and unrelated parallel tools', () => {
    const tools = [
      { ...tool, result: 'Retained partial output' },
      { ...tool, toolCallId: 'parallel-tabs' },
      { ...tool, turnId: 'previous-turn' },
      { toolCallId: 'parallel-command', toolName: 'Bash', toolInput: { command: 'echo parallel' } },
    ];
    const { container, rerender } = render(<DesktopConversationView {...props} pendingApproval={approval} structuredToolCalls={tools} />);
    expect(screen.getByLabelText('Partial tool output')).toHaveTextContent('Retained partial output');
    expect([...container.querySelectorAll('.structured-tool-running-line')].map(row => row.textContent)).toEqual([
      'Running View open browser tabs…', 'Running View open browser tabs…', 'Running Run command echo parallel…',
    ]);
    rerender(<DesktopConversationView {...props} pendingApproval={null} structuredToolCalls={tools} />);
    expect(container.querySelectorAll('.structured-tool-running-line')).toHaveLength(4);
  });

  it.each([
    [{ requestId: 'request-a' }, { requestId: 'request-b' }],
    [{ approvalId: 'approval-a' }, { approvalId: 'approval-b' }],
    [{ turnId: 'turn-a' }, { turnId: 'turn-b' }],
  ])('does not match conflicting request, approval, or turn identities: %j', (approvalIdentity, toolIdentity) => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, ...approvalIdentity }} structuredToolCalls={[{ ...tool, ...toolIdentity }]} />);
    expect(screen.getByText(/^Running/)).toHaveTextContent('View open browser tabs');
  });

  it('uses a unique same-turn name and argument match when a provider omits toolCallId', () => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, toolCallId: undefined }} structuredToolCalls={[tool, { ...tool, toolCallId: 'other-target', toolInput: { tabId: 'other-tab' } }]} />);
    expect(screen.getAllByText(/^Running/)).toHaveLength(1);
    expect(screen.getByText('tabId: other-tab')).toBeVisible();
  });

  it('keeps ambiguous identical calls visible instead of hiding parallel work', () => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, toolCallId: undefined }} structuredToolCalls={[tool, { ...tool, toolCallId: 'parallel-call' }]} />);
    expect(screen.getAllByText(/^Running/)).toHaveLength(2);
  });

  it('prefers an exact tool-call identity over a parallel call with missing IDs', () => {
    render(<DesktopConversationView {...props} pendingApproval={approval} structuredToolCalls={[tool, { ...tool, toolCallId: undefined }]} />);
    expect(screen.getAllByText(/^Running/)).toHaveLength(1);
  });

  it.each(['unknown_tool', 'other_browser.browser_tabs', 'terminal_v4_browser.browser_future'])('keeps the default nonmapped approval description for %s', name => {
    render(<DesktopConversationView {...props} pendingApproval={{ ...approval, toolName: name, description: 'Exact custom approval description', toolInput: { command: 'echo exact action' } }} />);
    expect(screen.getByText('Exact custom approval description')).toBeVisible();
    expect(screen.getByLabelText('Approval details')).toBeVisible();
    expect(screen.getByLabelText('Approval details')).toHaveTextContent('echo exact action');
  });

  it('preserves browser labels and exact tool identity in standalone and grouped history', async () => {
    render(<DesktopConversationView {...props} isStreaming={false} structuredMessages={[
      { role: 'tool', toolCallId: 'history-tabs', toolName, toolInput: {}, result: 'Tab list' },
      { role: 'assistant', messageId: 'separator', content: 'Reviewing the selected page.' },
      { role: 'tool', toolCallId: 'history-nav', toolName: 'mcp__terminal_v4_browser__browser_navigate', toolInput: { url: 'https://example.test/target' }, result: 'Navigated' },
      { role: 'tool', toolCallId: 'history-script', toolName: 'browser_evaluate', toolInput: { script: 'window.exact = true;' }, result: 'Changed' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /View open browser tabs.*Completed/ }));
    expect(screen.getByText(toolName, { selector: 'code' })).toBeVisible();
    fireEvent.click(screen.getByText('2 tool calls').closest('summary'));
    const navigate = await screen.findByRole('button', { name: /Navigate browser tab/ });
    expect(navigate).toHaveTextContent('https://example.test/target');
    fireEvent.click(navigate);
    expect(screen.getByText('mcp__terminal_v4_browser__browser_navigate', { selector: 'code' })).toBeVisible();
    expect(within(navigate.parentElement).getByLabelText('Arguments')).toHaveTextContent('https://example.test/target');
    const evaluate = screen.getByRole('button', { name: /Run JavaScript in browser/ });
    fireEvent.click(evaluate);
    expect(screen.getByText('browser_evaluate', { selector: 'code' })).toBeVisible();
    expect(within(evaluate.parentElement).getByLabelText('Arguments')).toHaveTextContent('window.exact = true;');
  });
});
