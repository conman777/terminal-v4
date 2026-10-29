import { useMemo, useState } from 'react';
import { parseUnifiedDiff, splitRows } from '../utils/unifiedDiff';
import './DiffView.css';

const LAYOUT_KEY = 'tv4DiffLayout';
function savedLayout() { try { return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'stacked'; } catch { return 'stacked'; } }

function Cell({ line, side }) {
  if (!line) return <><td className="diff-number" /><td className="diff-text diff-empty" /></>;
  const number = side === 'old' ? line.oldNumber : side === 'new' ? line.newNumber : line.newNumber ?? line.oldNumber;
  return <><td className="diff-number">{number ?? ''}</td><td className={`diff-text diff-${line.kind}`}>{line.text || ' '}</td></>;
}

// A readable diff: line numbers, stacked or side-by-side, and comments on lines that become notes for the agent.
export function DiffView({ patch, file, onComment }) {
  const [layout, setLayout] = useState(savedLayout);
  const [commenting, setCommenting] = useState(null);
  const [comment, setComment] = useState('');
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const rows = useMemo(() => (layout === 'split' ? splitRows(lines) : lines.map(line => ({ left: line, right: line }))), [layout, lines]);
  const choose = next => { setLayout(next); try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* per session */ } };
  const send = () => {
    const where = commenting.kind === 'removed' ? `removed line ${commenting.oldNumber}` : `line ${commenting.newNumber}`;
    onComment?.(`In ${file} ${where} (\`${commenting.text.trim()}\`): ${comment.trim()}`);
    setCommenting(null); setComment('');
  };
  const commentButton = line => onComment && line && line.kind !== 'hunk' && (
    <button type="button" className="diff-comment-button" aria-label={`Comment on ${line.kind === 'removed' ? `removed line ${line.oldNumber}` : `line ${line.newNumber}`} of ${file}`} onClick={() => setCommenting(line)}>+</button>
  );

  return (
    <div className={`diff-view diff-view-${layout}`}>
      <div className="diff-view-toolbar" role="group" aria-label="Diff layout">
        <button type="button" aria-pressed={layout === 'stacked'} onClick={() => choose('stacked')}>Stacked</button>
        <button type="button" aria-pressed={layout === 'split'} onClick={() => choose('split')}>Side by side</button>
      </div>
      <div className="diff-view-scroll" tabIndex={0} aria-label={`Diff for ${file}`}>
        <table>
          <tbody>
            {rows.map((row, index) => row.left?.kind === 'hunk'
              ? <tr key={index} className="diff-hunk-row"><td colSpan={layout === 'split' ? 5 : 3}>{row.left.text}</td></tr>
              : <tr key={index}>
                {layout === 'split'
                  ? <><Cell line={row.left} side="old" /><Cell line={row.right} side="new" /><td className="diff-actions">{commentButton(row.right || row.left)}</td></>
                  : <><Cell line={row.left} side="both" /><td className="diff-actions">{commentButton(row.left)}</td></>}
              </tr>)}
          </tbody>
        </table>
      </div>
      {commenting && <div className="diff-comment">
        <p>Line {commenting.newNumber ?? commenting.oldNumber}: <code>{commenting.text.trim()}</code></p>
        <textarea aria-label="Comment" rows={2} value={comment} onChange={event => setComment(event.target.value)} autoFocus />
        <div>
          <button type="button" onClick={() => { setCommenting(null); setComment(''); }}>Cancel</button>
          <button type="button" className="diff-comment-send" disabled={!comment.trim()} onClick={send}>Add to message</button>
        </div>
      </div>}
    </div>
  );
}
