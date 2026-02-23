import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Brush,
  ReferenceDot,
} from 'recharts';
import ChartTooltip from './ChartTooltip';
import AnnotationDot from './AnnotationDot';
import { formatChartDate, formatAxisPrice } from '../utils/formatters';

export default function PriceChart({ chartData, annotations, onAnnotationClick, loading, timeRange }) {
  const prices = chartData?.prices || [];

  const validAnnotations = useMemo(() => {
    if (!annotations || !prices.length) return [];
    const timestamps = new Set(prices.map((p) => p.timestamp));
    return annotations.filter((a) => timestamps.has(a.timestamp));
  }, [annotations, prices]);

  const days = parseInt(timeRange, 10) || 30;

  if (loading && !prices.length) {
    return (
      <div className="chart-container chart-container--loading">
        <div className="chart-skeleton" />
      </div>
    );
  }

  if (!prices.length) {
    return (
      <div className="chart-container chart-container--empty">
        <p>No chart data available</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height={420}>
        <ComposedChart data={prices} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f7931a" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#f7931a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 6"
            stroke="rgba(42, 42, 62, 0.5)"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            tickFormatter={(ts) => formatChartDate(ts, days)}
            stroke="#555570"
            tick={{ fill: '#555570', fontSize: 11 }}
            axisLine={{ stroke: '#2a2a3e' }}
            tickLine={false}
            minTickGap={50}
          />
          <YAxis
            domain={['auto', 'auto']}
            tickFormatter={formatAxisPrice}
            stroke="#555570"
            tick={{ fill: '#555570', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={65}
          />
          <Tooltip content={<ChartTooltip />} />
          <Area
            type="monotone"
            dataKey="price"
            stroke="none"
            fill="url(#priceGradient)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="price"
            stroke="#f7931a"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#f7931a', stroke: '#0a0a0f', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Brush
            dataKey="timestamp"
            height={36}
            fill="#12121a"
            stroke="#2a2a3e"
            tickFormatter={(ts) => formatChartDate(ts, days)}
            travellerWidth={8}
          />
          {validAnnotations.map((annotation, idx) => (
            <ReferenceDot
              key={`${annotation.timestamp}-${idx}`}
              x={annotation.timestamp}
              y={annotation.price}
              shape={(props) => (
                <AnnotationDot
                  {...props}
                  annotation={annotation}
                  onClick={onAnnotationClick}
                />
              )}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
