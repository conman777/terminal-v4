# Preview Setup (Local + LAN Access)

This document explains how the preview panel routes local apps and how to make
it work when accessing Terminal V4 over a LAN IP or hostname.

## Quick Rules

- If you access Terminal V4 at `http://localhost:3020`, you can preview
  `http://localhost:<port>` directly (subdomain preview on `.localhost`).
- If you access Terminal V4 at `http://192.168.x.x:3020` or a hostname
  (`darthome.ddns.net`, `code.conordart.com`), **do not use localhost** in the
  preview URL. `localhost` would point at the browser machine, not the server.
- For LAN/hostname access, subdomain previews must resolve back to the server.
  Use `nip.io` so the iframe points to the same box.

## Recommended Preview URL (LAN/Hostname Access)

If the app is running on the same machine as Terminal V4:

- Enter: `http://localhost:8787`
- Terminal V4 will rewrite to:
  `http://preview-8787.<server-ip>.nip.io:3020/`

Example (server IP `192.168.1.199`):

- Preview URL: `http://localhost:8787`
- Iframe URL: `http://preview-8787.192.168.1.199.nip.io:3020/`

`nip.io` always resolves back to the embedded IP, so the iframe reaches the
server no matter where the browser runs.

## Path-Based Preview (Fallback)

You can also use:

- `/preview/8787`
- `http://192.168.1.199:3020/preview/8787`

This works server-side but **SPAs may 404** if they assume `/` as the base
path. If you see a 404 inside the iframe, prefer subdomain preview.

## Environment Settings

Set a resolvable subdomain base in `backend/.env`:

```
PREVIEW_SUBDOMAIN_BASES=127.0.0.1.nip.io,lvh.me,localhost
PREVIEW_SUBDOMAIN_BASE=127.0.0.1.nip.io
```

The frontend reads `/api/system/preview-config` and stores the base in
localStorage, so the preview URL generator can pick the right host.

## Common Failure Modes

1. **“Refused to connect” on preview-*.localhost**
   - You are accessing the UI over a LAN IP/hostname.
   - Fix: use nip.io subdomains (see above).

2. **White/blank iframe with SPA 404**
   - Path-based preview changes the base path to `/preview/<port>/`.
   - Fix: use subdomain preview instead of `/preview/<port>`.

3. **React error #321 / duplicate bundle**
   - Caused by cache-busting JS module URLs.
   - Fix: do not add cache-busters to JS imports in preview rewrites.

## Validation Checklist

- Iframe `src` should be:
  `http://preview-<port>.<server-ip>.nip.io:3020/`
- Iframe title/body should match the app.
- Console errors about `code.<ip>.nip.io` are log panel CORS issues and do not
  prevent rendering.
