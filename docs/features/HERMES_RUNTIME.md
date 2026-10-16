# Hermes runtime in Terminal v4

Terminal v4 launches the real Hermes CLI alongside Claude and Codex. The pinned reference source is NousResearch/hermes-agent revision `79651b71bd56efd76d06f3de1df64dde09b58ff3`. Its README explicitly supports native Windows, Linux, macOS, and WSL2. Python 3.14 is the supported runtime; the manifest permits older Python only to bootstrap updates.

## Isolated Windows setup

A complete cloned source tree, Git, network access, and a bootstrap Python 3.11 or newer are required. Run from the Terminal v4 checkout:

```powershell
./scripts/setup-hermes.ps1 -SourcePath 'C:/path/to/hermes-agent' -Plan
./scripts/setup-hermes.ps1 -SourcePath 'C:/path/to/hermes-agent'
```

The script uses upstream PM's `build_environment` with the pinned `uv.lock` and the `all` dependency extra. PM downloads and verifies its pinned Python and package manager. Build tools and dependency state stay in the source tree's `.setup-home`; the application environment stays in `.venv`. The script restores the calling process's `HERMES_HOME` and does not change global Python, PATH, credentials, or registry settings. It checks the Python version, core imports, CLI help, and chat help before publishing a successful result. Existing environments are verified rather than overwritten. A failed installation is reported as unavailable; inspect a partial environment before retrying.

Set the executable override in the same shell that starts the Terminal v4 backend:

```powershell
$env:HERMES_EXECUTABLE = 'C:/path/to/hermes-agent/.venv/Scripts/hermes.exe'
& $env:HERMES_EXECUTABLE setup
# Start Terminal v4 normally from this shell after configuration.
```

`setup` is an explicit interactive action that selects a model/provider and credentials. Terminal v4 does not run it automatically. The override applies to both the provider catalog and background task launcher. A backend already running must be restarted to inherit a new environment value. For future shells, add that environment assignment to your normal app startup script; setup deliberately does not modify the user environment. Runtime state uses Hermes's normal operator home unless you explicitly set `HERMES_HOME`. Hermes memory and skills remain managed by Hermes. Treat a shared operator profile as the operator's state, not as per-user Terminal v4 data.

Recheck an existing installation without installing packages:

```powershell
./scripts/setup-hermes.ps1 -SourcePath 'C:/path/to/hermes-agent' -Verify
./scripts/setup-hermes.Tests.ps1
& $env:HERMES_EXECUTABLE doctor
```

`doctor` reports configuration and optional tool requirements. `doctor --fix` changes state; `doctor --live` makes additional real calls. Neither is run by the setup script. No model request is needed to verify the CLI installation.

## This machine's verified installation

The reference clone is at `C:/Users/conor/OneDrive/Personal/Documents/coding projects/terminal v4/output/reference-sources/hermes-agent`.

```powershell
$env:HERMES_EXECUTABLE = 'C:/Users/conor/OneDrive/Personal/Documents/coding projects/terminal v4/output/reference-sources/hermes-agent/.venv/Scripts/hermes.exe'
```

The actual environment uses Python 3.14.7. Core imports and `hermes --help`, `hermes chat --help`, and `hermes doctor --help` passed. A passive doctor run against an empty isolated home confirmed the runtime and reported two expected setup issues: missing `.env` and missing provider/tool API configuration. Model authentication and a paid tool-using conversation have not been exercised. Browser, computer-use, external gateways, provider-specific services, and optional binaries still require their own configuration or upstream PM installation; Python dependencies alone do not imply those services are ready.

## Linux, macOS, or WSL2

The upstream README's standard installation is:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

For the same isolated source environment used here, run from a complete pinned Hermes checkout with Python 3.11 or newer:

```sh
HERMES_HOME="$PWD/.setup-home" python3 -c 'from pathlib import Path; from pm.operations import build_environment; build_environment(source=Path.cwd(), out=Path.cwd()/".venv", extras=("all",), explicit=True)'
export HERMES_EXECUTABLE="$PWD/.venv/bin/hermes"
"$HERMES_EXECUTABLE" --help
"$HERMES_EXECUTABLE" chat --help
"$HERMES_EXECUTABLE" setup
```

Start the Terminal v4 backend from that shell. The source installation commands are drawn from the pinned upstream PM API; Windows was verified locally. Linux/macOS installation was not executed in this Windows session.

## App API-provider bridge

For a supported API-key provider, configure its key through Terminal v4's provider
authentication UI. These sessions and background tasks use Hermes with a separate
app-account/provider profile and the current encrypted vault key. They do not
reuse the operator's configured Hermes credentials. The API catalog reports
unsupported or missing adapters explicitly. Provider authentication itself is
checked by Hermes when starting real work.

Do not put independent credentials in app-managed Hermes profile .env/auth.json
files; inline credentials there are refused so they cannot override the vault.
Hermes's environment-reference credential metadata is allowed without persisting
plaintext key values. This profile separation is not an operating-system sandbox:
agents still run with the backend host's filesystem/tool permissions.
