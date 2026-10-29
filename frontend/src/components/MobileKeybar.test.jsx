import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileKeybar } from './MobileKeybar';

const sendToSession = vi.fn();
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ sendToSession }) }));

describe('MobileKeybar', () => {
  beforeEach(() => sendToSession.mockReset());

  it('sends the named terminal key while retaining text entry focus on touch', () => {
    render(<><textarea aria-label="Terminal input" /><MobileKeybar sessionId="terminal-a" isOpen /></>);
    const input = screen.getByRole('textbox', { name: 'Terminal input' });
    input.focus();
    const interrupt = screen.getByRole('button', { name: 'Ctrl+C (Interrupt)' });
    expect(fireEvent.pointerDown(interrupt, { pointerType: 'touch' })).toBe(false);
    fireEvent.click(interrupt);
    expect(input).toHaveFocus();
    expect(sendToSession.mock.calls).toEqual([['terminal-a', '\x03']]);
  });

  it('makes the collapsed keyboard shortcuts inaccessible and inert', () => {
    const { container } = render(<MobileKeybar sessionId="terminal-a" isOpen={false} />);
    expect(container.querySelector('.mobile-keybar')).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Escape' })).not.toBeInTheDocument();
  });
});
