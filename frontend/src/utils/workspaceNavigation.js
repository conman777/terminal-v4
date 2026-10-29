export async function reopenWorkspaceSession(sessionId, { restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane, isTargetCurrent = () => true }, paneId) {
  const restoration = await restoreSession(sessionId, { select: false });
  const isCurrent = typeof restoration?.isCurrent === 'function' ? restoration.isCurrent : () => true;
  if (!isCurrent() || !isTargetCurrent()) return { reopened: false, stale: true };
  await unarchiveSession(sessionId);
  if (!isCurrent() || !isTargetCurrent()) return { reopened: false, stale: true };
  addSessionToDesktop(sessionId);
  if (paneId) {
    focusPane(paneId);
    setPaneSession(paneId, sessionId);
  }
  const selection = selectSession(sessionId);
  return { reopened: true, isCurrent: typeof selection?.isCurrent === 'function' ? selection.isCurrent : () => true };
}
