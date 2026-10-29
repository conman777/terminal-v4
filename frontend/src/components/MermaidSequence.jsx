import { useId } from 'react';

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_-]*';
const PARTICIPANT = new RegExp(`^participant\\s+(${IDENTIFIER})(?:\\s+as\\s+([^\\r\\n]{1,80}))?$`, 'i');
const MESSAGE = new RegExp(`^(${IDENTIFIER}?)\\s*(-->>|->>)\\s*(${IDENTIFIER})\\s*:\\s*([^\\r\\n]{1,120})$`);
const NOTE = new RegExp(`^note\\s+over\\s+(${IDENTIFIER})(?:\\s*,\\s*(${IDENTIFIER}))?\\s*:\\s*([^\\r\\n]{1,120})$`, 'i');
const LOOP = /^loop(?:\s+([^\r\n]{1,80}))?$/i;

export function parseSequence(source) {
  if (source.length > 8192) return null;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.shift() !== 'sequenceDiagram') return null;
  const participants = new Map(), messages = [], entries = [], loops = [], openLoops = [];
  const add = (id, label) => {
    const clean = label?.trim().replace(/^"(.*)"$/, '$1');
    if (!participants.has(id)) participants.set(id, { id, label: clean || id });
    else if (clean) participants.get(id).label = clean;
  };
  for (const line of lines) {
    const participant = PARTICIPANT.exec(line);
    if (participant) add(participant[1], participant[2]);
    else {
      const loop = LOOP.exec(line);
      const note = NOTE.exec(line);
      if (loop) {
        if (openLoops.length >= 4) return null;
        const group = { start: entries.length, end: null, depth: openLoops.length, label: loop[1]?.trim() || '' };
        loops.push(group); openLoops.push(group); entries.push({ kind: 'loopStart', label: group.label });
      } else if (line.toLowerCase() === 'end') {
        const group = openLoops.pop();
        if (!group || entries.length === group.start + 1) return null;
        group.end = entries.length; entries.push({ kind: 'loopEnd' });
      } else if (note) {
        if (!note[3].trim()) return null;
        add(note[1]);
        if (note[2]) add(note[2]);
        entries.push({ kind: 'note', participants: note[2] ? [note[1], note[2]] : [note[1]], text: note[3].trim() });
      } else {
        const message = MESSAGE.exec(line);
        if (!message || !message[4].trim()) return null;
        add(message[1]); add(message[3]);
        const entry = { kind: 'message', from: message[1], to: message[3], text: message[4].trim(), reply: message[2] === '-->>' };
        messages.push(entry); entries.push(entry);
      }
    }
    if (participants.size > 16 || entries.length > 64) return null;
  }
  if (!participants.size || !entries.length || openLoops.length) return null;
  return { participants: [...participants.values()], messages, entries, loops };
}

