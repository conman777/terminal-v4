import React, { useEffect, useRef, useState } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { formatDate } from '../utils/formatters';
import { saveApiKey } from '../utils/api';

const DIRECTION_ICONS = {
  up: { arrow: '\u2191', className: 'bullish' },
  down: { arrow: '\u2193', className: 'bearish' },
  sideways: { arrow: '\u2192', className: 'neutral' },
};

const SKELETON_WIDTHS = [85, 100, 72, 95, 68];

function SkeletonBlock({ lines = 3 }) {
  return (
    <div className="skeleton-block">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton-text"
          style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%`, height: 14, marginBottom: 8 }}
        />
      ))}
    </div>
  );
}

function PredictionCard({ prediction }) {
  const dir = DIRECTION_ICONS[prediction.direction] || DIRECTION_ICONS.sideways;
  const confidence = Math.max(0, Math.min(100, prediction.confidence));

  return (
    <div className="prediction-card">
      <div className="prediction-card__header">
        <span className="prediction-card__timeframe">{prediction.timeframe}</span>
        <span className={`prediction-card__arrow ${dir.className}`}>{dir.arrow}</span>
      </div>
      <div className="prediction-card__bar-track">
        <div
          className={`prediction-card__bar-fill ${dir.className}`}
          style={{ width: `${confidence}%` }}
        />
      </div>
      <div className="prediction-card__confidence">{confidence}% confidence</div>
      <div className="prediction-card__reasoning">{prediction.reasoning}</div>
    </div>
  );
}

const TYPE_LABELS = {
  bullish: 'Bullish',
  bearish: 'Bearish',
  neutral: 'Neutral',
};

function EventCard({ annotation, isActive }) {

  return (
    <div
      className={`event-card ${isActive ? 'event-card--active' : ''}`}
      data-timestamp={annotation.timestamp}
    >
      <div className="event-card__header">
        <span className={`event-card__type ${annotation.type}`}>
          {TYPE_LABELS[annotation.type] || 'Event'}
        </span>
        <span className="event-card__date">{formatDate(annotation.timestamp)}</span>
      </div>
      <div className="event-card__label">{annotation.label}</div>
      <div className="event-card__explanation">{annotation.explanation}</div>
    </div>
  );
}

function ApiKeySetup({ onSaved }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await saveApiKey(key.trim());
      onSaved();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="api-key-setup">
      <div className="api-key-setup__icon">🔑</div>
      <h3 className="api-key-setup__title">OpenRouter API Key Required</h3>
      <p className="api-key-setup__desc">
        Enter your <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">OpenRouter API key</a> to enable AI-powered analysis.
      </p>
      <form onSubmit={handleSubmit} className="api-key-setup__form">
        <input
          type="password"
          className="api-key-setup__input"
          placeholder="sk-or-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        <button type="submit" className="api-key-setup__btn" disabled={saving || !key.trim()}>
          {saving ? <LoadingSpinner size="sm" /> : 'Save & Analyze'}
        </button>
      </form>
      {err && <p className="api-key-setup__error">{err}</p>}
    </div>
  );
}

export default function AnalysisPanel({ analysis, loading, error, onRefresh, activeAnnotation, hasApiKey, onApiKeySaved }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!activeAnnotation || !panelRef.current) return;
    const target = Array.from(
      panelRef.current.querySelectorAll('[data-timestamp]')
    ).find(el => el.dataset.timestamp === String(activeAnnotation.timestamp));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('event-card--highlight');
      const timer = setTimeout(() => target.classList.remove('event-card--highlight'), 1500);
      return () => clearTimeout(timer);
    }
  }, [activeAnnotation]);

  return (
    <aside className="analysis-panel" ref={panelRef}>
      <div className="analysis-panel__header">
        <h2 className="analysis-panel__title">AI Analysis</h2>
        <button
          className="analysis-panel__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh analysis"
        >
          {loading ? <LoadingSpinner size="sm" /> : '\u21BB'}
        </button>
      </div>

      {error && (
        <div className="analysis-panel__error">
          <p>{error}</p>
          <button onClick={onRefresh} className="retry-btn">Retry</button>
        </div>
      )}

      {!hasApiKey && (
        <ApiKeySetup onSaved={onApiKeySaved} />
      )}

      {hasApiKey && loading && !analysis ? (
        <div className="analysis-panel__skeleton">
          <div className="analysis-section">
            <h3 className="analysis-section__title">Summary</h3>
            <SkeletonBlock lines={3} />
          </div>
          <div className="analysis-section">
            <h3 className="analysis-section__title">Current Analysis</h3>
            <SkeletonBlock lines={5} />
          </div>
          <div className="analysis-section">
            <h3 className="analysis-section__title">Predictions</h3>
            <SkeletonBlock lines={4} />
            <SkeletonBlock lines={4} />
            <SkeletonBlock lines={4} />
          </div>
        </div>
      ) : hasApiKey && analysis ? (
        <>
          <div className="analysis-section">
            <h3 className="analysis-section__title">Summary</h3>
            <div className="analysis-card">
              <p>{analysis.summary}</p>
            </div>
          </div>

          <div className="analysis-section">
            <h3 className="analysis-section__title">Current Analysis</h3>
            <div className="analysis-card">
              <p>{analysis.currentAnalysis}</p>
            </div>
          </div>

          {analysis.predictions && analysis.predictions.length > 0 && (
            <div className="analysis-section">
              <h3 className="analysis-section__title">Predictions</h3>
              <div className="predictions-grid">
                {analysis.predictions.map((pred) => (
                  <PredictionCard key={pred.timeframe} prediction={pred} />
                ))}
              </div>
            </div>
          )}

          {analysis.keyFactors && analysis.keyFactors.length > 0 && (
            <div className="analysis-section">
              <h3 className="analysis-section__title">Key Factors</h3>
              <ul className="key-factors">
                {analysis.keyFactors.map((factor, idx) => (
                  <li key={idx} className="key-factor">{factor}</li>
                ))}
              </ul>
            </div>
          )}

          {analysis.annotations && analysis.annotations.length > 0 && (
            <div className="analysis-section">
              <h3 className="analysis-section__title">Significant Events</h3>
              <div className="events-list">
                {analysis.annotations.map((ann, idx) => (
                  <EventCard
                    key={`${ann.timestamp}-${idx}`}
                    annotation={ann}
                    isActive={activeAnnotation?.timestamp === ann.timestamp}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </aside>
  );
}
