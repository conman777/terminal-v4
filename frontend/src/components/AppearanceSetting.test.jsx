import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceSetting } from './AppearanceSetting';
import { loadAppearance } from '../utils/appearance';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('unrelated-setting', 'keep');
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.style.removeProperty('--user-chat-width');
});

describe('appearance resets', () => {
  it('resets each setting independently and persists it across remounts', () => {
    localStorage.setItem('tv4Appearance', JSON.stringify({ accent: 'teal', width: 'wide' }));
    const view = render(<AppearanceSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset accent colour' }));
    expect(loadAppearance()).toEqual({ accent: 'indigo', width: 'wide' });
    expect(document.documentElement.dataset.accent).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--user-chat-width')).toBe('60rem');
    expect(screen.getByRole('button', { name: 'Reset accent colour' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset conversation width' })).toBeEnabled();
    view.unmount();
    render(<AppearanceSetting />);
    expect(screen.getByRole('button', { name: 'Indigo' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Reset conversation width' }));
    expect(loadAppearance()).toEqual({ accent: 'indigo', width: 'comfortable' });
    expect(document.documentElement.style.getPropertyValue('--user-chat-width')).toBe('46rem');
    expect(localStorage.getItem('unrelated-setting')).toBe('keep');
    expect(screen.getByRole('button', { name: 'Reset conversation width' })).toBeDisabled();
  });

  it('resets width without changing a custom accent', () => {
    localStorage.setItem('tv4Appearance', JSON.stringify({ accent: 'rose', width: 'full' }));
    render(<AppearanceSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset conversation width' }));
    expect(loadAppearance()).toEqual({ accent: 'rose', width: 'comfortable' });
    expect(document.documentElement.dataset.accent).toBe('rose');
  });
});
