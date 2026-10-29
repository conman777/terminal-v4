# V4 MCP tools

V4 contains an original Rust MCP client. It connects only to servers explicitly saved for the signed-in account. Reading settings and saving configuration never start a process or connect to a server. Workspace files, downloaded skills, and repository MCP files cannot register or start servers.

## Configuration API

These routes belong to the authenticated API router:

| Method | Route | Effect |
| --- | --- | --- |
| GET | `/api/agent/mcp` | Return this account's server configuration with credentials redacted |
| PUT | `/api/agent/mcp` | Replace this account's configuration; validate before writing |
| POST | `/api/agent/mcp/{id}/probe` | Explicitly initialize this account's server, discover tools/resources/prompts, then close it |
| GET | `/api/agent/mcp/{id}/probes/{probeId}` | Read an owner-bound background probe receipt |
| DELETE | `/api/agent/mcp/{id}/probes/{probeId}` | Cancel a probe and await client/process cleanup |

The body for PUT is `{ "servers": [...] }`. A server contains `id`, `name`, `enabled` (default false), `timeoutSeconds` (default 30), and a transport. Removing a server from the array removes its configuration. At most 20 servers are accepted.

A stdio transport uses an existing absolute executable path and separate arguments. V4 passes arguments directly to the executable, without constructing shell text. The child receives only the supplied environment; V4 does not forward the application's environment, home directory, provider keys, or login tokens. Include any environment a particular server needs explicitly.

```json
{
  "id": "local-tools",
  "name": "My local tools",
  "enabled": false,
  "timeoutSeconds": 30,
  "transport": {
    "type": "stdio",
    "command": "/absolute/path/to/executable",
    "args": ["/absolute/path/to/server.js"],
    "env": { "EXAMPLE_SERVER_KEY": "provided-explicitly" }
  }
}
```

Windows stdio commands must be native `.exe` or `.com` executables. Configure a script interpreter explicitly for scripts.

An HTTP transport uses `{ "type": "http", "url": "https://example.test/mcp", "bearerToken": "optional-secret" }`. HTTPS and HTTP on literal loopback IP addresses are supported. HTTP DNS names, URL credentials, query strings, and fragments are rejected. Redirects and environment proxies are disabled, so a configured bearer token cannot follow a redirect or an inherited proxy setting.

GET returns `envKeys` for stdio transports and `bearerTokenSet` for HTTP transports, without the credential values. PUT accepts these metadata fields. Omitted `env` or `bearerToken` preserves the previous secret for the same server ID and unchanged executable/arguments or URL. Set `env` to `{}` to clear it, or set `clearBearerToken` to true to clear an HTTP token. Changing a target with a saved secret requires explicitly replacing or clearing that secret.

A settings write commits the validated configuration before it closes this
account's affected integrations and holds queued work. If cleanup cannot be
confirmed, PUT returns HTTP 503 with `settingsSaved: true`,
`cleanupConfirmed: false`, and `config: { "servers": [...] }` containing the
committed redacted configuration. This typed response means the settings were
saved and cleanup needs retry; it is not a failed creation or a rollback. An
unchanged PUT retries pending cleanup without starting a connection.

Probe works for disabled servers because the user explicitly requested the connection. A successful response contains `server: {id, name}`, `protocolVersion`, `serverInfo`, `capabilities`, `instructions`, `tools`, `resources`, `resourceTemplates`, and `prompts`. Metadata, descriptions, results, and instructions remain untrusted server data. Discovery preserves resource annotations, links, and MCP Apps metadata; it does not read the discovered resources or execute tools.

POST with `{ "background": true, "probeId": "optional-caller-generated-UUID" }` returns 202 and `{probeId, status, cleanupConfirmed}`. GET returns the receipt with `status` (`running`, `completed`, `failed`, or `cancelled`), `cleanupConfirmed`, and optional `result` or `error`. A failed receipt with `cleanupConfirmed: false` retains the exact probe ID and transport for DELETE retry; HTTP 200 alone does not confirm cleanup. New probes for that account are blocked until retained cleanup succeeds. Unconfirmed cleanup owners are retained beyond the normal receipt TTL. DELETE returns only after cleanup has completed or failed; it preserves a completed receipt. A caller-generated UUID allows DELETE before POST registration to create a cancellation tombstone, preventing a late request from starting a process. There are at most four active probes per account and 512 in-memory receipts, retained for ten minutes. Probe operations have an overall timeout, and settings changes, logout, and backend shutdown signal cancellation.