export function MermaidSequence({ source }) {
  const markerId = `sequence-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const diagram = parseSequence(source);
  if (!diagram) return null;
  const positions = new Map(diagram.participants.map((participant, index) => [participant.id, 80 + index * 170]));
  const width = 160 + (diagram.participants.length - 1) * 170 + (diagram.messages.some(message => message.from === message.to) ? 100 : 0);
  const height = 120 + diagram.entries.length * 60;
  const shorten = (text, length) => { const chars = Array.from(text); return chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : text; };
  const labels = new Map(diagram.participants.map(participant => [participant.id, participant.label]));
  const summary = diagram.entries.map(entry => {
    if (entry.kind === 'note') return `Note over ${entry.participants.map(id => labels.get(id)).join(', ')}: ${entry.text}`;
    if (entry.kind === 'loopStart') return entry.label ? `Loop: ${entry.label}` : 'Loop';
    if (entry.kind === 'loopEnd') return 'End loop';
    return `${labels.get(entry.from)} to ${labels.get(entry.to)}: ${entry.text}`;
  }).join('; ');
  return <div className="md-sequence-scroll" role="region" aria-label="Mermaid sequence diagram" tabIndex={0} data-conversation-scroll-region>
    <svg role="img" aria-label={`Sequence diagram: ${summary}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {diagram.loops.map((loop, index) => {
        const left = 4 + loop.depth * 3, top = 55 + loop.start * 60, bottom = 97 + loop.end * 60;
        return <g key={index} className="md-sequence-loop"><rect className="md-sequence-loop-outline" x={left} y={top} width={width - left * 2} height={bottom - top} /></g>;
      })}
      {diagram.participants.map(participant => {
        const x = positions.get(participant.id);
        return <g key={participant.id}><line className="md-sequence-lifeline" x1={x} y1="50" x2={x} y2={height - 45} stroke="currentColor" strokeDasharray="4 4" />
          <rect x={x - 60} y="10" width="120" height="40" rx="6" /><text x={x} y="30" textAnchor="middle" dominantBaseline="middle"><title>{participant.label}</title>{shorten(participant.label, 18)}</text>
          <rect x={x - 60} y={height - 45} width="120" height="35" rx="6" /><text x={x} y={height - 27} textAnchor="middle" dominantBaseline="middle"><title>{participant.label}</title>{shorten(participant.label, 18)}</text></g>;
      })}
      {diagram.loops.map((loop, index) => {
        const left = 4 + loop.depth * 3, top = 55 + loop.start * 60;
        const label = loop.label ? `Loop: ${loop.label}` : 'Loop';
        const limit = Math.max(8, Math.min(48, Math.floor((width - left * 2 - 16) / 7)));
        const shown = shorten(label, limit);
        const labelWidth = Math.min(width - left * 2 - 10, Math.max(36, Array.from(shown).length * 8 + 12));
        const clipId = `${markerId}-loop-${index}`;
        return <g key={index}><defs><clipPath id={clipId} clipPathUnits="userSpaceOnUse"><rect x={left + 8} y={top + 2} width={labelWidth - 6} height="20" /></clipPath></defs><rect x={left + 5} y={top + 2} width={labelWidth} height="20" /><text className="md-sequence-loop-label" clipPath={`url(#${clipId})`} x={left + 8} y={top + 17}><title>{label}</title>{shown}</text></g>;
      })}
      {diagram.entries.map((message, index) => {
        if (message.kind === 'loopStart' || message.kind === 'loopEnd') return null;
        if (message.kind === 'note') {
          const xs = message.participants.map(id => positions.get(id));
          const left = Math.min(...xs) - 60, right = Math.max(...xs) + 60, y = 85 + index * 60;
          return <g key={index} className="md-sequence-note"><rect x={left} y={y - 24} width={right - left} height="40" rx="4" /><text x={(left + right) / 2} y={y - 4} textAnchor="middle" dominantBaseline="middle"><title>{message.text}</title>{shorten(message.text, Math.min(48, Math.floor((right - left) / 7)))}</text></g>;
        }
        const x1 = positions.get(message.from), x2 = positions.get(message.to), y = 85 + index * 60;
        const arrow = message.from === message.to
          ? <path d={`M ${x1} ${y} h 70 v 25 h -70`} fill="none" stroke="currentColor" strokeDasharray={message.reply ? '5 4' : undefined} markerEnd={`url(#${markerId})`} />
          : <line className={message.reply ? 'md-sequence-reply' : undefined} x1={x1} y1={y} x2={x2} y2={y} stroke="currentColor" strokeDasharray={message.reply ? '5 4' : undefined} markerEnd={`url(#${markerId})`} />;
        return <g key={index}>{arrow}<text x={message.from === message.to ? x1 + 35 : (x1 + x2) / 2} y={y - 7} textAnchor="middle"><title>{message.text}</title>{shorten(message.text, 22)}</text></g>;
      })}
    </svg>
  </div>;
}
