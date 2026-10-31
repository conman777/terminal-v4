import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampDrawerHeight, clampSplitRatio, drawerLayoutKey, readDrawerLayout, writeDrawerLayout } from '../utils/threadDrawerLayout';

const SAVE_DELAY_MS = 150;

export function useThreadDrawerLayout(threadId) {
  const key = useMemo(() => drawerLayoutKey(threadId), [threadId]);
  const [state, setState] = useState(() => ({ key, layout: readDrawerLayout(key) }));
  const pending = useRef(null);
  const layout = state.key === key ? state.layout : readDrawerLayout(key);

  useEffect(() => {
    if (state.key !== key) setState({ key, layout: readDrawerLayout(key) });
  }, [key, state.key]);

  const flush = useCallback(() => {
    if (!pending.current) return;
    window.clearTimeout(pending.current.timer);
    writeDrawerLayout(pending.current.key, pending.current.layout);
    pending.current = null;
  }, []);
  useEffect(() => flush, [flush, key]);

  const update = useCallback(change => {
    setState(current => {
      const base = current.key === key ? current.layout : readDrawerLayout(key);
      const next = { ...base, ...change(base) };
      window.clearTimeout(pending.current?.timer);
      pending.current = { key, layout: next, timer: window.setTimeout(flush, SAVE_DELAY_MS) };
      return { key, layout: next };
    });
  }, [flush, key]);

  return {
    layout,
    setSplit: useCallback(splitId => update(() => ({ splitId: splitId || null })), [update]),
    setDirection: useCallback(direction => update(() => ({ direction: direction === 'stacked' ? 'stacked' : 'side-by-side' })), [update]),
    setRatio: useCallback(ratio => update(() => ({ ratio: clampSplitRatio(ratio) })), [update]),
    setHeight: useCallback((height, maxHeight) => update(() => ({ height: clampDrawerHeight(height, maxHeight) })), [update]),
  };
}
