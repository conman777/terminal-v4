import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from '../DesktopConversationView';

const props = { turns: [], mode: 'structured', aiType: 'codex', connectionState: 'online', isSendReady: true, showHeader: false, isStreaming: true };

describe('pending question and approval keyboard handling', () => {
  it('answers a pending question with number keys but still needs Send answers', () => {
    const onApprove = vi.fn();
    const pendingApproval = { approvalId: 'q', toolName: 'ask_user', toolInput: { questions: [
      { id: 'a', question: 'Pick', options: [{ label: 'One' }, { label: 'Two' }] }, { id: 'b', question: 'Then', options: [{ label: 'X' }] }] } };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} />);
    expect(screen.getByLabelText('Question 2 of 2')).toHaveTextContent('2/2');
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: '1' });
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onApprove.mock.calls).toEqual([[true, pendingApproval, { a: ['Two'], b: ['X'] }]]);
  });

  it('dismisses a question explicitly', () => {
    const onApprove = vi.fn();
    const pendingApproval = { approvalId: 'q', toolName: 'ask_user', toolInput: { questions: [{ id: 'a', question: 'Pick', options: [{ label: 'One' }] }] } };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
    expect(onApprove.mock.calls).toEqual([[false, pendingApproval]]);
  });

  it('does not approve or reject a tool from Enter, Space or digit keys', () => {
    const onApprove = vi.fn();
    const pendingApproval = { approvalId: 'run', toolName: 'run_shell', toolInput: { command: 'ls' }, description: 'Run ls?' };
    render(<DesktopConversationView {...props} pendingApproval={pendingApproval} onApprove={onApprove} />);
    for (const key of ['Enter', ' ', '1', '2', 'y']) { fireEvent.keyDown(document.body, { key }); fireEvent.keyDown(document.activeElement, { key }); }
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    expect(onApprove.mock.calls).toEqual([[true, pendingApproval]]);
  });
});
