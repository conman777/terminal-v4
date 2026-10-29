import './ThreadDetailsCard.css';

const icons = {
  machine: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></svg>,
  folder: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  branch: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 9a8 8 0 0 1-8 8H6" /></svg>,
  changes: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M12 12v5M9.5 14.5h5" /></svg>,
};

// T3 Code's floating thread details: where the thread runs, its branch and its uncommitted changes.
export function ThreadDetailsCard({ machine, cwd, git, onOpenFiles, onReviewChanges, renderChanges, editorAction, scriptsAction, floating = false, children }) {
  const changesLabel = git?.available && <><span>Changes</span><span className="thread-details-delta"><span className="thread-details-added">+{git.added.toLocaleString()}</span> <span className="thread-details-removed">−{git.removed.toLocaleString()}</span></span></>;
  return (
    <aside className={`thread-details-card${floating ? ' thread-details-floating' : ''}`} aria-label="Thread details">
      <div className="thread-details-row thread-details-static" title={cwd || undefined}>{icons.machine}<span>{machine}</span></div>
      {onOpenFiles && cwd && <button type="button" className="thread-details-row" onClick={() => onOpenFiles(cwd)}>{icons.folder}<span>Open in Files</span></button>}
      {editorAction}
      {scriptsAction}
      {git?.available && <>
        <hr />
        {git.branch && <div className="thread-details-row thread-details-static" title={git.branch}>{icons.branch}<span className="thread-details-branch">{git.branch}</span></div>}
        {renderChanges ? renderChanges({ icon: icons.changes, label: changesLabel })
          : <button type="button" className="thread-details-row" aria-label="Review changes" onClick={onReviewChanges} disabled={!onReviewChanges}>{icons.changes}{changesLabel}</button>}
        {children}
      </>}
    </aside>
  );
}
