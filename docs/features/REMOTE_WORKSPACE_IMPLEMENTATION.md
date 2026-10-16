# Remote workspace implementation

The existing feat/hermes-inspired-workspace checkout is extended in ten bounded agent workstreams. Existing terminal, provider, pairing and rewind changes are retained.

1. Device metadata and enforced permission profiles.
2. Device address book and pairing controls.
3. Durable host selection and reliable terminal/structured reconnect.
4. Background startup and unattended host operation.
5. Resumable file transfers with integrity checks.
6. Expiring workspace collaboration invitations.
7. Session recording and timeline replay.
8. Authenticated remote service tunnels.
9. Device identifiers and self-hosted relay connections.
10. Optional Windows desktop viewing and consented input.

The coordinator integrates API routing and navigation, resolves unfinished rewind correctness issues, and runs full regression and real transport checks. Native Windows features report unsupported platforms honestly. Relay and startup configuration are shipped without deploying outside infrastructure or changing the current computer's startup settings during development.

Verification uses colocated unit tests, real local HTTP/WebSocket/TCP integration tests, bounded native fixtures, and desktop/mobile browser checks. External model requests are not part of verification.

All ten workstreams have implementations and colocated tests. Integrated permission and lifecycle review adds preview-cookie/socket regressions and relayed TCP forwarding checks. The feature guide is REMOTE_WORKSPACE.md. Native desktop capture/input and public TLS deployment remain manual deployment checks; the implementation does not claim those were exercised by synthetic tests.
## Integrated verification (2026-10-15)

- Rust workspace: 305 passing tests, one existing ignored test.
- Windows Tauri wrapper: type check and three lifecycle tests pass.
- Frontend: 118 files / 669 tests pass; production build passes.
- Rust formatting and Git whitespace checks pass. Strict Clippy still reports existing repository diagnostics; the new remote modules introduce no remaining diagnostics relative to the recorded baseline.
- Real local browser checks cover device persistence, remote selection/reload, reconnect to the same PTY, exact-byte transfer, recording/export, guest exchange/revocation, read-only mobile controls and fitted ANSI guest output.
- Real transport tests exercise direct and relayed TCP forwarding and revocation. Startup lifecycle uses a harmless fixture; desktop helper verification uses synthetic JPEGs and input dry runs.

Native interactive desktop capture/input and internet/TLS deployment remain manual verification steps. Startup installation and external relay deployment were not performed.
