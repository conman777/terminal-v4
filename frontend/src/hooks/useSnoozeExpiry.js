import { useEffect, useState } from 'react';
import { nextSnoozeExpiryAt } from '../utils/snoozeChoices';

const MAX_TIMER_MS = 2147483647;

export function useSnoozeExpiry(sessions) {
  const [tick, setTick] = useState(0);
  const expiresAt = nextSnoozeExpiryAt(sessions);
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(Math.max(0, expiresAt - Date.now()) + 25, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [expiresAt, tick]);
  return tick;
}
