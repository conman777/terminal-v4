const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  compactDisplay: 'short',
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

export function formatCurrency(num) {
  if (num == null || isNaN(num)) return '$--';
  return currencyFormatter.format(num);
}

export function formatCompactCurrency(num) {
  if (num == null || isNaN(num)) return '$--';
  return compactFormatter.format(num);
}

export function formatPercent(num) {
  if (num == null || isNaN(num)) return '--%';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

export function formatDate(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatFullDate(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export function formatChartDate(timestamp, days) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (days <= 1) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (days <= 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', hour12: true });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatAxisPrice(num) {
  if (num == null) return '';
  if (num >= 1000) {
    return `$${(num / 1000).toFixed(1)}K`;
  }
  return `$${num.toFixed(0)}`;
}
