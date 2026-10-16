import { useState, useSyncExternalStore } from 'react';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { environmentAllows } from '../utils/runtimePermissions';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';
import { DesktopStatusBar } from './DesktopStatusBar';

function getWorkspaceLabel(path) {
  if (!path || typeof path !== 'string') {
    return 'No workspace selected';
  }
  return path;
}

export function WorkspaceStartView({
  currentPath,
  onCreateSession,
  onSubmitPrompt,
  onAddWorkspace,
  onSelectSession,
  onSelectHistorySession,
}) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const canCreateSession = environmentAllows(environment, 'terminalInput');
  const [composerValue, setComposerValue] = useState('');

  function handleSubmit(value) {
    const trimmed = typeof value === 'string' ? value.trim() : composerValue.trim();
    if (!canCreateSession || !trimmed) return;
    onSubmitPrompt?.(trimmed);
    setComposerValue('');
  }

  return (
    <section className="workspace-start-view" aria-label="Workspace start">
      <div className="workspace-start-shell">
        <header className="workspace-welcome">
          <div className="workspace-wordmark"><span aria-hidden="true">&gt;_</span> terminal v4</div>
          <p className="workspace-welcome-eyebrow">Your agents. Your machines. One workspace.</p>
          <h1>What are we building?</h1>
          <p>Start a conversation, open a terminal, or pick up where you left off.</p>
        </header>
        <div className="workspace-start-lightbar">
          <WorkspaceToolsButton workspacePath={currentPath} onStartTask={canCreateSession ? onCreateSession : undefined} onSelectSession={onSelectHistorySession || onSelectSession} onInsertPrompt={setComposerValue} />
          <WorkspaceProfileButton workspacePath={currentPath} />
          <div className="workspace-start-path-pill" title={getWorkspaceLabel(currentPath)}>
            <span className="workspace-start-path-pill-label">Workspace</span>
            <code>{getWorkspaceLabel(currentPath)}</code>
          </div>
          {onAddWorkspace ? (
            <button className="workspace-start-light-action" type="button" onClick={() => onAddWorkspace()}>
              Add workspace
            </button>
          ) : null}
        </div>

        {!canCreateSession && <p className="remote-readonly-notice" role="status">This environment is read-only. Select an existing thread to view its output.</p>}
        <div className="workspace-start-composer-shell">
          <DesktopStatusBar
            sessionId="workspace-start"
            composerValue={composerValue}
            composerAttachments={[]}
            onComposerChange={setComposerValue}
            onComposerSubmit={handleSubmit}
            composerPlaceholder="Ask V4 anything"
            composerDisabled={!canCreateSession}
            showTopRow={false}
            showComposerFooter={false}
            showImageButton={false}
            showAiSelector={false}
            showAutocorrectToggle={false}
            showMicButtons={false}
            composerSecondaryAction={(
              <button className="workspace-start-light-action" type="button" disabled={!canCreateSession} onClick={() => { if (canCreateSession) onCreateSession?.(); }}>
                New terminal
              </button>
            )}
          />
        </div>
      </div>
    </section>
  );
}
