import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Brush,
  ReferenceDot,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import ChartTooltip from './ChartTooltip';
import AnnotationDot from './AnnotationDot';
import { formatChartDate, formatAxisPrice, formatCompactCurrency } from '../utils/formatters';

function computeSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += data[j].price;
      }
      result.push(Math.round((sum / period) * 100) / 100);
    }
  }
  return result;
}

export default function PriceChart({ chartData, annotations, onAnnotationClick, loading, timeRange, predictions = [] }) {
  const prices = chartData?.prices || [];
  const volumes = chartData?.volumes || [];

  const pendingPredictions = useMemo(
    () => predictions.filter((p) => p.status === 'pending'),
    [predictions],
  );

  const mergedData = useMemo(() => {
    if (!prices.length) return [];
    const sma7 = computeSMA(prices, 7);
    const sma25 = computeSMA(prices, 25);
    const volumeMap = new Map(volumes.map((v) => [v.timestamp, v.volume]));
    const historical = prices.map((p, i) => ({
      ...p,
      sma7: sma7[i],
      sma25: sma25[i],
      volume: volumeMap.get(p.timestamp) || 0,
    }));

    // Extend chart into the future if there are pending predictions
    if (pendingPredictions.length > 0) {
      const maxExpiry = Math.max(...pendingPredictions.map((p) => p.expiresAt));
      const now = prices[prices.length - 1].timestamp;
      const futureSpan = maxExpiry - now;
      // Add ~8 phantom points spread across the future range
      const step = futureSpan / 8;
      for (let i = 1; i <= 8; i++) {
        historical.push({
          timestamp: now + step * i,
          date: new Date(now + step * i).toISOString(),
          price: null,
          sma7: null,
          sma25: null,
          volume: 0,
        });
      }
    }

    return historical;
  }, [prices, volumes, pendingPredictions]);

  const validAnnotations = useMemo(() => {
    if (!annotations || !prices.length) return [];
    const timestamps = new Set(prices.map((p) => p.timestamp));
    return annotations.filter((a) => timestamps.has(a.timestamp));
  }, [annotations, prices]);

  const maxVolume = useMemo(() => {
    if (!mergedData.length) return 0;
    return Math.max(...mergedData.map((d) => d.volume || 0));
  }, [mergedData]);

  const nowTimestamp = useMemo(
    () => (prices.length ? prices[prices.length - 1].timestamp : 0),
    [prices],
  );

  const predictionZones = useMemo(() => {
    if (!predictions.length || !mergedData.length) return [];
    const dataStart = mergedData[0].timestamp;
    const dataEnd = mergedData[mergedData.length - 1].timestamp;
    return predictions
      .filter((p) => p.expiresAt > dataStart && p.createdAt <= dataEnd)
      .map((p) => ({
        x1: Math.max(p.createdAt, dataStart),
        x2: Math.min(p.expiresAt, dataEnd),
        fill: p.status === 'correct' ? '#10b981' : p.status === 'incorrect' ? '#fb3654' : '#f59e0b',
        opacity: p.status === 'pending' ? 0.1 : 0.08,
        key: `${p.createdAt}-${p.expiresAt}-${p.status}`,
      }));
  }, [predictions, mergedData]);

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
      <div className="chart-legend">
        <span className="chart-legend__item">
          <span className="chart-legend__swatch" style={{ background: '#f7931a' }} />
          Price
        </span>
        <span className="chart-legend__item">
          <span className="chart-legend__swatch chart-legend__swatch--dashed" style={{ background: '#6366f1' }} />
          SMA 7
        </span>
        <span className="chart-legend__item">
          <span className="chart-legend__swatch chart-legend__swatch--dashed" style={{ background: '#8b5cf6' }} />
          SMA 25
        </span>
        <span className="chart-legend__item">
          <span className="chart-legend__swatch chart-legend__swatch--bar" style={{ background: 'rgba(247,147,26,0.3)' }} />
          Volume
        </span>
        {predictionZones.length > 0 && (
          <>
            <span className="chart-legend__item">
              <span className="chart-legend__swatch chart-legend__swatch--bar" style={{ background: 'rgba(245,158,11,0.35)' }} />
              Pending
            </span>
            <span className="chart-legend__item">
              <span className="chart-legend__swatch chart-legend__swatch--bar" style={{ background: 'rgba(16,185,129,0.35)' }} />
              Correct
            </span>
            <span className="chart-legend__item">
              <span className="chart-legend__swatch chart-legend__swatch--bar" style={{ background: 'rgba(251,54,84,0.35)' }} />
              Incorrect
            </span>
          </>
        )}
      </div>
      <ResponsiveContainer width="100%" height={480}>
        <ComposedChart data={mergedData} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f7931a" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#f7931a" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f7931a" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#f7931a" stopOpacity={0.05} />
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
            yAxisId="price"
            domain={['auto', 'auto']}
            tickFormatter={formatAxisPrice}
            stroke="#555570"
            tick={{ fill: '#555570', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={65}
          />
          <YAxis
            yAxisId="volume"
            orientation="right"
            domain={[0, maxVolume * 4]}
            hide
          />
          <Tooltip content={<ChartTooltip />} />

          {/* Prediction zones behind everything */}
          {predictionZones.map((zone) => (
            <ReferenceArea
              key={zone.key}
              yAxisId="price"
              x1={zone.x1}
              x2={zone.x2}
              fill={zone.fill}
              fillOpacity={zone.opacity}
              strokeOpacity={0}
            />
          ))}

          {/* "Now" divider when predictions extend into the future */}
          {pendingPredictions.length > 0 && nowTimestamp > 0 && (
            <ReferenceLine
              x={nowTimestamp}
              yAxisId="price"
              stroke="#555570"
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: 'Now', position: 'top', fill: '#8888a0', fontSize: 10 }}
            />
          )}

          {/* Volume bars in background */}
          <Bar
            yAxisId="volume"
            dataKey="volume"
            fill="url(#volumeGradient)"
            isAnimationActive={false}
            barSize={mergedData.length > 200 ? 2 : 4}
          />

          {/* Price area fill */}
          <Area
            yAxisId="price"
            type="monotone"
            dataKey="price"
            stroke="none"
            fill="url(#priceGradient)"
            isAnimationActive={false}
          />

          {/* SMA 25 - longer period, more subtle */}
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="sma25"
            stroke="#8b5cf6"
            strokeWidth={1}
            strokeDasharray="6 3"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />

          {/* SMA 7 - shorter period */}
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="sma7"
            stroke="#6366f1"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />

          {/* Main price line */}
          <Line
            yAxisId="price"
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

          {/* Annotation dots with labels */}
          {validAnnotations.map((annotation, idx) => (
            <ReferenceDot
              key={`${annotation.timestamp}-${idx}`}
              x={annotation.timestamp}
              y={annotation.price}
              yAxisId="price"
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
