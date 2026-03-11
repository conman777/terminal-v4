# Preview Setup (Local + LAN Access)

This document explains how the preview panel routes local apps and how to make
it work when accessing Terminal V4 over a LAN IP or hostname.

## Quick Rules

- If you access Terminal V4 at `http://localhost:3020`, previews prefer
  **interactive subdomain routing** when a loopback-safe base is available
  (`preview-<port>.localhost`, `lvh.me`, `nip.io`, etc.). They fall back to
  **path-based routing** (`/preview/<port>/`) when no local subdomain base is
  available.
- Preview supports **all valid local ports** (`1-65535`) except the Terminal V4
  UI port itself.
- Port dropdowns prioritize ports that look like real web previews (HTML/SPA
  entry points) to reduce noise from non-frontend service ports.
- If you access Terminal V4 at `http://192.168.x.x:3020` or a hostname
  (`darthome.ddns.net`, `code.conordart.com`), **do not use localhost** in the
  preview URL. `localhost` would point at the browser machine, not the server.
- For LAN/hostname access, subdomain previews resolve back to the server using
  `nip.io` so the iframe points to the same box.
- If you enter a **different private LAN host** (example:
  `http://192.168.1.45:8889` while Terminal runs on `192.168.1.199`), preview
  now keeps that URL direct instead of rewriting to `/preview/8889`.

## How Preview Routing Works

### Localhost Access (Recommended for Local Dev)

When accessing Terminal V4 at `http://localhost:3020`:

- Enter: `http://localhost:3001` (or just select port from dropdown)
- Terminal V4 prefers interactive preview:
  `http://preview-3001.localhost:3020/`
- If no loopback-safe preview base is configured, it falls back to path-based
  preview: `/preview/3001/`

### LAN/Remote Access

When accessing Terminal V4 at `http://192.168.x.x:3020` or via hostname:

- Enter: `http://localhost:8787`
- Terminal V4 rewrites to subdomain format:
  `http://preview-8787.<server-ip>.nip.io:3020/`

Example (server IP `192.168.1.199`):

- Preview URL: `http://localhost:8787`
- Iframe URL: `http://preview-8787.192.168.1.199.nip.io:3020/`

`nip.io` always resolves back to the embedded IP, so the iframe reaches the
server no matter where the browser runs.

## Path-Based Preview

Path-based preview (`/preview/<port>/`) remains the fallback for localhost
access when interactive subdomain preview is unavailable. The proxy handles
content rewriting to ensure resources load correctly.

## Environment Settings

Set a resolvable subdomain base in `backend/.env`:

```
PREVIEW_SUBDOMAIN_BASES=127.0.0.1.nip.io,lvh.me,localhost
PREVIEW_SUBDOMAIN_BASE=127.0.0.1.nip.io
PREVIEW_PROXY_HOSTS=localhost,127.0.0.1,::1

# Optional: lock preview routing back to legacy dev-only ports (3000-9999)
# UNRESTRICTED_PREVIEW=false
```

The frontend reads `/api/system/preview-config` and stores the base in
localStorage, so the preview URL generator can pick the right host.

## Common Failure Modes

1. **"Refused to connect" on preview-*.localhost**
   - You are accessing the UI over a LAN IP/hostname.
   - Fix: use nip.io subdomains (see above).

2. **White/blank iframe with ERR_CONTENT_DECODING_FAILED**
   - Usually caused by content-encoding header mismatch in proxy.
   - The proxy now strips `content-encoding` header since fetch() auto-decompresses.
   - If this occurs, restart the backend: `~/terminal-v4/restart.sh`

3. **React error #321 / duplicate bundle**
   - Caused by cache-busting JS module URLs.
   - Fix: do not add cache-busters to JS imports in preview rewrites.

4. **Preview shows old/wrong app**
   - The preview URL persists in localStorage.
   - The port dropdown only shows ports that are actively listening.
   - If a port stops listening, the preview URL is cleared on next load.
   - Use the port dropdown (number badge) to select the correct port.

## Validation Checklist

For localhost access:
- Iframe `src` should be either:
  `http://preview-<port>.localhost:3020/`
  or `/preview/<port>/` when falling back

For LAN/remote access:
- Iframe `src` should be:
  `http://preview-<port>.<server-ip>.nip.io:3020/`

For private LAN app on another machine:
- Iframe `src` should stay as entered (example: `http://192.168.1.45:8889/`)

General:
- Iframe content should match the running app.
- Port dropdown should show only active/listening ports.
- Console errors about `code.<ip>.nip.io` are log panel CORS issues and do not
  prevent rendering.
