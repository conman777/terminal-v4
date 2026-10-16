import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import RemoteHostPanel from './RemoteHostPanel';

describe('RemoteHostPanel', () => {
  it('generates literal setup commands and explains authenticated logon scope', () => {
    render(<RemoteHostPanel />);
    fireEvent.change(screen.getByLabelText('Repository path'), { target: { value: "C:\\coding projects\\terminal's app" } });
    fireEvent.change(screen.getByLabelText('API executable path'), { target: { value: 'C:\\apps\\terminal-v4-api.exe' } });
    expect(screen.getByTestId('host-commands').textContent).toContain("terminal''s app");
    expect(screen.getByTestId('host-commands').textContent).toContain('-Action Initialize');
    expect(screen.getByTestId('host-commands').textContent).toContain('-Action Install');
    expect(screen.getByText(/after you sign in to Windows/i)).toBeInTheDocument();
    expect(screen.getByText(/existing login and pairing permissions/i)).toBeInTheDocument();
  });
  it('requires explicit LAN consent and rejects newlines in paths', () => {
    render(<RemoteHostPanel />);
    fireEvent.click(screen.getByLabelText('Listen on my local network'));
    expect(screen.getByTestId('host-commands').textContent).toContain('-AllowLan');
    fireEvent.change(screen.getByLabelText('Repository path'), { target: { value: 'bad"path' } });
    expect(screen.getByRole('alert').textContent).toContain('valid absolute Windows paths');
    expect(screen.queryByTestId('host-commands')).toBeNull();
  });
});
