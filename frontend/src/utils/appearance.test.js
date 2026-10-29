import { beforeEach, describe, expect, it } from 'vitest';
import { applyAppearance, loadAppearance, saveAppearance } from './appearance';

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-accent'); document.documentElement.style.removeProperty('--user-chat-width'); });

describe('appearance', () => {
  it('saves the accent and conversation width and applies them to the page', () => {
    const defaults = loadAppearance();
    saveAppearance({ accent: 'teal', width: 'wide' });
    applyAppearance(loadAppearance());
    expect([defaults, document.documentElement.dataset.accent, document.documentElement.style.getPropertyValue('--user-chat-width')])
      .toEqual([{ accent: 'indigo', width: 'comfortable' }, 'teal', '60rem']);
  });

  it('ignores unknown saved values', () => {
    localStorage.setItem('tv4Appearance', JSON.stringify({ accent: 'plaid', width: 'huge' }));
    expect(loadAppearance()).toEqual({ accent: 'indigo', width: 'comfortable' });
  });
});
