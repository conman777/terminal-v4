import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getPreferredSessionTopic } from '../utils/sessionTopic';
import { ProjectBadge } from './ProjectBadge';
import { promptCustomSnoozeSeconds, settlementUnavailableReason, snoozeChoices } from '../utils/snoozeChoices';

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (!Number.isFinite(diffMs)) return '';
  const diffMinutes = Math.floor(Math.max(0, diffMs) / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMinutes > 0) return `${diffMinutes}m`;
  return 'now';
}

export default function ThreadsSessionItem({
  session,
  projectName = '',
  branch = null,
  isBusy,
  isActive,
  hasActivity,
  onSelect,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onTopicChange,
  onRenameSession,
  onClose,
  onMarkUnread,
  onUpdateThreadMetadata,
  onItemRef,
  reorder = null,
  onShowRelated,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const pendingActionRef = useRef(null);
  const inputRef = useRef(null);
  const selectRef = useRef(null);
  const actionsRef = useRef(null);
  const menuRef = useRef(null);
  const openerRef = useRef(null);
  const restoreTitleFocusRef = useRef(false);
  const menuId = useId();
  const errorId = useId();
  const thread = session.thread || {};
  const topic = getPreferredSessionTopic(thread.topic, session.title || 'New session');
  const isPinned = Boolean(thread.pinned);
  const isArchived = Boolean(thread.archived);
  const lifecycle = session.threadLifecycle;
  const activityAt = session.updatedAt || session.createdAt;
  const sessionAge = formatRelativeTime(activityAt);
  const resolvedIsBusy = typeof isBusy === 'boolean' ? isBusy : Boolean(session.isBusy);
  const needsAttention = lifecycle?.requiresAttention === true;
  const showReadyIndicator = !resolvedIsBusy && Boolean(hasActivity) && !isActive;

  useEffect(() => {
    if (!isEditing && restoreTitleFocusRef.current) {
      restoreTitleFocusRef.current = false;
      selectRef.current?.focus();
    }
  }, [isEditing]);

  const closeMenu = useCallback((restoreFocus = false) => {
    setContextMenu(null);
    if (restoreFocus) openerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    menu.style.left = `${Math.max(left + 8, Math.min(contextMenu.x, left + (viewport?.width || window.innerWidth) - rect.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(contextMenu.y, top + (viewport?.height || window.innerHeight) - rect.height - 8))}px`;
    menu.querySelector('button')?.focus();
    const dismiss = event => {
      if (!menu.contains(event.target) && !actionsRef.current?.contains(event.target)) closeMenu();
    };
    const dismissOnResize = () => closeMenu(true);
    const dismissOnScroll = event => { if (!menu.contains(event.target)) closeMenu(); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', dismissOnResize);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', dismissOnResize);
    };
  }, [contextMenu, closeMenu]);

  const openMenu = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pendingActionRef.current) return;
    openerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  }, []);

  const startRename = () => {
    if (pendingActionRef.current || isEditing) return;
    setActionError(null);
    setEditValue(topic);
    setIsEditing(true);
  };

  const runAction = async (label, action) => {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = label;
    setPendingAction(label);
    setActionError(null);
    try {
      const result = await action();
      if (result?.ok === false) throw result.error || new Error('Try again.');
      return true;
    } catch (error) {
      setActionError({ label, action, message: `Could not ${label.toLowerCase()}. ${error?.message || 'Try again.'}` });
      return false;
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  const handleEditSubmit = async (restoreFocus = false) => {
    if (pendingActionRef.current) return;
    const focusSource = document.activeElement;
    const shouldRestoreFocus = restoreFocus && inputRef.current?.parentElement.contains(focusSource);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== topic) {
      const succeeded = await runAction('Rename session', () => (onRenameSession || onTopicChange)?.(session.id, trimmed));
      if (!succeeded) return;
    }
    setActionError(null);
    restoreTitleFocusRef.current = shouldRestoreFocus && (document.activeElement === focusSource || document.activeElement === document.body);
    setIsEditing(false);
  };

  const folderPath = session.thread?.projectPath || session.cwd || '';
  const settleBlockedReason = !isArchived && lifecycle?.requiresAttention !== true ? settlementUnavailableReason(session) : null;
  const navigationItems = [
    ...(onShowRelated ? [{ label: 'Related threads', action: () => onShowRelated(session.id) }] : []),
    ...(reorder?.canMoveUp ? [{ label: 'Move up', action: () => reorder.onMove(-1) }] : []),
    ...(reorder?.canMoveDown ? [{ label: 'Move down', action: () => reorder.onMove(1) }] : []),
  ];
  const menuItems = [
    { label: 'Rename session', action: startRename },
    { label: isPinned ? 'Unpin' : 'Pin', action: () => (isPinned ? onUnpin : onPin)?.(session.id) },
    { label: isArchived ? 'Unarchive' : 'Archive', action: () => (isArchived ? onUnarchive : onArchive)?.(session.id) },
    ...(onUpdateThreadMetadata && typeof session.id === 'string' && session.id.startsWith('ss-') && !isArchived && lifecycle?.supported === true && (lifecycle.snoozed || !lifecycle.requiresAttention)
      ? (lifecycle.snoozed
        ? [{ label: 'Wake thread', action: () => onUpdateThreadMetadata(session.id, { wakeSnooze: true }) }]
        : [
          ...snoozeChoices().map(choice => ({ label: choice.label, action: () => onUpdateThreadMetadata(session.id, { snoozeForSeconds: choice.seconds }) })),
          { label: 'Snooze for custom time…', action: () => { const seconds = promptCustomSnoozeSeconds(); return seconds === null ? undefined : onUpdateThreadMetadata(session.id, { snoozeForSeconds: seconds }); } },
        ]) : []),
    ...(onUpdateThreadMetadata && session.runtime === 'v4' && !isArchived && lifecycle?.settlementSupported === true
      && (lifecycle.settled || lifecycle.canSettle === true) && lifecycle.requiresAttention === false
      ? [{ label: lifecycle.settled ? 'Un-settle thread' : 'Settle thread', action: () => onUpdateThreadMetadata(session.id, { settled: !lifecycle.settled }) }] : []),
    ...(settleBlockedReason ? [{ label: 'Settling unavailable', disabled: true, title: settleBlockedReason }] : []),
    ...(onMarkUnread && !hasActivity ? [{ label: 'Mark as unread', action: () => onMarkUnread(session.id) }] : []),
    ...(folderPath ? [{ label: 'Copy folder path', action: () => navigator.clipboard?.writeText(folderPath) }] : []),
    ...(branch ? [{ label: 'Copy branch name', action: () => navigator.clipboard?.writeText(branch) }] : []),
    { label: 'Copy thread ID', action: () => navigator.clipboard?.writeText(session.id) },
    { label: 'Close session', action: () => onClose?.(session.id), danger: true }
  ];

  return (
    <div
      ref={onItemRef}
      className={`threads-session-item threads-card ${isActive ? 'active' : (!isEditing && !actionError ? 'compact' : '')} ${isArchived ? 'archived' : ''}${reorder?.dragging ? ' thread-reorder-dragging' : ''}${reorder?.dropMark ? ` thread-reorder-over-${reorder.dropMark}` : ''}`}
      draggable={reorder?.draggable && !isEditing ? true : undefined}
      data-thread-id={session.id}
      onDragStart={reorder?.draggable ? event => reorder.onDragStart(event) : undefined}
      onDragOver={reorder?.draggable ? event => reorder.onDragOver(event) : undefined}
      onDragLeave={reorder?.draggable ? event => reorder.onDragLeave(event) : undefined}
      onDrop={reorder?.draggable ? event => reorder.onDrop(event) : undefined}
      onDragEnd={reorder?.draggable ? event => reorder.onDragEnd(event) : undefined}
      aria-busy={Boolean(pendingAction)}
      onClick={event => { if (!event.target.closest('button, input')) onSelect?.(session.id); }}
      onDoubleClick={event => {
        if (event.target.closest('button, input') && !event.target.closest('.threads-session-select')) return;
        event.preventDefault();
        startRename();
      }}
      onContextMenu={event => {
        if (event.target.closest('input')) return;
        event.preventDefault();
        event.stopPropagation();
        if (pendingActionRef.current) return;
        openerRef.current = selectRef.current;
        setContextMenu({x: event.clientX, y: event.clientY});
      }}
    >
      <div className="threads-card-head">
        {projectName && <ProjectBadge name={projectName} />}
        {projectName && <span className="threads-card-project" title={projectName}>{projectName}</span>}
        {sessionAge && <time className="threads-session-time" dateTime={activityAt} title={activityAt}>{sessionAge}</time>}
      </div>
      <div className={`threads-session-content ${actionError ? 'has-action-error' : ''}`}>
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="threads-session-edit"
            aria-label="Thread title"
            aria-invalid={actionError?.label === 'Rename session' ? true : undefined}
            aria-describedby={actionError ? errorId : undefined}
            readOnly={Boolean(pendingAction)}
            value={editValue}
            onChange={event => { setEditValue(event.target.value); setActionError(null); }}
            onBlur={() => { if (!actionError) handleEditSubmit(); }}
            onKeyDown={event => {
              if (pendingActionRef.current) return;
              if (event.key === 'Enter') { event.preventDefault(); handleEditSubmit(true); }
              if (event.key === 'Escape') { event.preventDefault(); setActionError(null); restoreTitleFocusRef.current = true; setIsEditing(false); }
            }}
            autoFocus
          />
        ) : (
          <button
            ref={selectRef}
            type="button"
            className="threads-session-select"
            aria-label={`Select ${topic}`}
            aria-pressed={Boolean(isActive)}
            title={topic}
            onClick={() => onSelect?.(session.id)}
            onKeyDown={event => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event);
              if (event.altKey && reorder && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault();
                reorder.onMove(event.key === 'ArrowUp' ? -1 : 1);
              }
            }}
          >
            <span className="threads-session-topic">{topic}</span>
          </button>
        )}
        {actionError && (
          <div className="threads-session-action-error">
            <span id={errorId} role="alert">{actionError.message}</span>
            <button type="button" onClick={() => actionError.label === 'Rename session' ? handleEditSubmit(true) : runAction(actionError.label, actionError.action)}>Retry</button>
          </div>
        )}
      </div>
      <button
        ref={actionsRef}
        type="button"
        className="threads-action-btn threads-session-more"
        aria-label={`Thread actions for ${topic}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(contextMenu)}
        aria-controls={contextMenu ? menuId : undefined}
        title="Thread actions"
        disabled={Boolean(pendingAction)}
        onClick={event => contextMenu ? closeMenu(true) : openMenu(event)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
      </button>
      {(branch || resolvedIsBusy || showReadyIndicator || needsAttention || isPinned) && <div className="threads-card-foot">
        {branch && <span className="threads-card-branch" title={branch}>{branch}</span>}
        {(resolvedIsBusy || showReadyIndicator || needsAttention) && <span className={`threads-session-indicator ${needsAttention ? 'attention' : resolvedIsBusy ? 'busy' : 'ready'}`} role="img" aria-label={needsAttention ? 'Needs attention' : resolvedIsBusy ? 'Working' : 'Ready to review'}>
          {resolvedIsBusy && !needsAttention ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" opacity=".2" />
                <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
          ) : <span className="threads-session-ready-dot" aria-hidden="true" />}
        </span>}
        {isPinned && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Pinned" role="img">
              <path d="m16 3 5 5-4 1-3 5v4l-3-3-6 6 6-6-3-3h4l5-3z" />
            </svg>}
      </div>}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="threads-session-menu"
          role="menu"
          aria-label={`Actions for ${topic}`}
          style={{left: contextMenu.x, top: contextMenu.y}}
          onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeMenu(); }}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
            const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
            const index = buttons.indexOf(document.activeElement);
            const next = {ArrowDown: (index + 1) % buttons.length, ArrowUp: (index + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1}[event.key];
            if (next !== undefined) { event.preventDefault(); buttons[next].focus(); }
          }}
        >
          {[...navigationItems, ...menuItems].map(item => <button key={item.label} type="button" role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled} title={item.title} onClick={() => {
            closeMenu(true);
            if (item.label === 'Rename session') startRename();
            else runAction(item.label, item.action);
          }}>{item.label}</button>)}
        </div>, document.body
      )}
    </div>
  );
}
