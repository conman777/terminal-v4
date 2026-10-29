import http from 'node:http';
import { pathToFileURL } from 'node:url';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function singleHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  return count === 1 && typeof request.headers[name] === 'string' ? request.headers[name] : null;
}

function cleanHeaders(headers, request = false) {
  const excluded = new Set([...hopHeaders, ...String(headers.connection || '').split(',').map(name => name.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)
    && (!request || (!['host', 'origin', 'forwarded', 'x-real-ip', 'x-http-method-override', 'x-method-override', 'x-terminal-preview-controller-origin'].includes(name)
      && !name.startsWith('x-forwarded-') && !name.startsWith('x-original-') && !name.startsWith('x-rewrite-')
      && !name.startsWith('tailscale-') && !name.startsWith('proxy-')))));
}

function opaqueResourcePath(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  let parsed;
  try { parsed = new URL(request.url, 'http://gateway.invalid'); } catch { return null; }
  const path = parsed.pathname.replace(/^\/api\/environments\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/proxy(?=\/)/, '');
  const port = path.match(/^\/preview\/(\d+)(?:\/|$)/)?.[1];
  if (!(port && Number(port) >= 1 && Number(port) <= 65535) && !['/api/preview', '/api/proxy-external'].includes(path)) return null;
  const tickets = parsed.searchParams.getAll('previewToken');
  if (tickets.length !== 1 || tickets[0].length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tickets[0])) return null;
  // This selects the read-only carrier; the API still verifies its signature and scope.
  try { if (JSON.parse(Buffer.from(tickets[0].split('.')[1], 'base64url')).token_kind !== 'preview-resource') return null; } catch { return null; }
  const parameters = [...parsed.searchParams].filter(([name, value]) => name !== 'token' || (!value.startsWith('tv4pair.') && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)));
  parsed.search = '';
  for (const [name, value] of parameters) parsed.searchParams.append(name, value);
  return parsed.pathname + parsed.search;
}

