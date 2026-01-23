import { useState, useCallback, useRef } from 'react';

/**
 * Process a line of terminal output, simulating cursor movements.
 * This handles progress spinners that use cursor positioning to overwrite in place.
 *
 * @param {string} line - A single line of terminal output (may contain escape sequences)
 * @returns {string} - The rendered line with cursor movements applied
 */
function processLine(line) {
  // Buffer to hold characters at each column position
  const buffer = [];
  let cursor = 0;

  let i = 0;
  while (i < line.length) {
    const char = line[i];

    // Handle escape sequences
    if (char === '\x1b' && line[i + 1] === '[') {
      // Find the end of the CSI sequence
      let j = i + 2;
      let params = '';
      while (j < line.length && /[0-9;?]/.test(line[j])) {
        params += line[j];
        j++;
      }
      const cmd = line[j];

      if (cmd === 'G') {
        // Cursor to column N (1-based, default 1)
        const col = parseInt(params, 10) || 1;
        cursor = col - 1;
      } else if (cmd === 'C') {
        // Cursor forward N columns (default 1)
        const n = parseInt(params, 10) || 1;
        cursor += n;
      } else if (cmd === 'D') {
        // Cursor backward N columns (default 1)
        const n = parseInt(params, 10) || 1;
        cursor = Math.max(0, cursor - n);
      } else if (cmd === 'K') {
        // Erase in line
        const mode = parseInt(params, 10) || 0;
        if (mode === 0) {
          // Erase from cursor to end of line
          buffer.length = cursor;
        } else if (mode === 1) {
          // Erase from start to cursor
          for (let k = 0; k <= cursor && k < buffer.length; k++) {
            buffer[k] = ' ';
          }
        } else if (mode === 2) {
          // Erase entire line
          buffer.length = 0;
          cursor = 0;
        }
      }
      // Skip other CSI sequences (colors, etc.)
      i = j + 1;
      continue;
    }

    // Handle carriage return
    if (char === '\r') {
      cursor = 0;
      i++;
      continue;
    }

    // Handle backspace
    if (char === '\x08') {
      cursor = Math.max(0, cursor - 1);
      i++;
      continue;
    }

    // Handle tab
    if (char === '\t') {
      // Tab to next 8-column boundary
      const nextTab = Math.ceil((cursor + 1) / 8) * 8;
      while (cursor < nextTab) {
        buffer[cursor] = ' ';
        cursor++;
      }
      i++;
      continue;
    }

    // Skip other control characters and standalone escape sequences
    if (char === '\x1b') {
      // Single-char escape sequence or character set selection
      if (line[i + 1] && /[()*/+\-]/.test(line[i + 1])) {
        // Character set selection (e.g., ESC(B) - skip 3 chars
        i += 3;
      } else if (line[i + 1] === ']') {
        // OSC sequence - find terminator (BEL or ST)
        let j = i + 2;
        while (j < line.length) {
          if (line[j] === '\x07') {
            j++;
            break;
          }
          if (line[j] === '\x1b' && line[j + 1] === '\\') {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
      } else {
        // Other escape sequence - skip 2 chars
        i += 2;
      }
      continue;
    }

    // Skip non-printable control characters
    if (char.charCodeAt(0) < 32 && char !== '\n') {
      i++;
      continue;
    }

    // Regular printable character - write to buffer at cursor position
    if (char.charCodeAt(0) >= 32) {
      // Extend buffer with spaces if needed
      while (buffer.length < cursor) {
        buffer.push(' ');
      }
      buffer[cursor] = char;
      cursor++;
    }

    i++;
  }

  return buffer.join('').trimEnd();
}

/**
 * Strips ANSI escape sequences from text while simulating cursor movements.
 * This properly handles progress spinners and other cursor-based overwrites.
 *
 * @param {string} str - Input string to process
 * @param {string} pendingLine - Any incomplete line from previous chunk
 * @returns {{ result: string, pendingLine: string }} - Processed result and any incomplete line
 */
function stripAnsi(str, pendingLine = '') {
  // Prepend any pending incomplete line from previous chunk
  const input = pendingLine + str;

  // Split by newlines, but keep track of whether input ends with newline
  const endsWithNewline = input.endsWith('\n');
  const lines = input.split('\n');

  // If doesn't end with newline, last line is incomplete
  let newPendingLine = '';
  if (!endsWithNewline && lines.length > 0) {
    newPendingLine = lines.pop();
  }

  // Process each complete line
  const processedLines = lines.map(line => processLine(line));

  return {
    result: processedLines.join('\n') + (processedLines.length > 0 ? '\n' : ''),
    pendingLine: newPendingLine
  };
}

/**
 * Hook to manage a text buffer for the Reader View.
 * Accumulates terminal output with ANSI codes stripped and cursor movements simulated.
 *
 * @param {number} maxChars - Maximum characters to keep in buffer (default 500000)
 * @returns {Object} { buffer, append, clear, setBuffer }
 */
export function useTerminalBuffer(maxChars = 500000) {
  const [buffer, setBuffer] = useState('');
  const bufferRef = useRef('');
  const pendingLineRef = useRef(''); // Track incomplete lines

  const append = useCallback((data) => {
    if (!data) return;

    const { result: cleanText, pendingLine } = stripAnsi(data, pendingLineRef.current);
    pendingLineRef.current = pendingLine;

    if (!cleanText) return;

    setBuffer(prev => {
      let newBuffer = prev + cleanText;

      // Trim from start if exceeds max, preserving line boundaries
      if (newBuffer.length > maxChars) {
        // Find first newline after trimming
        const trimPoint = newBuffer.length - maxChars;
        const newlineAfterTrim = newBuffer.indexOf('\n', trimPoint);
        if (newlineAfterTrim !== -1) {
          newBuffer = newBuffer.slice(newlineAfterTrim + 1);
        } else {
          newBuffer = newBuffer.slice(trimPoint);
        }
      }

      bufferRef.current = newBuffer;
      return newBuffer;
    });
  }, [maxChars]);

  const clear = useCallback(() => {
    bufferRef.current = '';
    pendingLineRef.current = '';
    setBuffer('');
  }, []);

  const replace = useCallback((text) => {
    const nextBuffer = text || '';
    bufferRef.current = nextBuffer;
    pendingLineRef.current = '';
    setBuffer(nextBuffer);
  }, []);

  return { buffer, append, clear, replace, setBuffer, bufferRef };
}

// Export a simple version for one-off stripping (no pending line tracking)
export function stripAnsiSimple(str) {
  const { result } = stripAnsi(str, '');
  return result;
}

export { stripAnsi };
