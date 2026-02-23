import React from 'react';

const SIZES = {
  sm: 16,
  md: 24,
  lg: 40,
};

export default function LoadingSpinner({ size = 'md' }) {
  const px = SIZES[size] || SIZES.md;
  return (
    <span
      className="spinner"
      style={{ width: px, height: px }}
      role="status"
      aria-label="Loading"
    />
  );
}
