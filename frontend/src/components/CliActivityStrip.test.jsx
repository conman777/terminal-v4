import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CliActivityStrip } from './CliActivityStrip';

describe('CliActivityStrip', () => {
  it('renders prompt options from canonical prompt events and sends raw payloads', () => {
    const onSendRaw = vi.fn();

    render(
      <CliActivityStrip
        interactivePromptEvent={{
          type: 'prompt_required',
          prompt: 'Update available! 0.110.0 -> 0.111.0',
          actions: ['enter'],
          options: [
            { label: '1. Update now', payload: '\r', kind: 'primary' },
            { label: '2. Skip', payload: '\u001b[B\r', kind: 'secondary' }
          ]
        }}
        terminalScreenSnapshot=""
        onSendRaw={onSendRaw}
      />
    );

    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1. Update now' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Latest assistant update')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2. Skip' }));

    expect(onSendRaw).toHaveBeenCalledWith('\u001b[B\r');
  });

  it('does not render a status card when no useful prompt or status exists', () => {
    render(
      <CliActivityStrip
        interactivePromptEvent={null}
        terminalScreenSnapshot=""
        notice=""
      />
    );

    expect(screen.queryByLabelText('Session status')).not.toBeInTheDocument();
  });
});
