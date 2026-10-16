import { useEffect, useState } from 'react';
import { GuestWorkspace, hasGuestInvitation } from './GuestWorkspace';

export function GuestInvitationGate({ children }) {
  const [invitationKey, setInvitationKey] = useState(() => hasGuestInvitation() ? window.location.hash : null);
  useEffect(() => {
    const openInvitation = () => { if (hasGuestInvitation()) setInvitationKey(window.location.hash); };
    window.addEventListener('hashchange', openInvitation);
    return () => window.removeEventListener('hashchange', openInvitation);
  }, []);
  return invitationKey ? <GuestWorkspace key={invitationKey} /> : children;
}
