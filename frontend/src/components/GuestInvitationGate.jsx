import { useEffect, useState } from 'react';
import { GuestWorkspace, hasGuestInvitation } from './GuestWorkspace';
import { GuestConversation, hasGuestShare } from './GuestConversation';

const entry = () => hasGuestInvitation() ? { kind: 'terminal', key: window.location.hash }
  : hasGuestShare() ? { kind: 'conversation', key: window.location.hash } : null;

export function GuestInvitationGate({ children }) {
  const [guest, setGuest] = useState(entry);
  useEffect(() => {
    const open = () => { const next = entry(); if (next) setGuest(next); };
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  if (!guest) return children;
  return guest.kind === 'conversation' ? <GuestConversation key={guest.key} /> : <GuestWorkspace key={guest.key} />;
}
