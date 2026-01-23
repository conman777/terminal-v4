import { useRef, useEffect, useState, useCallback } from 'react';

/**
 * ReaderView - A clean, scrollable text view for terminal output
 *
 * Displays terminal content as properly-wrapped text instead of canvas rendering.
 * Supports auto-scrolling to bottom as new content arrives.
 * Supports keyboard input - keystrokes are forwarded to the terminal.
 */
export function ReaderView({ content, lines, cursor, fontSize, onScrollDirection, onLoadMore, onInput, isMobile }) {
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastScrollTop = useRef(0);
  const scrollThrottle = useRef(null);
  const resolvedFontFamily = isMobile
    ? '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
    : 'Consolas, "Courier New", monospace';

  // Auto-scroll to bottom when content changes (if enabled)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content, autoScroll]);

  // Focus on mount so keyboard works immediately
  useEffect(() => {
    // Delay to ensure DOM is ready and previous focus is cleared
    const timer = setTimeout(() => {
      const target = inputRef.current || containerRef.current;
      if (target) {
        target.focus();
        // Verify focus actually worked, retry if needed
        if (document.activeElement !== target) {
          setTimeout(() => target.focus(), 100);
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isMobile]);

  // Click handler to ensure focus is maintained
  const handleClick = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    if (inputRef.current) {
      inputRef.current.focus();
      return;
    }
    containerRef.current?.focus();
  }, []);

  // Desktop keyboard handler
  const handleKeyDown = useCallback((e) => {
    if (!onInput) return;
    const targetIsInput = e.target === inputRef.current;

    // Stop propagation to prevent xterm from also handling this event
    e.stopPropagation();

    // Allow copy with Cmd/Ctrl+C when text is selected
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return; // Let browser handle copy
      }
    }

    // Allow paste with Cmd/Ctrl+V
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      e.preventDefault();
      navigator.clipboard?.readText().then((text) => {
        if (text) onInput(text);
      }).catch(() => {});
      return;
    }

    // Handle Ctrl+key combinations (Ctrl+C for SIGINT, etc.)
    if (e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const code = e.key.toLowerCase().charCodeAt(0) - 96; // a=1, b=2, c=3...
      if (code > 0 && code < 27) {
        onInput(String.fromCharCode(code));
      }
      return;
    }

    // Special key mappings
    const keyMap = {
      'Enter': '\r',
      'Backspace': '\x7f',
      'Tab': '\t',
      'Escape': '\x1b',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Home': '\x1b[H',
      'End': '\x1b[F',
      'Delete': '\x1b[3~',
    };

    if (keyMap[e.key]) {
      e.preventDefault();
      onInput(keyMap[e.key]);
    } else if (!targetIsInput && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onInput(e.key);
    }
  }, [onInput]);

  // Text input handler
  const handleInput = useCallback((e) => {
    if (!onInput) return;
    const value = e.target.value;
    if (value) {
      onInput(value);
      e.target.value = ''; // Clear after sending
    }
  }, [onInput]);

  // Detect user scroll to manage auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Check if user is near the bottom (within 50px tolerance)
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    setAutoScroll(isAtBottom);

    if (onLoadMore && el.scrollTop <= 40) {
      onLoadMore();
    }

    // Report scroll direction for header collapse (mobile)
    if (onScrollDirection && !scrollThrottle.current) {
      const direction = el.scrollTop > lastScrollTop.current ? 'down' : 'up';
      onScrollDirection(direction);
      scrollThrottle.current = setTimeout(() => {
        scrollThrottle.current = null;
      }, 100);
    }
    lastScrollTop.current = el.scrollTop;
  }, [onScrollDirection]);

  // Cleanup throttle timer
  useEffect(() => {
    return () => {
      if (scrollThrottle.current) {
        clearTimeout(scrollThrottle.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="reader-view"
      tabIndex={0}
      onKeyDown={!isMobile ? handleKeyDown : undefined}
      onClick={handleClick}
      onScroll={handleScroll}
      style={{ fontSize: fontSize || 14, fontFamily: resolvedFontFamily }}
    >
      <pre className="reader-view-content">
        {Array.isArray(lines) && lines.length > 0
          ? lines.map((line, index) => {
            const showCursor = cursor && cursor.line === index;
            const lineText = line ?? '';
            const column = showCursor ? Math.max(0, cursor.column) : 0;
            const paddedLine = showCursor && column > lineText.length
              ? lineText.padEnd(column, ' ')
              : lineText;
            const cursorChar = showCursor ? '\u00a0' : '';
            const before = showCursor ? paddedLine.slice(0, column) : paddedLine;
            const after = showCursor ? paddedLine.slice(column + 1) : '';
            const needsNewline = index < lines.length - 1;
            return (
              <span key={index}>
                {showCursor ? (
                  <>
                    {before}
                    <span className="reader-view-cursor">{cursorChar}</span>
                    {after}
                  </>
                ) : (
                  before
                )}
                {needsNewline ? '\n' : ''}
              </span>
            );
          })
          : content}
      </pre>

      {/* Hidden input for keyboard capture */}
      <input
        ref={inputRef}
        className="reader-view-mobile-input"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck="false"
      />
    </div>
  );
}
