import { TerminalPane } from './TerminalPane';

const MAX_PANES = 8;

// Recursive component to render the layout tree
function LayoutNode({
  node,
  sessions,
  activePaneId,
  canSplit,
  onPaneSessionSelect,
  onPaneSplit,
  onPaneClose,
  onPaneFocus,
  onPaneFullscreen,
  showPreview,
  onMinimizeMainTerminal,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  sessionActivity,
  projectInfo,
  paneCount
}) {
  if (!node) return null;

  // Render a pane
  if (node.type === 'pane') {
    return (
      <TerminalPane
        pane={node}
        isActive={node.id === activePaneId}
        isFullscreen={false}
        sessions={sessions}
        canSplit={canSplit}
        canClose={paneCount > 1}
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
    );
  }

  // Render a split container
  if (node.type === 'split') {
    const isHorizontal = node.direction === 'horizontal';
    const style = {
      display: 'flex',
      flexDirection: isHorizontal ? 'row' : 'column',
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      gap: '2px'
    };

    return (
      <div className="split-container" style={style}>
        {node.children.map((child, index) => (
          <LayoutNode
            key={child.type === 'pane' ? child.id : `split-${index}`}
            node={child}
            sessions={sessions}
            activePaneId={activePaneId}
            canSplit={canSplit}
            onPaneSessionSelect={onPaneSessionSelect}
            onPaneSplit={onPaneSplit}
            onPaneClose={onPaneClose}
            onPaneFocus={onPaneFocus}
            onPaneFullscreen={onPaneFullscreen}
            showPreview={showPreview}
            onMinimizeMainTerminal={onMinimizeMainTerminal}
            keybarOpen={keybarOpen}
            viewportHeight={viewportHeight}
            onUrlDetected={onUrlDetected}
            fontSize={fontSize}
            sessionActivity={sessionActivity}
            projectInfo={projectInfo}
            paneCount={paneCount}
          />
        ))}
      </div>
    );
  }

  return null;
}

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
  projectInfo,
  paneLayout
}) {
  // Use tree-based layout if available, fall back to legacy
  const root = paneLayout?.root;
  const activePaneId = paneLayout?.activePaneId || layout?.activePaneId;

  // Count panes for canSplit check
  const countPanes = (node) => {
    if (!node) return 0;
    if (node.type === 'pane') return 1;
    return node.children.reduce((sum, child) => sum + countPanes(child), 0);
  };

  const paneCount = root ? countPanes(root) : (layout?.panes?.length || 1);
  const canSplit = paneCount < MAX_PANES;

  // When in fullscreen mode, only render the fullscreen pane
  if (fullscreenPaneId && root) {
    // Find the fullscreen pane in the tree
    const findPane = (node) => {
      if (!node) return null;
      if (node.type === 'pane' && node.id === fullscreenPaneId) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findPane(child);
          if (found) return found;
        }
      }
      return null;
    };

    const fullscreenPane = findPane(root);
    if (fullscreenPane) {
      return (
        <div className="split-pane-container fullscreen">
          <TerminalPane
            pane={fullscreenPane}
            isActive={true}
            isFullscreen={true}
            sessions={sessions}
            canSplit={canSplit}
            canClose={paneCount > 1}
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
        </div>
      );
    }
  }

  // Render tree-based layout
  if (root) {
    return (
      <div className="split-pane-container tree-layout">
        <LayoutNode
          node={root}
          sessions={sessions}
          activePaneId={activePaneId}
          canSplit={canSplit}
          onPaneSessionSelect={onPaneSessionSelect}
          onPaneSplit={onPaneSplit}
          onPaneClose={onPaneClose}
          onPaneFocus={onPaneFocus}
          onPaneFullscreen={onPaneFullscreen}
          showPreview={showPreview}
          onMinimizeMainTerminal={onMinimizeMainTerminal}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          sessionActivity={sessionActivity}
          projectInfo={projectInfo}
          paneCount={paneCount}
        />
      </div>
    );
  }

  // Fallback to legacy rendering (shouldn't happen with new code)
  const { type, panes } = layout;
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
