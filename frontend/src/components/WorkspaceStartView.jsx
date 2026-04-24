import { useState } from 'react';
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
}) {
  const [composerValue, setComposerValue] = useState('');

  function handleSubmit(value) {
    const trimmed = typeof value === 'string' ? value.trim() : composerValue.trim();
    if (!trimmed) return;
    onSubmitPrompt?.(trimmed);
    setComposerValue('');
  }

  return (
    <section className="workspace-start-view" aria-label="Workspace start">
      <div className="workspace-start-shell">
        <div className="workspace-start-lightbar">
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

        <div className="workspace-start-composer-shell">
          <DesktopStatusBar
            sessionId="workspace-start"
            composerValue={composerValue}
            composerAttachments={[]}
            onComposerChange={setComposerValue}
            onComposerSubmit={handleSubmit}
            composerPlaceholder="Ask V4 anything"
            composerDisabled={false}
            showTopRow={false}
            showComposerFooter={false}
            showImageButton={false}
            showAiSelector={false}
            showAutocorrectToggle={false}
            showMicButtons={false}
            composerSecondaryAction={(
              <button className="workspace-start-light-action" type="button" onClick={() => onCreateSession?.()}>
                New terminal
              </button>
            )}
          />
        </div>
      </div>
    </section>
  );
}
