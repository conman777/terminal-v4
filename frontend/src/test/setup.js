import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
global.matchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {}
});

// Mock visualViewport
global.window.visualViewport = {
  height: 768,
  width: 1024,
  addEventListener: () => {},
  removeEventListener: () => {}
};
