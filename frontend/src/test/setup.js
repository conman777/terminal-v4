import '@testing-library/jest-dom';

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
