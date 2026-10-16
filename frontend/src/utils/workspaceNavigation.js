export async function reopenWorkspaceSession(sessionId, { restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane }, paneId) {
  await restoreSession(sessionId);
  await unarchiveSession(sessionId);
  addSessionToDesktop(sessionId);
  if (paneId) {
    focusPane(paneId);
    setPaneSession(paneId, sessionId);
  }
  selectSession(sessionId);
}
