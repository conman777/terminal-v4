import React from 'react';
import { formatCurrency, formatFullDate, formatCompactCurrency } from '../utils/formatters';

export default function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;

  const data = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__date">{formatFullDate(data.timestamp)}</div>
      <div className="chart-tooltip__price">{formatCurrency(data.price)}</div>
      {data.volume != null && (
        <div className="chart-tooltip__volume">
          Vol: {formatCompactCurrency(data.volume)}
        </div>
      )}
    </div>
  );
}