Saved stdio settings remain readable and removable if their executable is later uninstalled. Connecting still verifies that the executable exists and can run.

## Private storage

Configuration is stored under the app data directory in `agent-mcp/`. The filename uses a SHA-256 digest of the authenticated account ID. The whole configuration is encrypted with AES-256-GCM, including stdio environment values and HTTP tokens. A generated 256-bit app key is stored in a separate private file; this feature does not use the development fallback vault key. The encrypted payload also includes its owner ID, so copying one account's encrypted file over another account's filename is rejected.

On Unix, the configuration directory has mode 0700 and files have mode 0600. Writes use a temporary file and atomic replacement. Symlink configuration files and malformed or oversized ciphertext are rejected. These protections do not protect secrets from the owner of the operating-system account or someone who can read both the private key and encrypted data.

## Protocol and bounds

V4 requests protocol `2025-11-25` and accepts `2025-06-18` or `2025-03-26` during negotiation. It sends `initialize`, waits for the result, and sends `notifications/initialized` before discovering tools. Tools are listed with cursor pagination and invoked with `tools/call`. Calls are allowed only after a tool has been discovered. Resource and template listings and prompt listings use bounded cursor pagination. `resources/read` preserves text/blob content and metadata. `prompts/get` accepts bounded string arguments and preserves user/assistant message content, including embedded resources and links. JSON-RPC errors are reported by code without reflecting arbitrary error text.

Stdio uses UTF-8 newline-delimited JSON. HTTP supports JSON responses and fragmented SSE responses, negotiated session and protocol headers, and bounded SSE resumption through GET with `Last-Event-ID`. Resumption never repeats the original tool-call POST. HTTP sessions are deleted when closed. Failed DELETE requests retain the client/session for retry. A 405 response is reported as unsupported explicit termination, with remote cleanup unconfirmed. A repeated close cannot convert a failed cleanup into a successful receipt. Dropping a client schedules bounded best-effort HTTP cleanup. Session expiration is surfaced to the caller; tool calls are not silently retried.

Limits include 1 MiB per protocol message, 2 MiB per response stream, 200 tools, 20 tool-list pages, no repeated cursors or tool names, and a 1-120 second request timeout. Timeout and controlled closing send a cancellation notification for a pending request where possible, excluding initialization as required by the protocol. Interrupted requests cannot be reused silently. Stdio children use kill-on-drop and the shared process-tree guard, including descendants that change process group. Closing stdio first closes stdin, then waits, then requests termination and kill/reaping if needed. The guard tracks process birth identity to avoid signalling a recycled PID. Remote cancellation remains a protocol request; V4 cannot prove that an untrusted remote server stopped its own work.

Client capabilities default to denied. A host can explicitly share validated canonical roots or register a sampling/elicitation handler through `ClientPolicy`; capabilities are advertised only when that host handler exists. The handler remains responsible for obtaining the user's approval and validating returned data. No production flow registers an automatic sampling or elicitation handler. The default client answers pings and rejects unadvertised server requests, including requests sent too early during initialization. Roots are advisory protocol information, not an operating-system sandbox for a configured native server.

The GUI probe and MCP Apps session explicitly negotiate the `io.modelcontextprotocol/ui` extension with the MCP HTML MIME type. Ordinary clients can keep Apps disabled.

## MCP Apps sessions

MCP Apps is implemented independently from the stable protocol specification. Opening an app requires an authenticated explicit POST to `/api/agent/mcp/{serverId}/apps/open` with `{resourceUri, toolName?, sessionId?}`. The server must be enabled and the `ui://` resource must be declared in the selected tool's `_meta.ui.resourceUri`. Discovery alone cannot open an app. The response contains `sessionId`, `serverId`, `serverInfo`, `protocolVersion`, `resourceUri`, `html`, the original `resource`, requested `csp`/`permissions`, app-visible `tools`, and `expiresAt`. No referenced URL, icon, script, or asset is fetched by the backend.

