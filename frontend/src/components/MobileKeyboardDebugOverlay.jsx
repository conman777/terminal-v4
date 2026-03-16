import { useEffect, useMemo, useState } from 'react';

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

export function MobileKeyboardDebugOverlay({
  enabled = false,
  viewportHeight = 0,
  keybarOpen = false,
  keybarHeight = 0,
  mobileView = 'terminal',
  chatMode = false,
}) {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    let rafId = null;
    let timeoutId = null;

    const updateSnapshot = () => {
      const viewport = window.visualViewport;
      const activeElement = document.activeElement;
      setSnapshot({
        windowInnerHeight: Math.round(window.innerHeight || 0),
        windowOuterHeight: Math.round(window.outerHeight || 0),
        appViewportHeight: Math.round(viewportHeight || 0),
        visualViewportHeight: Math.round(viewport?.height || 0),
        visualViewportOffsetTop: Math.round(viewport?.offsetTop || 0),
        visualViewportOffsetLeft: Math.round(viewport?.offsetLeft || 0),
        activeElement: activeElement
          ? `${activeElement.tagName.toLowerCase()}${activeElement.className ? `.${String(activeElement.className).trim().replace(/\s+/g, '.')}` : ''}`
          : 'none',
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
    if (!snapshot) return 'Collecting mobile viewport metrics…';
    return JSON.stringify(snapshot, null, 2);
  }, [snapshot]);

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
          background: rgba(2, 6, 23, 0.94);
          border: 1px solid rgba(148, 163, 184, 0.32);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(10px);
          color: #e2e8f0;
          font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
          font-size: 9px;
          line-height: 1;
          pointer-events: auto;
        }

        .mobile-keyboard-debug-header {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .mobile-keyboard-debug-header button {
          border: none;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.92);
          color: inherit;
          font: inherit;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          padding: 5px 8px;
        }
      `}</style>
    </div>
  );
}
