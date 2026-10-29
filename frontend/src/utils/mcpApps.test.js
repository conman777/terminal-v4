import { describe, expect, it } from 'vitest';
import { MCP_APP_PROXY_URL, mcpAppDocument, mcpAppHtmlMime, mcpAppLink, mcpAppMessage, mcpAppResourceUri } from './mcpApps';

describe('mcpAppHtmlMime', () => {
  it.each(['text/html;profile=mcp-app', 'text/html; profile="mcp-app"; charset=utf-8', 'TEXT/HTML; charset=utf-8; PROFILE = mcp-app', 'text/html+mcp', ' TEXT/HTML+MCP '])('accepts backend-supported %s', mime => {
    expect(mcpAppHtmlMime(mime)).toBe(true);
  });
  it.each([null, {}, 'text/html', 'text/html;profile=other', 'text/html;profile=MCP-APP', 'text/html+mcp; charset=utf-8', 'application/xhtml+xml;profile=mcp-app', 'text/html;pro file=mcp-app', 'text/html;profile=mcp- app'])('rejects unsupported %s', mime => {
    expect(mcpAppHtmlMime(mime)).toBe(false);
  });
});

describe('MCP Apps host policy', () => {
  it('recognizes modern and legacy UI metadata without treating external URLs as app resources', () => {
    expect(mcpAppResourceUri({ _meta: { ui: { resourceUri: 'ui://fixture/view' } } })).toBe('ui://fixture/view');
    expect(mcpAppResourceUri({ _meta: { 'ui/resourceUri': 'ui://fixture/legacy' } })).toBe('ui://fixture/legacy');
    expect(mcpAppResourceUri({ _meta: { ui: { resourceUri: 'https://fixture.example.test/view' } } })).toBeNull();
  });
  it('places a restrictive CSP before any untrusted HTML without granting same-origin or network access', () => {
    const html = mcpAppDocument('<script>window.fixture = true</script><img src="https://untrusted.example.test/image">');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('window.fixture'));
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).not.toContain('allow-same-origin');
    expect(() => mcpAppDocument('x'.repeat(512 * 1024 + 1))).toThrow(/limit/);
  });
  it('isolates the trusted proxy and refuses sandbox control messages from the untrusted view', () => {
    expect(MCP_APP_PROXY_URL).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    const html = atob(MCP_APP_PROXY_URL.split(',')[1]);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain("event.source===view.contentWindow&&event.origin==='null'&&!reserved(data.method)");
    expect(html).toContain("event.source===parent");
    expect(html).toContain("frame-src 'none'");
    expect(html).not.toContain('terminal_access_token');
  });
  it.each(['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,unsafe', 'https://user:secret@example.test'])('rejects privileged or credential-bearing link requests %s', (value) => {
    expect(mcpAppLink(value)).toBeNull();
  });
  it('validates bounded JSON-RPC request IDs and messages', () => {
    expect(mcpAppMessage({ jsonrpc: '2.0', id: 0, method: 'ping' })).toMatchObject({ id: 0, hasId: true });
    expect(mcpAppMessage({ jsonrpc: '2.0', id: null, method: 'ping' })).toBeNull();
    expect(mcpAppMessage({ jsonrpc: '2.0', method: 'ping', params: { text: 'x'.repeat(65536) } })).toBeNull();
    expect(mcpAppMessage({ method: 'ping' })).toBeNull();
  });
});
