import { useState } from 'react';

export function MountOnFirstOpen({ isOpen, children }) {
  const [hasOpened, setHasOpened] = useState(isOpen);
  if (isOpen && !hasOpened) setHasOpened(true);
  return isOpen || hasOpened ? children : null;
}
