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

Note: Additional browser automation settings (idle timeout, max lifetime, cleanup intervals) are stored in a separate settings service file.

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
