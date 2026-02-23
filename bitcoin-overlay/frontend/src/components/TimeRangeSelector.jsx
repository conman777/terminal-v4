import React from 'react';

const RANGES = [
  { value: '1', label: '1D' },
  { value: '7', label: '7D' },
  { value: '30', label: '30D' },
  { value: '90', label: '90D' },
  { value: '365', label: '1Y' },
];

export default function TimeRangeSelector({ range, onChange }) {
  return (
    <div className="time-range-selector">
      {RANGES.map((r) => (
        <button
          key={r.value}
          className={`time-range-btn ${range === r.value ? 'time-range-btn--active' : ''}`}
          onClick={() => onChange(r.value)}
          aria-pressed={range === r.value}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
