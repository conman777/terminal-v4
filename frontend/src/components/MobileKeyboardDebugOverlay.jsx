import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '../utils/api';

function roundRect(rect) {
  if (!rect) return null;
  return {
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
  };
}

function getRect(selector) {
  if (typeof document === 'undefined') return null;
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) return null;
  return roundRect(element.getBoundingClientRect());
}

function getRecordingSessionId() {
  if (typeof window === 'undefined') return 'unknown-session';
  try {
    const existingId = window.sessionStorage?.getItem('mobileKeyboardDebugSessionId');
    if (existingId) return existingId;
    const nextId = `mobile-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage?.setItem('mobileKeyboardDebugSessionId', nextId);
    return nextId;
  } catch {
    return 'mobile-debug-session';
  }
}

export function MobileKeyboardDebugOverlay({
  enabled = false,
  viewportHeight = 0,
  keybarOpen = false,
  keybarHeight = 0,
  mobileView = 'terminal',
  chatMode = false,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const [persistState, setPersistState] = useState('idle');
  const lastPersistedPayloadRef = useRef('');

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    let rafId = null;
    let timeoutId = null;

    const updateSnapshot = () => {
      const viewport = window.visualViewport;
      const activeElement = document.activeElement;
      const viewportMeta = document.querySelector('meta[name="viewport"]');
      const activeElementFontSize = activeElement instanceof HTMLElement
        ? window.getComputedStyle(activeElement).fontSize
        : null;
      setSnapshot({
        windowInnerHeight: Math.round(window.innerHeight || 0),
        windowOuterHeight: Math.round(window.outerHeight || 0),
        appViewportHeight: Math.round(viewportHeight || 0),
        visualViewportHeight: Math.round(viewport?.height || 0),
        visualViewportScale: typeof viewport?.scale === 'number' && Number.isFinite(viewport.scale)
          ? Number(viewport.scale.toFixed(3))
          : null,
        visualViewportOffsetTop: Math.round(viewport?.offsetTop || 0),
        visualViewportOffsetLeft: Math.round(viewport?.offsetLeft || 0),
        activeElement: activeElement
          ? `${activeElement.tagName.toLowerCase()}${activeElement.className ? `.${String(activeElement.className).trim().replace(/\s+/g, '.')}` : ''}`
          : 'none',
        activeElementFontSize,
        viewportMetaContent: viewportMeta?.getAttribute('content') || '',
        keybarOpen,
        keybarHeight: Math.round(keybarHeight || 0),
        mobileView,
        chatMode,
        layout: getRect('.layout.mobile'),
        header: getRect('.mobile-header'),
        keybar: getRect('.mobile-keybar.open'),
        composer: getRect('.mobile-status-bar'),
        terminalPane: getRect('.terminal-pane'),
        terminalChat: getRect('.terminal-chat'),
      });
    };

    const scheduleUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (timeoutId) clearTimeout(timeoutId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateSnapshot();
      });
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        updateSnapshot();
      }, 120);
    };

    scheduleUpdate();

    const viewport = window.visualViewport;
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);
    window.addEventListener('focusin', scheduleUpdate);
    window.addEventListener('focusout', scheduleUpdate);
    document.addEventListener('visibilitychange', scheduleUpdate);
    viewport?.addEventListener('resize', scheduleUpdate);
    viewport?.addEventListener('scroll', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
      window.removeEventListener('focusin', scheduleUpdate);
      window.removeEventListener('focusout', scheduleUpdate);
      document.removeEventListener('visibilitychange', scheduleUpdate);
      viewport?.removeEventListener('resize', scheduleUpdate);
      viewport?.removeEventListener('scroll', scheduleUpdate);
    };
  }, [chatMode, enabled, keybarHeight, keybarOpen, mobileView, viewportHeight]);

  const snapshotText = useMemo(() => {
    if (!snapshot) return 'Collecting mobile viewport metrics...';
    return JSON.stringify(snapshot, null, 2);
  }, [snapshot]);

  useEffect(() => {
    if (!enabled || !snapshot || typeof window === 'undefined') {
      return undefined;
    }

    const payload = {
      ...snapshot,
      clientRecordedAt: new Date().toISOString(),
      locationHref: window.location.href,
      windowInnerWidth: Math.round(window.innerWidth || 0),
      userAgent: navigator.userAgent,
      recordingSessionId: getRecordingSessionId(),
    };
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === lastPersistedPayloadRef.current) {
      return undefined;
    }

    let cancelled = false;
    setPersistState('saving');
    const timeoutId = window.setTimeout(async () => {
      try {
        await apiPost('/api/mobile-keyboard-debug', payload);
        if (cancelled) return;
        lastPersistedPayloadRef.current = serializedPayload;
        setPersistState('saved');
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to persist mobile keyboard debug snapshot:', error);
        setPersistState('error');
      }
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [enabled, snapshot]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(snapshotText);
    } catch (error) {
      console.error('Failed to copy mobile keyboard debug snapshot:', error);
    }
  };

  if (!enabled) return null;

  return (
    <div className="mobile-keyboard-debug" role="status" aria-live="polite">
      <div className="mobile-keyboard-debug-header">
        <button type="button" onClick={handleCopy}>Copy Debug</button>
        <span className={`mobile-keyboard-debug-indicator ${persistState}`}>
          {persistState === 'error' ? 'Log error' : persistState === 'saving' ? 'Saving...' : 'Live log on'}
        </span>
      </div>
      <style>{`
        .mobile-keyboard-debug {
          position: fixed;
          top: calc(var(--mobile-header-height, 0px) + 8px);
          right: max(8px, env(safe-area-inset-right, 0px));
          z-index: 2500;
          width: auto;
          max-width: calc(100vw - 16px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
          display: flex;
          flex-direction: column;
          gap: 0;
          padding: 0;
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg-base) 94%, transparent);
          border: 1px solid var(--border-default);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(10px);
          color: var(--text-primary);
          font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
          font-size: 9px;
          line-height: 1;
          pointer-events: auto;
        }

        .mobile-keyboard-debug-header {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }

        .mobile-keyboard-debug-header button {
          border: none;
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          color: inherit;
          font: inherit;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          padding: 5px 8px;
        }

        .mobile-keyboard-debug-indicator {
          border-radius: 999px;
          padding: 5px 8px;
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }

        .mobile-keyboard-debug-indicator.saved {
          color: #86efac;
        }

        .mobile-keyboard-debug-indicator.saving {
          color: #fde68a;
        }

        .mobile-keyboard-debug-indicator.error {
          color: #fca5a5;
        }
      `}</style>
    </div>
  );
}
