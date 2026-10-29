# Shared agent browser

The Browser pane, native Codex, native Claude and in-app V4 conversations use the
same app-owned Chromium browser on the home API server. `workspace_browser.rs`
owns one helper/context per authenticated account and data directory, across
workspaces. `workspace_browser.cjs` embeds the Playwright implementation; the pane
receives authenticated JPEG frames and sends input through app HTTP routes. The
engine runs headless but remains visible and controllable remotely, including
through Tailscale. Development Preview and preview screenshot/recording services
are separate paths.

## Bundled runtime

From the checkout root:

```sh
npm run browser:install
npm run browser:verify
```

The app stages Node **22.23.1**, Playwright **1.64.1** and its Chromium revision
**1248** together in `.runtime/browser`. Desktop builds package that directory as
`browser-runtime/`. Root `app:build`, desktop install/predev and Tauri build/bundle
hooks prepare it. A user-installed Chrome, global Node/Playwright installation or
shared Playwright cache is never a runtime fallback. The installer may copy a
matching cached Chromium revision as a build input; execution uses the staged copy.

`browser_runtime.rs` resolves, in order:

1. An explicit `TERMINAL_V4_BROWSER_RUNTIME_DIR`.
2. `TERMINAL_V4_RUNTIME_ROOT/browser-runtime`.
3. `browser-runtime` beside the API executable.
4. The compile-time checkout's `.runtime/browser`.

