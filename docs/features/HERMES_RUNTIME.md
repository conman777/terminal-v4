# Hermes compatibility and migration

V4 no longer launches or requires Hermes. API-key agents run in V4's independent
Rust runtime. See [V4 runtime](V4_RUNTIME.md) for tools, permissions, provider
protocols, history and verification boundaries.

The native-history importer can read an existing `HERMES_HOME/state.db` using
V4-owned SQLite queries and save a redacted, read-only visible transcript for a
reviewed handoff. It neither imports Hermes implementation code nor starts its
Python runtime. Existing Hermes source, tools and credentials are not bundled.

Historical comparison documents describe design inspiration and earlier gaps;
they are not guarantees of current feature parity.