function socketResponse(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

// Identity headers are trustworthy only behind private Tailscale Serve on loopback:
// https://tailscale.com/docs/features/tailscale-serve#identity-headers
export async function createGateway({ allowedLogin, externalHost, externalOrigin = `https://${externalHost}`, upstreamPort = 3030, port = 3040 } = {}) {
  if (typeof allowedLogin !== 'string' || !allowedLogin || allowedLogin !== allowedLogin.trim() || /[\x00-\x1f\x7f]/.test(allowedLogin)) throw new Error('Set a valid TAILSCALE_ALLOWED_LOGIN');
  if (typeof externalHost !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(externalHost) || externalHost.includes('..')) throw new Error('Set TAILSCALE_EXTERNAL_HOST to the own-device Tailscale DNS name');
  const origin = new URL(externalOrigin);
  if (origin.hostname !== externalHost || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== externalOrigin
    || !((origin.protocol === 'https:' && !origin.port) || (origin.protocol === 'http:' && origin.port === '8080'))) throw new Error('TAILSCALE_APP_ORIGIN must be own-device HTTPS or private HTTP port8080');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Gateway ports must be valid TCP ports');
  const upstreamHost = `127.0.0.1:${upstreamPort}`;
  const upstreamOrigin = `http://${upstreamHost}`;
  const authorized = (request, websocket = false) => {
    if (request.socket.remoteAddress !== '127.0.0.1' || singleHeader(request, 'tailscale-user-login') !== allowedLogin || singleHeader(request, 'host') !== origin.host) return false;
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\') || /[\x00-\x20\x7f]/.test(request.url)) return false;
    const suppliedOrigin = singleHeader(request, 'origin');
    if (suppliedOrigin === 'null' && !websocket) {
      const path = opaqueResourcePath(request);
      return path ? { path, resourceOnly: true } : false;
    }
    if (request.headers.origin !== undefined && suppliedOrigin !== externalOrigin) return false;
    if ((websocket || !['GET', 'HEAD'].includes(request.method)) && suppliedOrigin !== externalOrigin) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    return !['CONNECT', 'TRACE'].includes(request.method) && { path: request.url, resourceOnly: false };
  };
  const requestHeaders = (request, resourceOnly = false) => {
    const headers = cleanHeaders(request.headers, true);
    if (resourceOnly) { delete headers.authorization; delete headers.cookie; }
    return { ...headers, host: upstreamHost, origin: upstreamOrigin, 'x-forwarded-host': origin.host, 'x-forwarded-proto': origin.protocol.slice(0, -1),
      ...(!resourceOnly && singleHeader(request, 'origin') === externalOrigin ? { 'x-terminal-preview-controller-origin': externalOrigin } : {}) };
  };

  const server = http.createServer((request, response) => {
    const authority = authorized(request);
    if (!authority) { response.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' }); response.end('Forbidden\n'); return; }
    const outgoing = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: request.method, path: authority.path, headers: requestHeaders(request, authority.resourceOnly) }, incoming => {
      response.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    outgoing.on('error', () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, { 'Content-Type': 'text/plain' }); response.end('Upstream unavailable\n'); }
    });
    request.on('aborted', () => outgoing.destroy());
    response.on('close', () => { if (!response.writableEnded) outgoing.destroy(); });
    request.pipe(outgoing);
  });

  server.on('upgrade', (request, client, head) => {
    if (!authorized(request, true)) { socketResponse(client, 403, 'Forbidden\n'); return; }
    const key = singleHeader(request, 'sec-websocket-key');
    if (request.method !== 'GET' || singleHeader(request, 'upgrade')?.toLowerCase() !== 'websocket' || singleHeader(request, 'sec-websocket-version') !== '13'
      || !key || Buffer.from(key, 'base64').length !== 16 || Buffer.from(key, 'base64').toString('base64') !== key
      || !String(request.headers.connection).toLowerCase().split(',').some(name => name.trim() === 'upgrade')) { socketResponse(client, 400, 'Invalid upgrade\n'); return; }
    const outgoing = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: 'GET', path: request.url, headers: { ...requestHeaders(request), connection: 'Upgrade', upgrade: 'websocket' } });
    let upgraded = false;
    outgoing.on('error', () => { if (!upgraded) socketResponse(client, 502, 'Upstream unavailable\n'); else client.destroy(); });
    client.on('error', () => outgoing.destroy());
    client.on('close', () => outgoing.destroy());
    outgoing.setTimeout(15000, () => outgoing.destroy());
    outgoing.on('upgrade', (response, upstream, responseHead) => {
      upgraded = true;
      upstream.setTimeout(0);
      const responseHeaders = { ...cleanHeaders(response.headers), connection: 'Upgrade', upgrade: 'websocket' };
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(responseHeaders).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`)).join('')}\r\n`);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      client.on('end', () => upstream.destroy());
      upstream.on('end', () => client.end());
      upstream.on('close', () => client.destroy());
      if (responseHead.length) client.write(responseHead);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    outgoing.on('response', response => {
      const responseHeaders = { ...cleanHeaders(response.headers), connection: 'close' };
      client.write(`HTTP/1.1 ${response.statusCode} ${http.STATUS_CODES[response.statusCode] || 'Response'}\r\n${Object.entries(responseHeaders).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`)).join('')}\r\n`);
      response.on('error', () => client.destroy());
      response.pipe(client);
    });
    outgoing.end();
  });
  server.on('connect', (_request, socket) => socketResponse(socket, 403, 'Forbidden\n'));
  server.on('clientError', (_error, socket) => socketResponse(socket, 400, 'Invalid request\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createGateway({ allowedLogin: process.env.TAILSCALE_ALLOWED_LOGIN, externalHost: process.env.TAILSCALE_EXTERNAL_HOST, externalOrigin: process.env.TAILSCALE_APP_ORIGIN, upstreamPort: Number(process.env.TAILSCALE_UPSTREAM_PORT || 3030), port: Number(process.env.TAILSCALE_GATEWAY_PORT || 3040) })
    .then(server => {
      console.log(`Tailscale app gateway listening on 127.0.0.1:${server.address().port}`);
      const sockets = new Set();
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      const stop = () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    })
    .catch(() => { console.error('Tailscale app gateway could not start. Check its configuration and loopback ports.'); process.exitCode = 1; });
}
