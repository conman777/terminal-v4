import { TerminalPane } from './TerminalPane';

const MAX_PANES = 4;

export function SplitPaneContainer({
  layout,
  sessions,
  onPaneSessionSelect,
  onPaneSplit,
  onPaneClose,
  onPaneFocus,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize
}) {
  const { type, panes, activePaneId } = layout;
  const canSplit = panes.length < MAX_PANES;

  return (
    <div className={`split-pane-container ${type}`}>
      {panes.map((pane, index) => (
        <TerminalPane
          key={pane.id}
          pane={pane}
          isActive={pane.id === activePaneId}
          sessions={sessions}
          canSplit={canSplit}
          canClose={panes.length > 1}
          onSessionSelect={onPaneSessionSelect}
          onSplit={onPaneSplit}
          onClose={onPaneClose}
          onFocus={onPaneFocus}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
        />
      ))}
    </div>
  );
}
