import React from 'react';
import { formatCurrency, formatFullDate, formatCompactCurrency } from '../utils/formatters';

export default function ChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;

  const data = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__date">{formatFullDate(data.timestamp)}</div>
      <div className="chart-tooltip__row">
        <span className="chart-tooltip__label">Price</span>
        <span className="chart-tooltip__price">{formatCurrency(data.price)}</span>
      </div>
      {data.sma7 != null && (
        <div className="chart-tooltip__row">
          <span className="chart-tooltip__label" style={{ color: '#6366f1' }}>SMA 7</span>
          <span className="chart-tooltip__value">{formatCurrency(data.sma7)}</span>
        </div>
      )}
      {data.sma25 != null && (
        <div className="chart-tooltip__row">
          <span className="chart-tooltip__label" style={{ color: '#8b5cf6' }}>SMA 25</span>
          <span className="chart-tooltip__value">{formatCurrency(data.sma25)}</span>
        </div>
      )}
      {data.volume > 0 && (
        <div className="chart-tooltip__row">
          <span className="chart-tooltip__label">Volume</span>
          <span className="chart-tooltip__value">{formatCompactCurrency(data.volume)}</span>
        </div>
      )}
    </div>
  );
}
