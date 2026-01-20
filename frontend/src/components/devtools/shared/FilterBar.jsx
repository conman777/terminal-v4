import { useState } from 'react';

/**
 * FilterBar - Reusable filter component for DevTools tabs
 * Provides filter buttons and search input
 */
export function FilterBar({ filters, activeFilter, onFilterChange, searchValue, onSearchChange, placeholder = 'Search...' }) {
  return (
    <div className="devtools-filter-bar">
      <div className="devtools-filter-buttons">
        {filters.map(filter => (
          <button
            key={filter.value}
            className={`devtools-filter-btn ${activeFilter === filter.value ? 'active' : ''}`}
            onClick={() => onFilterChange(filter.value)}
            title={filter.tooltip}
          >
            {filter.icon && <span className="filter-icon">{filter.icon}</span>}
            <span>{filter.label}</span>
            {filter.count !== undefined && (
              <span className="filter-count">{filter.count}</span>
            )}
          </button>
        ))}
      </div>
      {onSearchChange && (
        <div className="devtools-search">
          <input
            type="text"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            className="devtools-search-input"
          />
          {searchValue && (
            <button
              className="devtools-search-clear"
              onClick={() => onSearchChange('')}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}
