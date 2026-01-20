import React from 'react';

/**
 * MetricCard Component
 *
 * Displays a metric with its value and optional subtext/status
 */
export function MetricCard({ label, value, unit, status, subtext, className = '' }) {
  const getStatusColor = () => {
    switch (status) {
      case 'good':
        return 'text-green-600';
      case 'warning':
        return 'text-yellow-600';
      case 'error':
        return 'text-red-600';
      default:
        return 'text-gray-900';
    }
  };

  const formatValue = () => {
    if (value === null || value === undefined) {
      return '-';
    }
    return value;
  };

  return (
    <div className={`bg-white rounded-lg border border-gray-200 p-4 ${className}`}>
      <div className="text-sm font-medium text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${getStatusColor()}`}>
        {formatValue()}
        {unit && <span className="text-lg ml-1">{unit}</span>}
      </div>
      {subtext && <div className="text-xs text-gray-500 mt-1">{subtext}</div>}
    </div>
  );
}
