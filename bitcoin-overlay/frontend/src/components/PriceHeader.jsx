import React from 'react';
import { formatCurrency, formatCompactCurrency, formatPercent, formatDate } from '../utils/formatters';

export default function PriceHeader({ price }) {
  if (!price) {
    return (
      <header className="price-header">
        <div className="price-header__label">
          <span className="price-header__icon">&#8383;</span>
          <span>Bitcoin</span>
          <span className="price-header__ticker">BTC</span>
        </div>
        <div className="price-header__value skeleton-text" style={{ width: 220, height: 48 }} />
        <div className="price-header__meta">
          <span className="skeleton-text" style={{ width: 80, height: 18 }} />
          <span className="skeleton-text" style={{ width: 120, height: 18 }} />
        </div>
      </header>
    );
  }

  const isPositive = price.change24h >= 0;

  return (
    <header className="price-header">
      <div className="price-header__label">
        <span className="price-header__icon">&#8383;</span>
        <span>Bitcoin</span>
        <span className="price-header__ticker">BTC</span>
      </div>
      <div className="price-header__value">{formatCurrency(price.price)}</div>
      <div className="price-header__meta">
        <span className={`price-header__change ${isPositive ? 'bullish' : 'bearish'}`}>
          <span className="price-header__arrow">{isPositive ? '\u25B2' : '\u25BC'}</span>
          {formatPercent(price.change24h)}
        </span>
        <span className="price-header__sep">&middot;</span>
        <span className="price-header__mcap">
          MCap {formatCompactCurrency(price.marketCap)}
        </span>
        <span className="price-header__sep">&middot;</span>
        <span className="price-header__updated">
          {formatDate(price.lastUpdated)}
        </span>
      </div>
    </header>
  );
}