An invalid explicit directory fails immediately. Otherwise the first existing
candidate must validate; an invalid packaged bundle does not silently select the
checkout. Validation checks platform/architecture, manifest/package versions,
Chromium's Playwright descriptor and executable paths contained in the runtime.
Missing or invalid resources report installation/repair guidance. Shared-browser
launch does not honor `PLAYWRIGHT_NODE_BIN`, `WORKSPACE_BROWSER_BIN` or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` as engine overrides.

Preparation supports native macOS arm64/x64, Linux arm64/x64 and Windows x64 and
rejects cross-compilation. A new staging directory gets a local data-page smoke
check before publication. A valid existing runtime is reused without repeating
that smoke check; `browser:verify` explicitly launches it, checks DOM fill/click
and PNG output with an empty `PATH` and fresh home/cache directories. This proves
only that local fixture path on the current host. It is not portable proof of
clean-machine OS dependencies, sandbox availability, packaged resource discovery
or functionality on all supported targets. Manifest validation is not a binary
integrity attestation.

## Enable and configure

Open **Settings → Agent browser**, enable tools and add the exact website origins
needed for the task. Human browsing does not require agent enablement or the
agent allow-list. Agent settings are disabled by default with no allowed origins.
Authenticated `GET` / `PUT /api/agent/browser` reads/saves:

```json
{
  "enabled": false,
  "executable": null,
  "headless": true,
  "timeoutSeconds": 15,
  "allowedOrigins": ["http://localhost:3000", "https://example.com"]
}
```

The shared engine always uses bundled Chromium, headless frame transport and its
own helper deadlines. Saved `executable` and `headless` fields apply to standalone
V4's isolated browser path, not to the shared engine. A nonempty executable is
still validated when saving settings. Reading and saving never launch a browser,
connect to a debugger or visit a URL. Extra profile, cookies, debugger URL or
authentication-state fields are rejected.

Origins are exact HTTP/HTTPS origins, including port. Host casing, default ports
and trailing slashes are normalized; duplicates are removed. Paths, credentials,
query strings, fragments and wildcards are rejected. Add required resource origins
as well as the page origin. HTTP localhost and LAN development origins work.
`about:blank` is also supported by agent tools.

Changed settings stop this account's active structured conversations, including
native and V4 integrations, and hold queued work; an unchanged save retries
unconfirmed cleanup. HTTP 503 with
`settingsSaved: true`, `cleanupConfirmed: false`, `config` and an error means the
settings were saved but cleanup needs retry. Active native MCP requests recheck
the saved settings before dispatch and require fresh approval after a change.
This does not claim that saving agent settings closes the human's shared session.

## Agent approvals and control

Native structured adapters receive `terminal_v4_browser` as an app-owned loopback
MCP server. Random bearer capability leases bind the account, data directory and
agent label, expire after 12 hours and revoke on the last connection-owner drop.
They are not login tokens or general API credentials. Pending/cancelled work is
tracked by capability and request; revocation can prevent already-approved work
still waiting for the helper. Browser initialization/tool discovery never launches
a browser or grants permission to inspect a page.

Every native browser action, including snapshots, screenshots, tab listing and
JavaScript, needs its own exact decision in the conversation or **Browser** pane. Both
views submit the same pending broker request; approving in one resolves that request.
Native conversations show a readable action description and meaningful arguments,
with exact tool, request, agent label and raw arguments in **Details**. The approval
shows agent label, tool and arguments, expires after 60 seconds, and binds saved
settings and the reviewed session/tab/document/control generation as applicable.
Stale targets, takeover, denial, cancellation or revocation fail the operation.
`browser_release_control` needs no approval and leaves tabs open.

Chat headers distinguish waiting for approval from active work. Stop and cancellation
retry controls sit beside the composer; cancelling preserves the unsent draft.
Read-only, history-only, stopping and unconfirmed-cleanup views keep their existing
decision and sending restrictions. Inline broker requests are scoped to the native
session and current account/home, and stale polling or decision responses cannot
settle a replacement request.

Codex's app-injected `terminal_v4_browser` transport sets the per-server
`default_tools_approval_mode` to `approve`, so its calls reach this exact-action
broker without a second native conversation decision. This applies only when the
adapter injects the app-owned URL and leased bearer capability at thread start or
resume; it is not a rule to accept requests based on a server name. Global
`approvalPolicy: on-request`, `approvalsReviewer: user`, other MCP servers, native
commands, edits and elicitation handling are unchanged. No browser action runs
until its broker decision passes the settings, owner/capability, revocation,
cancellation, session/tab/document/control and expiry checks described above.

The installed Codex CLI **0.164.0** experimental JSON schema, generated with
`codex app-server generate-json-schema --experimental --out <temporary-dir>`,
defines `AppToolApproval` as `auto`, `prompt`, `writes`, `approve`; `approve` is a
supported per-server value, not the global `never` policy. See the
[official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The opt-in `installed_codex_browser_transport_has_one_broker_decision_and_keeps_other_mcp_prompts`
Rust test uses the installed CLI, an empty HOME/CODEX_HOME, loopback synthetic
Responses inference and a disposable shared browser helper. It replays the real
adapter's configuration, verifies that Deny preserves the reviewed session, Allow
closes it, no result arrives before either broker decision, and an identically
named tool on a user MCP server still requires native approval. Run it with
`CODEX_PROTOCOL_BINARY=/absolute/path/to/codex cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib installed_codex_browser_transport_has_one_broker_decision_and_keeps_other_mcp_prompts -- --ignored --nocapture`.
It makes no paid model calls and reads no user credentials or histories. This
proves the local installed transport and broker seam, not packaged UI behavior or
compatibility with every Codex version.

Claude print mode uses an explicit allow-list of just these browser MCP tools so
calls can reach the pane gate. This transport allow-list is not approval to execute
the browser action. Ordinary Claude native tools retain their native permission
restrictions; print mode does not provide an interactive, exact native-tool
permission channel through generic chat confirmation. The adapter refuses such
confirmation while its browser connection is active and does not enable broad
permission bypass.

In-app V4 uses its own exact-action conversation approvals, binding tool, arguments,
configuration and the reviewed session/tab/document/control target, then dispatches
directly to the shared browser. It does
not use the native MCP pane gate. Unattended V4 tasks cannot approve browser work.
Configured external MCP clients in `v4_agent/mcp.rs` are a separate integration;
`workspace_browser_mcp.rs` implements this native-browser server.

Control is unclaimed, human-owned or owned by one agent label. **Take control**
cancels pending native requests and invalidates old queued control generations.
Agent mutations fail until **Let agents control**; other agent labels wait for
the owning agent to release. Fresh approved reads of permitted pages remain
possible during human control without selecting another tab or installing an
agent policy. Takeover does not undo an action that already completed.

A shared-browser error is returned to the caller. It never triggers a new isolated
browser or a separately installed Chrome fallback. Agents must use the shared
browser and wait for returned control instead of launching another browser.

## Privacy and origin boundaries

This is one shared context: tabs, cookies and sign-ins can be used by approved
agents for the same account across conversations/workspaces. It is separate from
personal browser profiles; the app never attaches to or imports those profiles.
Before any email content **or metadata** access, obtain explicit consent for that
specific address/scope in the current task **and the exact email address**, then
wait for the answer. “Check my email,” an origin allow-list entry, an existing
sign-in or generic tool approval is insufficient. Never infer the address from
browser state, account metadata or history. This requirement is an agent policy,
not automatic detection of every email page or private-data operation.

Agent tab listings filter out disallowed origins. Target operations require an
allowed current page and a matching tab/main-document identity. The helper
installs origin policy on agent-controlled pages and inherited popups, checks HTTP
requests/redirects, and checks WebSockets through routing and a loopback proxy.
Service workers are blocked. Proxy policy can restrict connections across the
shared context, so a resource on another origin can fail until explicitly allowed.
Approved reads during human control do not install new policy. Choosing **Take
control**, and authorized human input mutations, release agent policies across
the session.

These checks are not an OS network/filesystem sandbox or a guarantee about every
Chromium internal channel. Arbitrary JavaScript still needs exact approval and
must treat page text, scripts and tool results as untrusted data. Password input
values are redacted in semantic snapshots; screenshots and other visible page
content may still contain sensitive information.

## Tools and lifecycle

Website dialogs queue across tabs. Each OK/Cancel decision is bound to the displayed
dialog ID, and prompt inputs start with the website's default value. Captures larger
than 5.5 MB return a size error without ending the shared session; reduce the viewport
or page detail before retrying.

| Tool | Shared-browser behavior |
| --- | --- |
| `browser_open` | Lazily open the shared browser and create an approved tab |
| `browser_navigate` | Navigate a reviewed tab to an approved URL |
| `browser_snapshot` | Read visible text and document-specific element refs |
| `browser_get_images` | List image URLs and alternative text in the reviewed document |
| `browser_click` / `browser_type` / `browser_select` | Interact with reviewed element refs; typing does not submit automatically |
| `browser_scroll` / `browser_wait` | Bounded scroll or wait for text/ref/readiness |
| `browser_back` / `browser_forward` | Navigate the reviewed tab's history under origin policy |
| `browser_screenshot` | Return the reviewed tab viewport as base64 PNG |
| `browser_evaluate` | Run the exact approved script in the reviewed page's main JavaScript context |
| `browser_tabs` | List allowed tabs, or switch by ID |
| `browser_close` | Close a tab, or the entire shared session if `tabId` is omitted |
| `browser_release_control` | Native MCP only: release this agent label without closing tabs |

Snapshots keep element refs in an isolated JavaScript world for each document.
Navigation replaces the main-document identity; stale refs/targets fail. Open
shadow roots are inspected; closed roots and frame contents are not expanded.
The pane's JPEG frames differ from agent PNG screenshot results.

Image listing includes hidden images and images in open shadow roots. It visits at
most 5,000 elements and returns at most 200 images and 60 KB of JSON, reporting
when it truncates the result. Inline data is identified without returning its
bytes; unsupported, credential-bearing, and oversized URLs are omitted. The tool
does not fetch image data. HTTP(S) addresses can include sensitive query values,
so the exact action requires approval. Both browser paths bind image listing to
the reviewed tab, document, and allowed origin. Standalone snapshots, selects,
waits, and scripts also use the reviewed tab and document; a wait fails if that
document is replaced while it is polling. Scripts retain access to the page's
normal JavaScript environment and can perform the approved side effects. Standalone
approval displays the tab and origin,
without including potentially sensitive URL queries. A replacement document or
browser session requires a fresh approval; same-document navigation within the
origin retains the reviewed document. Other standalone actions are not covered by
this document-binding guarantee. Neither path inspects closed shadow roots or
iframe documents.

Standalone browser actions coordinate with settings writes through a per-account
file lock. The action rechecks the settings and a saved revision after acquiring
the lock; changing settings and then changing them back does not revive an old
approval. If an action is active, a settings save can return a
retryable error without saving; retry after the action finishes. A cancelled
action retains its lock while the owned protocol connection is waiting for that
request. If the connection fails without a response, the browser retains the
lease until its owned process and protocol worker cleanup are confirmed; stop the agent or retry
cleanup if settings remain busy. These guarantees require cooperating current-version processes and a local filesystem
with working locks and intact browser-settings files. Older binaries and direct
file edits do not participate. A standalone click supervises mouse press and
release even if its caller is cancelled. Other browser actions wait for release;
if either acknowledgement is unconfirmed, the browser stays fenced until it is
closed. Cancellation after the press can still complete the click, and a settings
save cannot undo navigation or page scripts already initiated.

The server admits eight account/data-directory sessions and eight tabs per
session. Viewports range from 320–1920 by 240–1200; the default is 1280×800.
The current pane pauses manual input while its own resize is waiting for a new
frame. A gesture invalidated by resize, pointer cancellation, dialog handling,
or agent takeover is released without a click when the helper can confirm it.
Pane closure also requests cancellation, but a keepalive request can be lost if
the browser or network stops. An unconfirmed pointer may require resetting the
browser. Cancelled gesture identities are bounded; exhaustion also requires a
reset. Differently sized panes display the shared viewport at their own scale;
an explicit local resize or tab change can change the shared viewport.

Current frontend and helper versions bind manual input to the displayed tab,
document and view revision. A detected viewport change, wheel-driven scroll,
human typing or key, held-pointer movement, dialog decision, or supported mutating
agent operation causes another pane's stale input to be rejected. A short wheel,
scrolling-key or typing burst, or a single touch scroll, may continue from its
original frame only while no other tracked action has changed the view; otherwise
the user must retry after a fresh frame. Typing immediately after the same pane
focuses a field is also supported. The command queue is bounded, and an interrupted
drag is cancelled rather than resumed against a different view.

This is not a general snapshot guarantee: autonomous page changes, hover effects
and scrolling not driven by these tracked commands can still change the view.
Older clients omit the binding and gesture identity, and older helpers do not
enforce them, so upgrade both together for this protection. A new burst after a
pause can still require a fresh frame.

Commands are limited to 100 KB, helper responses to 8 MB and helper exchanges to
30 seconds. Agent wait arguments permit up to 60 seconds, subject to helper and
provider deadlines. Upload/download, persistent auth-state import/export and
personal-profile attachment are unavailable. Some sites reject automated Chromium.

Tabs and sign-ins survive hiding the pane. Reset, logout, server shutdown or
30 minutes without browser requests closes the owned helper/process tree. Failed
cleanup retains ownership for retry; remote environment selection does not move
the browser from the home API. Closing the shared session affects the human and
all conversations using it. Releasing agent control or ending a V4 integration
leaves the human session open.

## Standalone V4 boundary

A standalone CLI/PTY V4 process without a registered shared API host retains the
isolated CDP implementation in `v4_agent/browser.rs`. This is a distinct launch
mode, never recovery from a shared-session error. Its default engine resolves to
the same bundled Chromium; a saved absolute executable override applies only to
this path. It creates a private temporary profile per account/canonical workspace
under `<data>/v4-browser/<account hash>/profiles/<workspace hash>/isolated-<random>`
and never attaches to personal Chrome or a configured debugger endpoint.

Controlled close confirms process-tree stop, root-child reap and identity-checked
profile removal. Failed/cancelled cleanup retains its owner for retry. Raw Drop
signals processes but does not acknowledge cleanup or delete unconfirmed profiles;
hard crashes can leave residue and there is no durable crash sweep. Checked
profile identity is Unix-only, so this standalone path rejects launch on other
platforms, including Windows. That limitation does not describe the shared
Playwright helper's target support. Neither path claims protection against a
hostile process running as the same OS user.

## Verification and remaining coverage

The relevant checks are:

```sh
npm run test:browser-runtime
npm run browser:verify
node --test scripts/workspace-browser.test.cjs
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api workspace_browser
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api managed_shared_browser_mcp_and_real_workspace_ui -- --ignored
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib structured::claude_regressions
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib v4_agent::browser
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib agent_browser::tests
```

Installer tests cover staging/manifest/native-target behavior. Shared-helper tests
exercise bundled Chromium with synthetic pages, human/agent sharing, origin policy,
popups, redirects, WebSockets/workers, reviewed targets and RPC/modal behavior.
Rust fixtures cover account/capability ownership, exact decisions, cancellation,
queued-operation revocation and adapter wiring. The opt-in managed UI fixture in
`workspace_browser_integration_tests.rs` checks the shared MCP and real workspace
surface; it is ignored by default and requires a provisioned runtime and built
frontend. Standalone CDP tests
cover process/profile cleanup and protocol handling separately. A browser test
that skips for missing fixtures is not evidence of working browser behavior.

These commands document coverage, not results from this documentation update.
Compilation, live provider/UI checks, packaged installation on clean target
machines and ordinary Claude native-tool permission behavior must be verified
separately. No email account, private browser profile or real signed-in website
is needed for the synthetic checks.
