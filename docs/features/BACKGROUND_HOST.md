# Background host on Windows

`./scripts/manage-remote-host.ps1` separates the API process from desktop windows. No browser endpoint can install startup or execute these commands. Run setup directly on the owning computer.

1. Build the API and frontend production bundle. Set the existing host `JWT_SECRET`, `REFRESH_SECRET`, `STORAGE_DATABASE_URL`, and `TERMINAL_DATA_DIR` in the PowerShell environment before Initialize. Reusing the signing secret and data directory preserves login and paired-grant continuity. Missing signing secrets are generated securely for a new host.
2. Run `-Action Plan -ApiBinary <absolute terminal-v4-api.exe path>` to inspect paths. Add `-BindAddress 0.0.0.0 -AllowLan` only when network listening is intended.
3. Run `-Action Initialize` with the same arguments. It creates a user/SYSTEM-only configuration directory and DPAPI-encrypted environment credentials. An existing configuration is never overwritten. `-RuntimeRoot` defaults to the repository containing the script and is passed to native provider helpers; the API also starts with that working directory so frontend assets resolve.
4. Run `-Action Start`, then `-Action Status`. Run `-Action Install` for automatic startup after this Windows user signs in, including after reboot. This is a limited, interactive-user Task Scheduler task, not a system service or pre-login daemon. `-WhatIf` previews mutation actions.
5. Set `TERMINAL_V4_BACKEND_MODE=attach` in the environment launching the Tauri desktop app. It waits for the existing healthy localhost:3020 API and leaves it alive when the window closes. The default `owned` mode keeps its original lifecycle. Attachment does not start a missing host.

`-Action Stop` stops only a process matching the stored executable path and exact creation time. `-Action Uninstall` removes the logon task while preserving configuration and saved data. The launcher uses a file lock to prevent duplicate hosts and rejects junction/symlink paths. Credentials never appear in task arguments. Host logs are in the protected configuration directory.

Network binding does not add firewall rules or TLS. Use an HTTPS reverse proxy for encrypted remote connections. Existing login and permission checks remain required. Initialize captures only explicitly supported environment settings; after changing credentials, migrate configuration deliberately rather than overwriting a live host.

Validation: `./scripts/manage-remote-host.Tests.ps1` checks plan validation, encrypted configuration, and WhatIf without modifying startup. Set `TERMINAL_V4_HOST_SMOKE=1` for a harmless Rust fixture process start/status/stop smoke. Frontend tests are colocated in `RemoteHostPanel.test.jsx`.
