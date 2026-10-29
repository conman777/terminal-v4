import { useEffect, useId, useRef, useState } from 'react';
import { downloadProjectArchive } from '../utils/projectArchiveDownload';
import { ProjectBadge } from './ProjectBadge';

function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const onKeyDown = event => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  };
  return { open, setOpen, rootRef, triggerRef, onKeyDown };
}

export function ThreadsProjectFilter({ projects, selectedPath, onSelectPath, onCreateSession, onCloseProject }) {
  const { open, setOpen, rootRef, triggerRef, onKeyDown } = usePopover();
  const panelId = useId();
  const choose = path => { onSelectPath(path); setOpen(false); triggerRef.current?.focus(); };
  return (
    <div className="threads-popover-root threads-project-filter-root" ref={rootRef} onKeyDown={onKeyDown}>
      <button ref={triggerRef} type="button" className={`pro-toolbar-icon ${selectedPath ? 'active' : ''}`} aria-label="Filter threads by project"
        title="Filter threads by project" aria-pressed={Boolean(selectedPath)} aria-expanded={open} aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(value => !value)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
      </button>
      {open && <div className="threads-popover threads-project-filter" id={panelId} role="dialog" aria-label="Projects">
        <button type="button" className="threads-project-row-select" aria-pressed={!selectedPath} aria-label="Show all projects" onClick={() => choose(null)}>
          <span className="threads-project-row-name">All projects</span>
        </button>
        {projects.length === 0 && <p className="threads-popover-empty">Add a project to group threads.</p>}
        {projects.map(project => {
          const count = project.allSessions.length;
          return <div className="threads-project-row" key={project.projectPath || project.projectName}>
            <button type="button" className="threads-project-row-select" aria-pressed={selectedPath === project.normalizedPath}
              aria-label={`Show only ${project.projectName}`} title={project.projectPath} onClick={() => choose(project.normalizedPath)}>
              <ProjectBadge name={project.projectName} />
              <span className="threads-project-row-name">{project.projectName}</span>
              {count > 0 && <span className="threads-project-row-count" aria-hidden="true">{count}</span>}
            </button>
            <div className="threads-project-row-actions">
              {onCreateSession && <button type="button" aria-label={`New thread in ${project.projectName}`} title="New thread in this project"
                onClick={() => { setOpen(false); onCreateSession(project.projectPath); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>}
              {project.projectPath && <button type="button" aria-label={`Zip and download ${project.projectName}`} title="Zip and download project"
                onClick={() => downloadProjectArchive(project.projectPath)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
              </button>}
              {onCloseProject && project.projectPath && <button type="button" aria-label={`Close project ${project.projectName}`}
                title={`Close project (${count} ${count === 1 ? 'thread' : 'threads'})`}
                onClick={() => { setOpen(false); onCloseProject(project.projectPath, project.allSessions.map(session => session.id)); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>}
            </div>
          </div>;
        })}
      </div>}
    </div>
  );
}

export function ThreadsAppsMenu({ apps }) {
  const { open, setOpen, rootRef, triggerRef, onKeyDown } = usePopover();
  const menuId = useId();
  useEffect(() => { if (open) rootRef.current?.querySelector('[role="menuitem"]')?.focus(); }, [open, rootRef]);
  const moveFocus = event => {
    const items = [...(rootRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    const index = items.indexOf(document.activeElement);
    const next = { ArrowDown: (index + 1) % items.length, ArrowUp: (index + items.length - 1) % items.length, Home: 0, End: items.length - 1 }[event.key];
    if (next !== undefined && items.length) { event.preventDefault(); items[next].focus(); }
  };
  return (
    <div className="threads-popover-root" ref={rootRef} onKeyDown={event => { onKeyDown(event); moveFocus(event); }}>
      <button ref={triggerRef} type="button" className="pro-sidebar-icon-btn" aria-label="Workspace apps" title="Workspace apps"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></svg>
      </button>
      {open && <div className="threads-popover threads-apps-menu" id={menuId} role="menu" aria-label="Workspace apps">
        {apps.map(app => <button key={app.label} type="button" role="menuitem" aria-label={app.label}
          className={app.active ? 'active' : undefined} onClick={() => { setOpen(false); app.onSelect(); }}>
          {app.icon}<span>{app.label}</span>
        </button>)}
      </div>}
    </div>
  );
}
