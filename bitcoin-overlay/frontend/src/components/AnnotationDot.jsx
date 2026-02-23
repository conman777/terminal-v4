import React from 'react';

const TYPE_COLORS = {
  bullish: '#10b981',
  bearish: '#fb3654',
  neutral: '#f59e0b',
};

export default function AnnotationDot({ cx, cy, annotation, onClick }) {
  if (cx == null || cy == null) return null;

  const color = TYPE_COLORS[annotation?.type] || TYPE_COLORS.neutral;

  return (
    <g
      className="annotation-dot"
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(annotation);
      }}
      style={{ cursor: 'pointer' }}
    >
      <circle
        cx={cx}
        cy={cy}
        r={12}
        fill={color}
        opacity={0.2}
        className="annotation-dot__pulse"
      />
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill={color}
        stroke="#0a0a0f"
        strokeWidth={2}
      />
    </g>
  );
}
