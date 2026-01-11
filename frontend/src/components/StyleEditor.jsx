import { useState, useCallback, useEffect, useRef } from 'react';

// Color picker with hex/rgb support
function ColorControl({ label, value, onChange }) {
  const [inputValue, setInputValue] = useState(value || '');
  const colorRef = useRef(null);

  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  const handleColorChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    onChange(newValue);
  };

  const handleTextChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    // Only call onChange for valid colors
    if (newValue.match(/^#[0-9a-fA-F]{6}$/) || newValue.match(/^rgb/)) {
      onChange(newValue);
    }
  };

  // Convert rgb to hex for color picker
  const hexValue = (() => {
    if (!value) return '#000000';
    if (value.startsWith('#')) return value;
    const match = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const [, r, g, b] = match;
      return '#' + [r, g, b].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    }
    return '#000000';
  })();

  return (
    <div className="style-control style-control-color">
      <label>{label}</label>
      <div className="style-color-input">
        <input
          ref={colorRef}
          type="color"
          value={hexValue}
          onChange={handleColorChange}
          className="style-color-picker"
        />
        <input
          type="text"
          value={inputValue}
          onChange={handleTextChange}
          placeholder="#000000"
          className="style-color-text"
        />
      </div>
    </div>
  );
}

// Dimension slider with unit support
function DimensionControl({ label, value, onChange, min = 0, max = 500, unit = 'px' }) {
  const numericValue = parseInt(value) || 0;

  return (
    <div className="style-control style-control-dimension">
      <label>{label}</label>
      <div className="style-dimension-input">
        <input
          type="range"
          min={min}
          max={max}
          value={numericValue}
          onChange={(e) => onChange(e.target.value + unit)}
          className="style-dimension-slider"
        />
        <input
          type="number"
          value={numericValue}
          onChange={(e) => onChange(e.target.value + unit)}
          className="style-dimension-number"
        />
        <span className="style-dimension-unit">{unit}</span>
      </div>
    </div>
  );
}

// Spacing control (margin/padding)
function SpacingControl({ label, value, onChange }) {
  // Parse value like "10px 20px" or "10px"
  const parts = (value || '0px').split(' ').map(v => parseInt(v) || 0);
  const [top, right, bottom, left] = parts.length === 1
    ? [parts[0], parts[0], parts[0], parts[0]]
    : parts.length === 2
    ? [parts[0], parts[1], parts[0], parts[1]]
    : parts.length === 4
    ? parts
    : [0, 0, 0, 0];

  const handleChange = (pos, val) => {
    const values = [top, right, bottom, left];
    values[pos] = parseInt(val) || 0;
    // Simplify if all same
    if (values.every(v => v === values[0])) {
      onChange(values[0] + 'px');
    } else if (values[0] === values[2] && values[1] === values[3]) {
      onChange(`${values[0]}px ${values[1]}px`);
    } else {
      onChange(values.map(v => v + 'px').join(' '));
    }
  };

  return (
    <div className="style-control style-control-spacing">
      <label>{label}</label>
      <div className="style-spacing-box">
        <input
          type="number"
          value={top}
          onChange={(e) => handleChange(0, e.target.value)}
          className="style-spacing-input top"
          placeholder="T"
        />
        <input
          type="number"
          value={right}
          onChange={(e) => handleChange(1, e.target.value)}
          className="style-spacing-input right"
          placeholder="R"
        />
        <input
          type="number"
          value={bottom}
          onChange={(e) => handleChange(2, e.target.value)}
          className="style-spacing-input bottom"
          placeholder="B"
        />
        <input
          type="number"
          value={left}
          onChange={(e) => handleChange(3, e.target.value)}
          className="style-spacing-input left"
          placeholder="L"
        />
        <div className="style-spacing-center">px</div>
      </div>
    </div>
  );
}

