import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { GuestInvitationGate } from './GuestInvitationGate';
let mounts = 0;
vi.mock('./GuestWorkspace', async () => {
  const React = await import('react');
  return {
    hasGuestInvitation: () => window.location.hash.startsWith('#invite='),
    GuestWorkspace: () => { const [instance] = React.useState(() => ++mounts); return <div>Guest instance {instance}</div>; },
  };
});
afterEach(() => { history.replaceState(null, '', '/'); mounts = 0; });
function navigate(hash) { act(() => { history.replaceState(null, '', '/' + hash); window.dispatchEvent(new HashChangeEvent('hashchange')); }); }
describe('GuestInvitationGate', () => {
  it('opens an initial invitation without rendering the owner application', () => {
    history.replaceState(null, '', '/#invite=first.secret');
    render(<GuestInvitationGate><div>Owner application</div></GuestInvitationGate>);
    expect(screen.queryByText('Owner application')).not.toBeInTheDocument();
    expect(screen.getByText('Guest instance 1')).toBeInTheDocument();
  });
  it('enters guest mode on same-tab navigation and retains it when the exchange clears the fragment', () => {
    render(<GuestInvitationGate><div>Owner application</div></GuestInvitationGate>);
    expect(screen.getByText('Owner application')).toBeInTheDocument();
    navigate('#invite=first.secret');
    expect(screen.queryByText('Owner application')).not.toBeInTheDocument();
    navigate('');
    expect(screen.getByText('Guest instance 1')).toBeInTheDocument();
  });
  it('disposes the previous guest interface when a different invitation is opened', () => {
    history.replaceState(null, '', '/#invite=first.secret');
    render(<GuestInvitationGate><div>Owner application</div></GuestInvitationGate>);
    navigate('#invite=second.secret');
    expect(screen.getByText('Guest instance 2')).toBeInTheDocument();
    expect(screen.queryByText('Guest instance 1')).not.toBeInTheDocument();
  });
});
