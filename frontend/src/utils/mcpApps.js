export const MCP_APP_PROTOCOL = '2026-01-26';
export const MCP_APP_MAX_HTML = 512 * 1024;
export const MCP_APP_MAX_REQUEST = 64 * 1024;
export const MCP_APP_MAX_PENDING = 8;
export const MCP_APP_METHODS = new Set(['tools/list', 'tools/call', 'resources/read', 'prompts/list', 'prompts/get']);
export const MCP_APP_DENIED_FEATURES = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; fullscreen 'none'";

export function mcpAppHtmlMime(mime) {
  if (typeof mime !== 'string') return false;
  const [type, ...parameters] = mime.split(';').map(part => part.trim());
  if (type.toLowerCase() === 'text/html+mcp') return parameters.length === 0;
  return type.toLowerCase() === 'text/html' && parameters.some(part => {
    const equals = part.indexOf('=');
    return equals !== -1 && part.slice(0, equals).trim().toLowerCase() === 'profile'
      && part.slice(equals + 1).trim().replace(/^"+|"+$/g, '') === 'mcp-app';
  });
}

export function mcpAppResourceUri(tool) {
  const value = tool?._meta?.ui?.resourceUri ?? tool?._meta?.['ui/resourceUri'];
  return typeof value === 'string' && value.startsWith('ui://') && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) ? value : null;
}

export function mcpAppDocument(html) {
  if (typeof html !== 'string' || new TextEncoder().encode(html).length > MCP_APP_MAX_HTML) throw new Error('MCP app HTML exceeds its limit.');
  const csp = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; webrtc 'block'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

export function mcpAppLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const target = new URL(value);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return null;
    return target.href;
  } catch { return null; }
}

export function mcpAppMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0') return null;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > MCP_APP_MAX_REQUEST) return null; } catch { return null; }
  const hasId = Object.hasOwn(value, 'id');
  if (hasId && !((typeof value.id === 'string' && value.id.length <= 128) || (Number.isSafeInteger(value.id)))) return null;
  if (typeof value.method !== 'string' || value.method.length > 128) return null;
  return { ...value, hasId };
}

const PROXY = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; webrtc 'block'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;display:block;background:transparent}</style></head><body><iframe id="view" title="MCP app view" sandbox="allow-scripts" allow="${MCP_APP_DENIED_FEATURES}" referrerpolicy="no-referrer"></iframe><script>(()=>{const view=document.getElementById('view');let loaded=false;const reserved=m=>typeof m==='string'&&m.startsWith('ui/notifications/sandbox-');addEventListener('message',event=>{const data=event.data;if(!data||typeof data!=='object'||data.jsonrpc!=='2.0')return;if(event.source===parent){if(data.method==='ui/notifications/sandbox-resource-ready'&&!loaded){if(typeof data.params?.html!=='string'||data.params.html.length>700000)return;loaded=true;view.srcdoc=data.params.html;return;}if(!reserved(data.method)&&loaded)view.contentWindow.postMessage(data,'*');}else if(event.source===view.contentWindow&&event.origin==='null'&&!reserved(data.method)){parent.postMessage(data,'*');}});parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},'*');})();</script></body></html>`;

export const MCP_APP_PROXY_URL = `data:text/html;charset=utf-8;base64,${btoa(PROXY)}`;