// Select control for predefined options
function SelectControl({ label, value, options, onChange }) {
  return (
    <div className="style-control style-control-select">
      <label>{label}</label>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

// Font size control
function FontSizeControl({ value, onChange }) {
  const numericValue = parseInt(value) || 16;

  return (
    <div className="style-control style-control-fontsize">
      <label>Font Size</label>
      <div className="style-fontsize-input">
        <button
          type="button"
          onClick={() => onChange((numericValue - 1) + 'px')}
          className="style-fontsize-btn"
        >
          -
        </button>
        <input
          type="number"
          value={numericValue}
          onChange={(e) => onChange(e.target.value + 'px')}
          className="style-fontsize-number"
        />
        <span className="style-fontsize-unit">px</span>
        <button
          type="button"
          onClick={() => onChange((numericValue + 1) + 'px')}
          className="style-fontsize-btn"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Main StyleEditor component
export function StyleEditor({
  element,
  onStyleChange,
  onApply,
  onRevert,
  isMobile = false
}) {
  const [activeTab, setActiveTab] = useState('layout');
  const [pendingStyles, setPendingStyles] = useState({});
  const [hasChanges, setHasChanges] = useState(false);

  // Get current styles from element
  const currentStyles = element?.extendedStyles || element?.computedStyle || {};

  // Handle style change - update pending and send preview
  const handleStyleChange = useCallback((prop, value) => {
    setPendingStyles(prev => {
      const next = { ...prev, [prop]: value };
      setHasChanges(true);
      // Send preview to iframe
      if (onStyleChange) {
        onStyleChange(next);
      }
      return next;
    });
  }, [onStyleChange]);

  // Get effective value (pending or current)
  const getValue = (prop) => {
    return pendingStyles[prop] !== undefined ? pendingStyles[prop] : currentStyles[prop];
  };

  // Handle apply
  const handleApply = useCallback(() => {
    if (onApply && hasChanges) {
      onApply(pendingStyles);
      setPendingStyles({});
      setHasChanges(false);
    }
  }, [onApply, pendingStyles, hasChanges]);

  // Handle revert
  const handleRevert = useCallback(() => {
    setPendingStyles({});
    setHasChanges(false);
    if (onRevert) {
      onRevert();
    }
  }, [onRevert]);

  // Reset when element changes
  useEffect(() => {
    setPendingStyles({});
    setHasChanges(false);
  }, [element?.elementId]);

  if (!element) return null;

  const tabs = [
    { id: 'layout', label: 'Layout' },
    { id: 'spacing', label: 'Spacing' },
    { id: 'typography', label: 'Type' },
    { id: 'colors', label: 'Colors' },
  ];

  return (
    <div className={`style-editor ${isMobile ? 'style-editor-mobile' : ''}`}>
      <div className="style-editor-header">
        <span className="style-editor-title">Style Editor</span>
        {hasChanges && (
          <span className="style-editor-badge">Modified</span>
        )}
      </div>

      <div className="style-editor-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`style-editor-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="style-editor-content">
        {activeTab === 'layout' && (
          <div className="style-editor-section">
            <SelectControl
              label="Display"
              value={getValue('display')}
              options={[
                { value: 'block', label: 'Block' },
                { value: 'flex', label: 'Flex' },
                { value: 'grid', label: 'Grid' },
                { value: 'inline', label: 'Inline' },
                { value: 'inline-block', label: 'Inline Block' },
                { value: 'none', label: 'None' },
              ]}
              onChange={(v) => handleStyleChange('display', v)}
            />
            <SelectControl
              label="Position"
              value={getValue('position')}
              options={[
                { value: 'static', label: 'Static' },
                { value: 'relative', label: 'Relative' },
                { value: 'absolute', label: 'Absolute' },
                { value: 'fixed', label: 'Fixed' },
                { value: 'sticky', label: 'Sticky' },
              ]}
              onChange={(v) => handleStyleChange('position', v)}
            />
            <DimensionControl
              label="Width"
              value={getValue('width')}
              max={1000}
              onChange={(v) => handleStyleChange('width', v)}
            />
            <DimensionControl
              label="Height"
              value={getValue('height')}
              max={1000}
              onChange={(v) => handleStyleChange('height', v)}
            />
            {getValue('display') === 'flex' && (
              <>
                <SelectControl
                  label="Flex Direction"
                  value={getValue('flexDirection')}
                  options={[
                    { value: 'row', label: 'Row' },
                    { value: 'column', label: 'Column' },
                    { value: 'row-reverse', label: 'Row Reverse' },
                    { value: 'column-reverse', label: 'Column Reverse' },
                  ]}
                  onChange={(v) => handleStyleChange('flexDirection', v)}
                />
                <SelectControl
                  label="Justify Content"
                  value={getValue('justifyContent')}
                  options={[
                    { value: 'flex-start', label: 'Start' },
                    { value: 'center', label: 'Center' },
                    { value: 'flex-end', label: 'End' },
                    { value: 'space-between', label: 'Space Between' },
                    { value: 'space-around', label: 'Space Around' },
                  ]}
                  onChange={(v) => handleStyleChange('justifyContent', v)}
                />
                <SelectControl
                  label="Align Items"
                  value={getValue('alignItems')}
                  options={[
                    { value: 'stretch', label: 'Stretch' },
                    { value: 'flex-start', label: 'Start' },
                    { value: 'center', label: 'Center' },
                    { value: 'flex-end', label: 'End' },
                  ]}
                  onChange={(v) => handleStyleChange('alignItems', v)}
                />
                <DimensionControl
                  label="Gap"
                  value={getValue('gap')}
                  max={100}
                  onChange={(v) => handleStyleChange('gap', v)}
                />
              </>
            )}
          </div>
        )}

        {activeTab === 'spacing' && (
          <div className="style-editor-section">
            <SpacingControl
              label="Padding"
              value={getValue('padding')}
              onChange={(v) => handleStyleChange('padding', v)}
            />
            <SpacingControl
              label="Margin"
              value={getValue('margin')}
              onChange={(v) => handleStyleChange('margin', v)}
            />
            <DimensionControl
              label="Border Radius"
              value={getValue('borderRadius')}
              max={100}
              onChange={(v) => handleStyleChange('borderRadius', v)}
            />
          </div>
        )}

        {activeTab === 'typography' && (
          <div className="style-editor-section">
            <FontSizeControl
              value={getValue('fontSize')}
              onChange={(v) => handleStyleChange('fontSize', v)}
            />
            <SelectControl
              label="Font Weight"
              value={getValue('fontWeight')}
              options={[
                { value: '100', label: 'Thin' },
                { value: '300', label: 'Light' },
                { value: '400', label: 'Normal' },
                { value: '500', label: 'Medium' },
                { value: '600', label: 'Semi Bold' },
                { value: '700', label: 'Bold' },
                { value: '900', label: 'Black' },
              ]}
              onChange={(v) => handleStyleChange('fontWeight', v)}
            />
            <SelectControl
              label="Text Align"
              value={getValue('textAlign')}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
                { value: 'justify', label: 'Justify' },
              ]}
              onChange={(v) => handleStyleChange('textAlign', v)}
            />
            <DimensionControl
              label="Line Height"
              value={getValue('lineHeight')}
              min={10}
              max={50}
              onChange={(v) => handleStyleChange('lineHeight', v)}
            />
          </div>
        )}

        {activeTab === 'colors' && (
          <div className="style-editor-section">
            <ColorControl
              label="Text Color"
              value={getValue('color')}
              onChange={(v) => handleStyleChange('color', v)}
            />
            <ColorControl
              label="Background"
              value={getValue('backgroundColor')}
              onChange={(v) => handleStyleChange('backgroundColor', v)}
            />
            <DimensionControl
              label="Opacity"
              value={Math.round(parseFloat(getValue('opacity') || 1) * 100) + '%'}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => handleStyleChange('opacity', String(parseInt(v) / 100))}
            />
          </div>
        )}
      </div>

      {hasChanges && (
        <div className="style-editor-actions">
          <button
            type="button"
            className="style-editor-btn style-editor-btn-revert"
            onClick={handleRevert}
          >
            Revert
          </button>
          <button
            type="button"
            className="style-editor-btn style-editor-btn-apply"
            onClick={handleApply}
          >
            Apply with Claude
          </button>
        </div>
      )}
    </div>
  );
}
