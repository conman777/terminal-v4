import { TerminalPane } from './TerminalPane';

const MAX_PANES = 4;

export function SplitPaneContainer({
  layout,
  sessions,
  onPaneSessionSelect,
  onPaneSplit,
  onPaneClose,
  onPaneFocus,
  onPaneFullscreen,
  fullscreenPaneId,
  showPreview,
  onMinimizeMainTerminal,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  sessionActivity,
  projectInfo
}) {
  const { type, panes, activePaneId } = layout;
  const canSplit = panes.length < MAX_PANES;

  // When in fullscreen mode, only render the fullscreen pane
  const panesToRender = fullscreenPaneId
    ? panes.filter(p => p.id === fullscreenPaneId)
    : panes;

  return (
    <div className={`split-pane-container ${fullscreenPaneId ? 'fullscreen' : type}`}>
      {panesToRender.map((pane) => (
        <TerminalPane
          key={pane.id}
          pane={pane}
          isActive={pane.id === activePaneId}
          isFullscreen={pane.id === fullscreenPaneId}
          sessions={sessions}
          canSplit={canSplit}
          canClose={panes.length > 1}
          onSessionSelect={onPaneSessionSelect}
          onSplit={onPaneSplit}
          onClose={onPaneClose}
          onFocus={onPaneFocus}
          onFullscreen={onPaneFullscreen}
          showPreview={showPreview}
          onMinimizeMainTerminal={onMinimizeMainTerminal}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          sessionActivity={sessionActivity}
          projectInfo={projectInfo}
        />
      ))}
    </div>
  );
}
