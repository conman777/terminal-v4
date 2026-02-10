import { StyleEditor } from '../StyleEditor';

export function PreviewInspector({
  selectedElement,
  elementPath,
  copyFeedback,
  showStyleEditor,
  onClearSelection,
  onCopyElementInfo,
  onCopyToTerminal,
  onStylePreview,
  onStyleApply,
  onStyleRevert,
  onSendToTerminal,
}) {
  if (!selectedElement) return null;

  return (
    <div className="preview-inspector">
      <div className="preview-inspector-header">
        <span className="preview-inspector-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
          </svg>
          Element Inspector
        </span>
        <button
          type="button"
          className="preview-inspector-close"
          onClick={onClearSelection}
          aria-label="Close inspector"
        >
          {'\u00D7'}
        </button>
      </div>

      {/* Breadcrumb Path */}
      {elementPath.length > 0 && (
        <div className="inspector-breadcrumb">
          {elementPath.map((item, index) => (
            <span key={index} className="breadcrumb-item">
              {index > 0 && <span className="breadcrumb-separator">›</span>}
              <button
                className="breadcrumb-btn"
                onClick={() => {
                  const newEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
                  item.element.dispatchEvent(newEvent);
                }}
                title={item.selector}
              >
                {item.tag}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="preview-inspector-content">
        <div className="preview-inspector-selector">
          <code>{selectedElement.selector}</code>
        </div>
        <div className="preview-inspector-section">
          <div className="preview-inspector-label">Element</div>
          <div className="preview-inspector-value">
            <span className="preview-inspector-tag">&lt;{selectedElement.tagName}</span>
            {selectedElement.id && <span className="preview-inspector-id">#{selectedElement.id}</span>}
            {selectedElement.className && (
              <span className="preview-inspector-class">
                .{selectedElement.className.split(' ').filter(c => c).join('.')}
              </span>
            )}
            <span className="preview-inspector-tag">&gt;</span>
          </div>
        </div>
        <div className="preview-inspector-section">
          <div className="preview-inspector-label">Dimensions</div>
          <div className="preview-inspector-value">
            {selectedElement.rect.width} × {selectedElement.rect.height}px
            <span className="preview-inspector-muted"> at ({selectedElement.rect.x}, {selectedElement.rect.y})</span>
          </div>
        </div>
        {Object.keys(selectedElement.attributes).length > 0 && (
          <div className="preview-inspector-section">
            <div className="preview-inspector-label">Attributes</div>
            <div className="preview-inspector-attrs">
              {Object.entries(selectedElement.attributes).map(([name, value]) => (
                <div key={name} className="preview-inspector-attr">
                  <span className="preview-inspector-attr-name">{name}</span>
                  <span className="preview-inspector-attr-value">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="preview-inspector-section">
          <div className="preview-inspector-label">Computed Styles</div>
          <div className="preview-inspector-styles">
            {Object.entries(selectedElement.computedStyle).map(([prop, value]) => (
              <div key={prop} className="preview-inspector-style">
                <span className="preview-inspector-style-prop">{prop}</span>
                <span className="preview-inspector-style-value">{value}</span>
              </div>
            ))}
          </div>
        </div>
        {selectedElement.textContent && (
          <div className="preview-inspector-section">
            <div className="preview-inspector-label">Text Content</div>
            <div className="preview-inspector-text">
              {selectedElement.textContent.length > 100
                ? selectedElement.textContent.substring(0, 100) + '...'
                : selectedElement.textContent}
            </div>
          </div>
        )}
        {/* React Component Info */}
        {selectedElement.react?.componentName && (
          <div className="preview-inspector-section preview-inspector-react">
            <div className="preview-inspector-label">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="2.5"/>
                <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(60 12 12)"/>
                <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(120 12 12)"/>
              </svg>
              React
            </div>
            <div className="preview-inspector-value">
              <span className="preview-inspector-component">&lt;{selectedElement.react.componentName}&gt;</span>
              {selectedElement.react.filePath && (
                <span className="preview-inspector-muted"> {selectedElement.react.filePath.replace(/\\/g, '/').split('/').pop()}</span>
              )}
            </div>
            {Object.keys(selectedElement.react.props || {}).length > 0 && (
              <div className="preview-inspector-props">
                {Object.entries(selectedElement.react.props).slice(0, 5).map(([name, value]) => (
                  <div key={name} className="preview-inspector-prop">
                    <span className="preview-inspector-prop-name">{name}</span>
                    <span className="preview-inspector-prop-value">
                      {typeof value === 'string' ? `"${value}"` : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Actions: Copy and Send to Terminal */}
      <div className="preview-inspector-actions">
        <div className="preview-inspector-btns">
          <button
            type="button"
            className={`preview-inspector-copy-btn${copyFeedback ? ' copied' : ''}`}
            onClick={onCopyElementInfo}
            title="Copy element info to clipboard"
          >
            {copyFeedback ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            )}
            {copyFeedback ? 'Copied!' : 'Copy'}
          </button>
          {onSendToTerminal && (
            <button
              type="button"
              className="preview-inspector-terminal-btn"
              onClick={onCopyToTerminal}
              title="Send element info to terminal"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Send to Terminal
            </button>
          )}
        </div>
      </div>
      {/* Style Editor Panel */}
      {showStyleEditor && selectedElement && (
        <StyleEditor
          element={selectedElement}
          onStyleChange={onStylePreview}
          onApply={onStyleApply}
          onRevert={onStyleRevert}
        />
      )}
    </div>
  );
}
