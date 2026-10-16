# Database Schema

Terminal v4 uses SQLite for authentication and user settings. Most session data
is stored as JSON files under `backend/data/users/`.

## SQLite

Location:
- Default: `backend/data/terminal.db`
- Override with `TERMINAL_DATA_DIR` or `DATA_DIR`

### migrations
Tracks applied migrations.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | Primary key (autoincrement) |
| `name` | TEXT | Unique migration name |
| `applied_at` | TEXT | ISO timestamp |

### users
Stores user credentials.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | Primary key (UUID) |
| `username` | TEXT | Unique |
| `password_hash` | TEXT | bcrypt hash |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

Indexes:
- `idx_users_username` on `username`

### refresh_tokens
Stores hashed refresh tokens (rotation on refresh).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | Primary key (UUID) |
| `user_id` | TEXT | FK -> users.id |
| `token_hash` | TEXT | SHA-256 hash of refresh token |
| `expires_at` | TEXT | ISO timestamp |
| `created_at` | TEXT | ISO timestamp |

Indexes:
- `idx_refresh_tokens_user_id` on `user_id`
- `idx_refresh_tokens_token_hash` on `token_hash`

### user_settings
Stores per-user settings.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | TEXT | Primary key, FK -> users.id |
| `groq_api_key` | TEXT | Groq API key for voice transcription |
| `preview_url` | TEXT | Last-used preview URL |
| `terminal_font_size` | INTEGER | Terminal font size (8-32, default 14) |
| `sidebar_collapsed` | INTEGER | 0/1 boolean (sidebar collapsed state) |
| `updated_at` | TEXT | ISO timestamp |

Note: Browser-related preferences are stored in the existing user settings flow and API.

## File-Based Storage

These are JSON files stored under `backend/data/users/<userId>/`:

- `sessions/*.json` (terminal session history + metadata)
- `sessions-metadata.json` (lightweight title/cwd index for recovery)
- `claude-code/*.json` (Claude Code session events + metadata)
- `bookmarks.json` (command bookmarks)
- `notes.json` (notes)

## Preview Cookie Store

- File: `backend/data/preview-cookies.json`
- Override base dir with `TERMINAL_DATA_DIR` or `DATA_DIR`

## In-Memory Stores (Not Persisted)

- Preview logs (`/api/preview/:port/logs`)
- Proxy request logs (`/api/preview/:port/proxy-logs`)
- Process logs (`/api/process-logs`)

## Remote workspace persistence

The active Rust runtime uses AppConfig.data_dir/terminal.db (TERMINAL_DATA_DIR or DATA_DIR can override the platform application-data default). Legacy backend/data locations above describe the previous backend.

| Table | Scope and data |
| --- | --- |
| paired_device | Persistent server UUID |
| paired_codes | Hash, owner, username, label, expiry, profile and capabilities; one-use transaction |
| paired_grants | Grant UUID and credential hash, owner identity, label, timestamps, profile/capabilities |
| paired_environments | Owner connection metadata and encrypted remote credential; device UUID/hostname/OS, favourite/tags, recent workspace, last-seen/used |
| collaboration_invitations | Owner, canonical workspace, terminal ID, role, secret hash, expiry, bounded use counters and revocation |
| collaboration_guests | Invitation foreign identity, guest credential hash, display name, join/last-seen times |
| relay_devices | Broker-pinned device UUID and registration-secret hash |
| relay_host_secret | Host-only persistent registration secret; its broker counterpart is stored as a hash |

Feature initialization applies additive idempotent schema changes. Existing paired records receive operator permissions without newly introduced desktop/tunnel authority. Preserve the signing secret and SQLite data when moving a host so encrypted credentials and device identities remain usable. Raw pairing codes/invitation secrets are returned at creation and are not retained as plaintext database credentials.

Transfers store owner-hashed JSON records and staging bytes in the application data tree; completed uploads publish into the requested workspace. Recordings store owner-hashed bounded JSON tapes and status receipts. Rewind uses owner/workspace journal records with file fingerprints, provider branches and recovery checkpoint IDs. TCP listeners, desktop viewing sessions and relay stream registries are process-local and expire/stop rather than being silently recreated after restart. Browser device selection and download chunk caches are additionally partitioned by home identity/environment.
