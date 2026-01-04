import { useEffect } from 'react';

// Reference counter for nested modals
let lockCount = 0;

export function useBodyScrollLock(isLocked) {
  useEffect(() => {
    if (!isLocked) return;

    lockCount++;
    if (lockCount === 1) {
      document.body.style.overflow = 'hidden';
    }

    return () => {
      lockCount--;
      if (lockCount === 0) {
        document.body.style.overflow = '';
      }
    };
  }, [isLocked]);
}
