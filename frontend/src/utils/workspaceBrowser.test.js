import { describe, expect, it } from 'vitest';
import { browserAddress, browserPoint } from './workspaceBrowser';

describe('browserAddress', () => {
  it.each([
    ['example.com/docs', 'https://example.com/docs'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['http://host.test:8080/path?q=kept', 'http://host.test:8080/path?q=kept'],
    ['browser documentation', 'https://www.google.com/search?q=browser%20documentation'],
  ])('opens %s with the expected address', (input, expected) => expect(browserAddress(input)).toBe(expected));
  it.each(['', 'file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com'])('rejects %s', input => expect(() => browserAddress(input)).toThrow());
});
describe('browserPoint', () => {
  it('maps a scaled viewport and excludes letterboxing', () => {
    const rect = { left: 10, top: 20, width: 640, height: 600 };
    expect([browserPoint(rect, 1280, 800, 330, 320), browserPoint(rect, 1280, 800, 330, 30)]).toEqual([{ x: 640, y: 400 }, null]);
  });
});
