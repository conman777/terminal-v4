import React from 'react';
import { formatCurrency, formatFullDate } from '../utils/formatters';

export default function ChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;

  const data = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__date">{formatFullDate(data.timestamp)}</div>
      <div className="chart-tooltip__price">{formatCurrency(data.price)}</div>
    </div>
  );
}
