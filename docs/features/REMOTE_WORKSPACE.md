# Remote workspace

Terminal v4 adds a device directory, permission profiles, reconnect recovery, background hosting, resumable transfers, guest invitations, session replay, TCP tunnels, device-ID relay connections and optional Windows desktop control.

## Devices and permissions

Open Environments to pair another host or connect through a device ID. Each server keeps a persistent UUID. Aliases, favourites, tags, last-seen/used times and recent workspace paths are saved on the owning home server. Search by host, alias, tag or workspace.

The destination chooses Observer, Operator or Custom before generating its two-minute pairing code. Observer can inspect existing output and browse metadata. Operator can run terminals/agents, change files, transfer files and use recordings. Tunnels and desktop access require explicit Custom permissions. Desktop control also requires desktop viewing. Account administration and provider-key configuration remain direct-owner operations. The server checks HTTP methods and live control messages; hiding a button is not the authorization boundary. Observer previews show HTML/assets; opaque application/HMR sockets require terminal-input authority. Cookie and storage inspection requires agent-execution authority.

The browser keeps its home login. Paired credentials remain encrypted on the home server and are forwarded separately from its JWT. Incoming grants can be revoked, outgoing pairings disconnected, and grants expire after thirty days. Restoring a selected device after reload checks the authenticated owner's directory first. Browser preferences are scoped by home identity and environment.

## Reconnect

Terminal and structured streams reconnect with bounded history replay, sequence deduplication and gap recovery. A changed host cancels the previous connection generation. Network loss pauses retries, and permission/revocation failures stop them. A disconnected browser does not resend unsent commands or model prompts. Saved terminal and device selection survive an offline reload. Already-running native sessions depend on the host process staying alive; Windows API restarts preserve history but do not preserve a killed PTY process.

## Background host

Environments includes Keep this computer available with concrete Windows setup commands. The launcher starts a hidden API process independently of desktop windows and can register a current-user logon task. It stores configuration with user/SYSTEM permissions and DPAPI-encrypts credentials. It preserves an existing JWT secret and data directory when supplied. Tauri attach mode connects to that host and leaves it running on window close.

This startup task runs after Windows sign-in, rather than before login. Installation, firewall configuration and public hosting are explicit operator actions. See [Background host](BACKGROUND_HOST.md). Initialize also captures configured Hermes runtime roots, relay variables and desktop-access opt-in; changes require deliberate configuration migration.

## File transfers

Tools → File transfers accepts dropped or selected files and remote relative paths. Upload/download chunks carry SHA-256 checksums. Transfers expose progress, pause, resume and cancellation. Uploads stage in application data, outside the project, and publish through a guarded temporary file in the destination directory. Existing files are never overwritten; choose another name. Parent directories must exist.

The current limits are 256 MiB per file, 512 MiB of pending data per account, 100 records and 256 KiB chunks. Download chunks can be cached in IndexedDB across reloads; browser storage quotas may require restarting a download. Completed download data is handed to the browser download manager, which determines where it is saved. Cancelling/removing a record never deletes an already published project file.

## Guest collaboration

Tools → Share workspace creates a session-specific invitation on the owning host. Choose Observer or Controller, a lifetime of one minute to twenty-four hours, and one to eight uses. The fragment link carries a one-time secret; the server persists its hash. Guest mode is a dedicated interface that receives no owner JWT, account settings, file API or new-session authority. Participants and last-seen times are visible to the owner. Expiry/revocation closes live guest sockets.

Controller access allows command execution through that existing terminal, with the host permissions of its shell. A workspace label is not an OS sandbox. Invitations currently support active PTY terminals; structured conversations have their normal account controls. Pairing a host does not delegate invitation administration.

## Record and replay

Tools → Session replay requires explicit capture consent. Record existing and live terminal output or structured agent events, then stop, seek, pause, change playback speed, export or delete. ANSI output is replayed in xterm. Structured user messages, tool-input envelopes and raw provider envelopes are excluded. Terminal echo can still contain commands or sensitive text. Export applies best-effort known-secret redaction; review exports before sharing.

Limits: eight active captures per host, thirty-two saved recordings per account, 8 MiB and ten thousand events per recording. Atomic receipts persist every 250 ms. Gaps, limits and interrupted captures remain visible. Captures stop on orderly server shutdown. Playback uses a fixed default viewport because native resize events are not recorded.

## Service tunnels

In Environments, choose a paired device with Service tunnels permission and enter a remote loopback service port. The home API binds a loopback listener and forwards binary TCP over authenticated WebSockets. The displayed local address belongs to the computer running the home API, which may differ from the browser's computer. The target's Terminal API port is blocked. Stopping a tunnel or revoking access closes its listener and streams.

Limits: eight listeners per account, sixteen streams per listener, sixty-four target streams, 64 KiB frames and an eight-hour lifetime. Tunnels are not restored automatically after server restart. The owning home login must remain valid.

## Device-ID relay

For a device behind a router, run a trusted HTTPS relay and configure its shared registration secret. The device opens an outbound connection and registers its persistent identity with a separate pinned device secret. Pair using relay URL, device UUID and a destination-issued pairing code. HTTP, streams, previews and TCP tunnel WebSockets retain their device prefix.

The relay operator can see relayed traffic. TLS protects transport; this feature does not claim end-to-end encryption through an untrusted broker. No cloud relay is deployed automatically. See [Device relay](DEVICE_RELAY.md) for configuration, ownership and bounds.

## Optional Windows desktop

Desktop viewing is off by default. Set TERMINAL_V4_DESKTOP_ACCESS=view or control on the destination host and restart it. A paired connection also needs Desktop viewing and, for input, Desktop control permissions. Environments → Remote desktop selects a display and opens a ten-minute owner-scoped session. Control is a separate explicit toggle. Switching hosts aborts image/input requests and cleans up the original session.

The initial native helper supports bounded JPEG frames at one frame per second, pointer clicks, keyboard shortcuts and Unicode text. It requires an interactive Windows login. It does not provide a full-motion video protocol or access to Windows secure/UAC desktops. Native frame capture and input require manual verification on the intended Windows desktop; automated verification uses synthetic images and input dry runs only.

## Verification

Colocated tests cover permissions, ownership, real two-host pairing, PTY reconnect logic, atomic transfers, guest sockets, recordings, TCP forwarding and three-host relay transport. Startup tests exercise only a harmless fixture process and WhatIf installation. See [Testing guide](../development/TESTING_GUIDE.md). Production internet/TLS deployment and interactive desktop capture/input remain deployment checks.