HTML is limited to 512 KiB and must use `text/html;profile=mcp-app` or the legacy `text/html+mcp` type. Text and bounded valid UTF-8 base64 blobs are supported. CSP and permissions are untrusted requested metadata; they do not grant permissions. The frontend owns its sandbox, network policy, lifecycle handshake, source review, and explicit user decisions.

GET `/api/agent/mcp/apps/{sessionId}` returns `opening`/`active` status metadata. DELETE closes the session and awaits cleanup. An optional caller-generated session ID supports cancellation before opening finishes; a pre-open DELETE creates an owner-bound tombstone. There are at most four live apps per account, 64 globally, a ten-minute TTL, and bounded closed-session receipts. Settings changes, logout, expiry, and backend shutdown close opening and active sessions. Fresh configuration is checked before every new request and approval.

App requests use a separate review boundary:

1. POST `/api/agent/mcp/apps/{sessionId}/requests` with `{method, params}` creates a pending receipt containing the exact frozen method/parameters. It performs no requested RPC.
2. POST `.../requests/{requestId}/decision` with `{approved: true|false}` executes or denies that request. Duplicate decisions preserve the existing result and cannot intentionally rerun the operation. GET `.../requests/{requestId}` reads its receipt, including an in-progress `running` status.
3. The allowed methods are `tools/list`, `tools/call`, `resources/read`, `prompts/list`, and `prompts/get`. Every operation is restricted to the originating server. Model-only tools cannot be called by an app. At most eight requests may await approval/run per app, with 32 bounded request receipts.

Raw tool result `_meta` remains in the transient owner-bound App receipt for the host/iframe. It is not written by this module to an agent transcript, model context, or recall store. All server clients use default-denied roots, sampling, and elicitation policy.

## Remaining MCP work

These remain explicit follow-up items in the full feature-parity goal:

- Legacy HTTP+SSE transport compatibility.
- OAuth protected-resource/authorization-server discovery and reviewed login/token refresh.
- Host UI for approved sampling and elicitation callbacks; automatic callbacks remain disabled.
- Resource subscriptions, asynchronous MCP task support, and background notification delivery.
- External server interoperability and Windows runtime verification; current checks use synthetic local fixtures.

## Verification

Run the MCP tests with `cargo test -p terminal-v4-api mcp:: --lib` from `rust/`. Synthetic stdio and loopback HTTP fixtures cover initialization, redacted settings updates, encrypted owner isolation, protocol fragmentation, pagination, tool errors, limits, timeouts, process cleanup, HTTP session headers, resumption without repeated calls, and explicit probe behavior. They make no model-provider or external MCP requests.

