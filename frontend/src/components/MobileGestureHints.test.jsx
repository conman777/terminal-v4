import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MobileGestureHints } from './MobileGestureHints';

describe('MobileGestureHints', () => {
  beforeEach(() => {
    localStorage.removeItem('gestureHintsSeen');
  });

  it('shows the first-run gesture sheet when no marker exists', () => {
    render(<MobileGestureHints />);
    expect(screen.getByRole('dialog', { name: /mobile gesture tips/i })).toBeInTheDocument();
    expect(screen.getByText('Mobile gestures')).toBeInTheDocument();
  });

  it('dismisses and persists the seen marker', () => {
    render(<MobileGestureHints />);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    expect(screen.queryByRole('dialog', { name: /mobile gesture tips/i })).not.toBeInTheDocument();
    expect(localStorage.getItem('gestureHintsSeen')).toBe('1');
  });
});

