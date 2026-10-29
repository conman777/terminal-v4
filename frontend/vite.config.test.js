import { describe, expect, it, vi } from 'vitest';
vi.mock('vite', () => ({ defineConfig: value => value }));
import config from './vite.config';

describe('runner document response headers', () => {
  it.each(['/webcontainer', '/webcontainer/', '/webcontainer?cache=1'])('isolates only the exact runner document %s', path => {
    let middleware;
    const plugin = config.plugins.find(plugin => plugin.name === 'webcontainer-document-isolation');
    expect(plugin).toBeDefined();
    plugin.configureServer({ middlewares: { use: fn => { middleware = fn; } } });
    const headers = {};
    middleware({ url: path }, { setHeader: (key, value) => { headers[key] = value; } }, () => {});
    expect(headers).toMatchObject({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  });
  it.each(['/', '/preview/5173', '/api/environments/paired/proxy/preview/5173', '/webcontainer/other', '/webcontainer.js'])('does not isolate normal paths %s', path => {
    let middleware;
    const plugin = config.plugins.find(plugin => plugin.name === 'webcontainer-document-isolation');
    expect(plugin).toBeDefined();
    plugin.configureServer({ middlewares: { use: fn => { middleware = fn; } } });
    const headers = {};
    middleware({ url: path }, { setHeader: (key, value) => { headers[key] = value; } }, () => {});
    expect(headers).toEqual({});
  });
});

it('keeps no-store when Vite later assigns its default HTML cache policy', () => {
  let middleware;
  config.plugins.find(plugin => plugin.name === 'webcontainer-document-isolation').configureServer({ middlewares: { use: fn => { middleware = fn; } } });
  const headers = {};
  const response = { setHeader(key, value) { headers[key] = value; } };
  middleware({ url: '/webcontainer' }, response, () => response.setHeader('Cache-Control', 'no-cache'));
  expect(headers['Cache-Control']).toBe('no-store');
});