Protocol references: [MCP Apps stable specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [MCP prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts), [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). These are protocol specifications; no Hermes or T3 implementation source was used.


## Settings and app preview verification

Session Settings includes **MCP servers**. Opening this section reads only this
account's redacted configuration. The forms add, edit, enable, remove, or reload
servers; they preserve omitted secrets and require an explicit replacement or
removal when a saved secret's target changes. Stdio arguments use a JSON string
array, so spaces and empty arguments remain intact. Environment values and bearer
tokens use password controls and disappear from the form after a successful save.
The UI enforces 20 servers, 64 KiB per server, and 256 KiB for a configuration.

When a typed HTTP 503 confirms saved settings but unconfirmed cleanup, the UI
adopts the returned committed server list, clears the edit form and entered
secrets, and displays **Retry MCP cleanup**. New edits and connections remain
blocked while cleanup is pending. Retry submits that exact saved list with
redacted transport fields and the same server IDs. It does not recreate a saved
server, restore a removed one, or resend entered secret values. Omitted secrets
continue to use the existing preservation rules. Repeated cleanup failures keep
the committed state visible; success clears the cleanup blocker. Held queued
work still requires its explicit resume action.

**Test connection** explicitly starts a background probe. The UI polls its
owner-bound receipt and displays tools, resources, resource templates, and prompts
as metadata without fetching listed URIs or icons. Cancel requests server-side
cleanup and waits for its receipt before reporting cancellation. Leaving the
panel sends a cleanup request as well. A failed cleanup keeps the exact probe ID
and **Retry cancellation** control visible, with new connections blocked until a
matching receipt explicitly confirms cleanup. An ordinary discovery failure with
confirmed cleanup remains retryable as a new connection test. A browser fetch
abort alone is not treated as process cancellation.

A declared app tool on an enabled server exposes **Open app**. This creates a
dedicated owner session and reads only the declared UI resource. The HTML is
initially displayed as readonly source; no app iframe is constructed yet. Each
new app session requires explicit consent to browser network channels V4 cannot
block, followed by **Run app preview**. This is a settings preview, not automatic
rendering of agent tool results in a conversation.

V4's original host bridge uses a trusted proxy on an opaque data origin and an
inner app frame with `sandbox="allow-scripts"`. It validates the proxy window and
origin, follows the `ui/initialize` and `ui/notifications/initialized` handshake,
filters sandbox control messages from app content, and never passes host tokens
to the frame. App tool/resource/prompt requests become immutable pending backend
requests. V4 displays their exact method and arguments and waits for a separate
Approve or Deny action. Uncertain decisions are checked by receipt instead of
being repeated automatically. Link requests display a separate user-clickable
link; app messages cannot directly navigate the host or send conversation text.
Closing requests graceful UI teardown, then awaits backend connection cleanup.
Owner-session checks remove revoked or expired views.

### Browser network limitation

The preview denies declared CSP network sources and does not grant requested
camera, microphone, or clipboard permissions. Local Chromium checks verified
blocked HTTP fetches, resource loads, navigation, form submissions, link pings,
and other tested HTTP paths, together with opaque-origin host storage isolation
and source-bound RPC approval. These checks do **not** establish that all browser
network traffic is blocked. A harmless loopback TURN probe sent UDP traffic in
Chromium 151 despite `connect-src 'none'`; that runtime also ignored the newer
`webrtc 'block'` directive. Nested srcdoc content can create fresh JavaScript
realms, so deleting WebRTC constructors would not establish isolation either.
The UI therefore requires explicit per-app network consent before HTML runs and
does not advertise a network-isolated runtime.

The [W3C CSP3 WebRTC directive](https://www.w3.org/TR/CSP3/#directive-webrtc)
defines a separate WebRTC connection policy. Its presence in a specification does
not prove implementation in the browser used by V4.
[Mozilla's connect-src reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)
documents the fetch interfaces covered by that directive. The host protocol is
based on the [official MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
without using Hermes or T3 implementation code.

### UI evidence

Focused regressions:

```sh
npm --prefix frontend test -- --run src/components/McpSettingsPanel.test.jsx src/components/McpAppView.test.jsx src/components/SettingsModal.test.jsx src/utils/mcpApps.test.js
```

The local verification run also exercised the actual settings UI, real Axum API,
and synthetic Python stdio MCP processes. It verified that reading/saving starts
no server; explicit probes do; cancellation and panel unmount terminate actual
children; source review creates no iframe; approval executes the exact tool
arguments once; denial executes no additional call; closing during an incomplete
app handshake terminates that child; and config disable revokes a loaded app and
its process. Focused settings regressions also cover saved HTTP 503 receipts for
creation, removal and enablement, retrying the committed redacted list without
duplicate creation, and retaining the saved-state explanation after a lost
cleanup response. No private or public external MCP server, paid model, or email
account was used.

Evidence is saved in the current Codex task workspace:

- `work/mcp-settings-ui/live-browser-results.json`: real probe/UI/process lifecycle.
- `work/mcp-settings-ui/apps-browser-results.json`: actual iframe interactions,
  source review, approvals, mobile layout, and direct HTTP navigation check.
- `work/mcp-settings-ui/apps-live-browser-results.json`: real app/API/stdio lifecycle.
- `work/mcp-settings-ui/mcp-app-live-source-review.png` and
  `work/mcp-settings-ui/mcp-app-approval-mobile.png`: inspected desktop/mobile UI.
- `work/mcp-app-webrtc-directive-result.json` and
  `work/mcp-app-navigation-results.json`: retained network-channel failure and
  bounded HTTP-path evidence from the independent local review.
