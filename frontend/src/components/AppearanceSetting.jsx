import { useState } from 'react';
import { ACCENTS, DEFAULTS, applyAppearance, loadAppearance, saveAppearance } from '../utils/appearance';
import './AppearanceSetting.css';

const WIDTH_LABELS = { comfortable: 'Comfortable', wide: 'Wide', full: 'Full' };

export function AppearanceSetting() {
  const [appearance, setAppearance] = useState(loadAppearance);
  const update = change => {
    const next = { ...appearance, ...change };
    setAppearance(next); saveAppearance(next); applyAppearance(next);
  };
  return (
    <div className="form-group session-settings-field">
      <label>Appearance</label>
      <div className="appearance-setting-heading">
        <span>Accent colour</span>
        <button type="button" className="appearance-reset" disabled={appearance.accent === DEFAULTS.accent}
          onClick={() => update({ accent: DEFAULTS.accent })}>Reset accent colour</button>
      </div>
      <div className="mode-toggle" role="group" aria-label="Accent colour">
        {ACCENTS.map(accent => <button key={accent} type="button" className={`mode-btn appearance-accent appearance-accent-${accent} ${appearance.accent === accent ? 'active' : ''}`}
          aria-pressed={appearance.accent === accent} onClick={() => update({ accent })}>{accent[0].toUpperCase() + accent.slice(1)}</button>)}
      </div>
      <div className="appearance-setting-heading">
        <span>Conversation width</span>
        <button type="button" className="appearance-reset" disabled={appearance.width === DEFAULTS.width}
          onClick={() => update({ width: DEFAULTS.width })}>Reset conversation width</button>
      </div>
      <div className="mode-toggle" role="group" aria-label="Conversation width">
        {Object.keys(WIDTH_LABELS).map(width => <button key={width} type="button" className={`mode-btn ${appearance.width === width ? 'active' : ''}`}
          aria-pressed={appearance.width === width} onClick={() => update({ width })}>{WIDTH_LABELS[width]}</button>)}
      </div>
      <small>Accent colour for buttons and highlights, and how wide conversations can get.</small>
    </div>
  );
}
