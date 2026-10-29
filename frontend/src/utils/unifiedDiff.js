// Lines of a unified diff with the line numbers they have before and after the change.
export function parseUnifiedDiff(patch) {
  const lines = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const raw of (patch || '').split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]);
      lines.push({ kind: 'hunk', oldNumber: null, newNumber: null, text: raw });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'added', oldNumber: null, newNumber: newNumber++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', oldNumber: oldNumber++, newNumber: null, text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text: raw.slice(1) });
    }
  }
  return lines;
}

// Rows for a side-by-side view: each run of removals is paired with the additions that follow it.
export function splitRows(lines) {
  const rows = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind !== 'removed' && line.kind !== 'added') { rows.push({ left: line, right: line }); index += 1; continue; }
    const removed = [];
    const added = [];
    while (lines[index]?.kind === 'removed') removed.push(lines[index++]);
    while (lines[index]?.kind === 'added') added.push(lines[index++]);
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) rows.push({ left: removed[pair] || null, right: added[pair] || null });
  }
  return rows;
}
