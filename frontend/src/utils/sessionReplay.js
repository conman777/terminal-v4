export function validateRecording(record) {
  if (record?.format !== 'terminal-v4-session-recording' || record.version !== 1 ||
      !Array.isArray(record.events) || record.events.length > 10000) {
    throw new Error('Unsupported recording format');
  }
  let previous = -Infinity;
  let bytes = 0;
  for (const event of record.events) {
    bytes += typeof event.text === 'string' ? event.text.length : Infinity;
    if (!Number.isSafeInteger(event.sourceSeq) || event.sourceSeq <= previous ||
        !Number.isSafeInteger(event.ts) || !['terminal', 'agent'].includes(event.kind) ||
        typeof event.text !== 'string' || event.text.length > 131072 || bytes > 8388608) {
      throw new Error('Invalid recording event');
    }
    previous = event.sourceSeq;
  }
  return record;
}

export function replayEvents(events, position) {
  return events.filter(event => event.ts <= position);
}

export function replayTranscript(events, position) {
  const lines = [[]];
  let row = 0, col = 0;
  const source = replayEvents(events, position).map(event => event.text).join('');
  const write = char => {
    lines[row] ||= [];
    while (lines[row].length < col) lines[row].push(' ');
    lines[row][col++] = char;
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\x1b') {
      const match = source.slice(i).match(/^\x1b\[([0-9;?]*)([ -/]*)([@-~])/);
      if (match) {
        const args = match[1].split(';').map(value => Number(value) || 0);
        const command = match[3];
        if (command === 'K') {
          lines[row] ||= [];
          if (args[0] === 2) lines[row] = [];
          else if (args[0] === 1) for (let n = 0; n <= col; n += 1) lines[row][n] = ' ';
          else lines[row].length = Math.min(col, lines[row].length);
        } else if (command === 'J' && args[0] === 2) { lines.length = 0; lines.push([]); row = 0; col = 0; }
        else if (command === 'H' || command === 'f') { row = Math.max(0, (args[0] || 1) - 1); col = Math.max(0, (args[1] || 1) - 1); }
        else if (command === 'A') row = Math.max(0, row - (args[0] || 1));
        else if (command === 'B') row = Math.min(10000, row + (args[0] || 1));
        else if (command === 'C') col = Math.min(10000, col + (args[0] || 1));
        else if (command === 'D') col = Math.max(0, col - (args[0] || 1));
        i += match[0].length - 1;
      } else {
        const osc = source.slice(i).match(/^\x1b\][\s\S]*?(?:\x07|\x1b\\)/);
        if (osc) i += osc[0].length - 1;
      }
    } else if (char === '\r') col = 0;
    else if (char === '\n') { row += 1; col = 0; lines[row] ||= []; }
    else if (char === '\b') col = Math.max(0, col - 1);
    else if (char === '\t') { do { write(' '); } while (col % 8); }
    else if (char >= ' ') write(char);
  }
  return Array.from({ length: lines.length }, (_, index) => (lines[index] || []).join('')).join('\n');
}
