# Paired environments and conversation rewind

## Pair two Terminal v4 servers

Run the Rust API and sign in independently on each server. In the destination
server's **Environments** panel, choose **Create pairing code**. The random code
expires after two minutes and can be consumed once. On the home server, enter the
destination origin and code under **Pair another server**. HTTPS is preferred;
plain HTTP requires an explicit trusted-network opt-in. A label defaults to the
remote hostname.

Select **Use <label>** to work on that server. The persistent environment bar
identifies the selected host and its connection state. **Return home** works even
when the remote host is offline. Reloading restores the selected host after validating the saved device against the signed-in owner’s home directory. The selection is scoped to that owner and home origin; unavailable or revoked devices fall back to home.

Pairing authorizes runtime access as the account that created the destination
code. It does not log the browser into the destination's administrator/account
surfaces. The destination can revoke incoming access; the home server can
disconnect an outgoing pairing. Grants expire after 30 days. Pair only servers
and operators you trust with the target account's terminal and files.

The browser keeps its home identity. Runtime API calls, terminal and structured
WebSockets, downloads, event streams, and previews use the authenticated home
proxy. The paired credential stays encrypted on the home server and is sent to
the destination in headers or the terminal's first authentication message. It
is never returned to the browser or embedded in preview URLs. Preview cookies
are scoped to their environment proxy path. The proxy strips the home token
before forwarding requests.

Switching aborts requests from the previous environment and remounts the workspace
to close its sockets and clear transient state. Session IDs, layouts, project
paths, custom launcher choices, and preview state are stored separately per
environment. Account authentication and the account vault remain on the home
server. Configure remote provider API keys directly on the owning server;
paired provider status is read-only. Runtime grants do not authorize account
administration, vault access, arbitrary nested pairing, or unrestricted server
management. Unsupported account/process/voice controls are disabled remotely.

## Coordinated conversation and files rewind

Use **Tools > Git & worktrees** to create an isolated managed checkout and capture
files checkpoints while you work. In **Tools > Rewind**, select a native
conversation, the user turn to rewind **before**, and the files checkpoint to
restore. The conversation and files checkpoint are chosen separately; a
checkpoint does not infer which provider message it belongs to.

Choose **Review rewind plan** and inspect the exact turn and files checkpoint.
Suspend live workspace sessions before applying. Suspension stops the process
while retaining its saved transcript. Queued/running workspace tasks block the
coordinator rather than being silently cancelled.

**Apply rewind** first captures a recovery checkpoint of the current files.
It then creates a new provider-native branch before the selected user turn and
restores the selected files checkpoint. The original provider conversation stays
available. **Open resumed conversation** starts or reopens the resulting native
branch in Terminal v4. This uses real provider conversation state, rather than a
text-only handoff or merely hiding chat messages.

Provider behavior:

- Claude uses the Claude Agent SDK's native fork/resume boundary. Rewinding before
  the first user message is unavailable and is disabled in the picker.
- Codex uses its native app-server thread fork/revert protocol and durable turn
  IDs. Provider support is checked instead of fabricating a successful rewind.
- Hermes forks the native SessionDB conversation through the configured Hermes
  Python runtime.

Native source discovery is limited to fixed operator roots and the selected
workspace. As with native history import, those sources are host/operator
resources, not automatically isolated provider accounts for each app login.
Unsupported or incomplete native boundaries remain unavailable. No provider login
or model request is triggered by listing sources or reviewing a plan.

The owner-scoped rewind journal records planned, applied, resumed, failed and
recovered operations. Interrupted transitions can require explicit recovery and
retain branch-created information. File drift, active work and changed provider
sources are checked before mutation. If a later step fails, the record retains
the native branch and recovery checkpoint needed to recover. **Recover previous
files** restores the checkpoint captured just before that rewind, subject to the
same guarded managed-worktree restore checks. Recovery restores files; it does
not delete native branches or attempt to reverse external tool side effects.

See [API architecture](../architecture/API_ARCHITECTURE.md) for route contracts
and [Testing guide](../development/TESTING_GUIDE.md) for isolated checks.
