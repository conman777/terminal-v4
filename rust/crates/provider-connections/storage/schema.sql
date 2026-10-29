-- Gate B dedicated schema design. Not applied by this agent.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS provider_connection_metadata (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connection_profiles (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    revision TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, environment_id, profile_id)
);
CREATE TABLE IF NOT EXISTS provider_connection_credentials (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    credential_id TEXT NOT NULL, generation TEXT NOT NULL,
    binding_json TEXT NOT NULL, ciphertext TEXT NOT NULL,
    PRIMARY KEY (owner_id, environment_id, profile_id, credential_id),
    UNIQUE (owner_id, environment_id, profile_id, generation),
    FOREIGN KEY (owner_id, environment_id, profile_id)
        REFERENCES provider_connection_profiles(owner_id, environment_id, profile_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS provider_connection_tombstones (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    revision TEXT NOT NULL, operation_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, environment_id, profile_id)
);
CREATE TABLE IF NOT EXISTS provider_connection_operations (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('put','delete')),
    payload_tag BLOB NOT NULL, saved_revision TEXT NOT NULL, receipt_json TEXT NOT NULL,
    revoked_json TEXT, revocations_json TEXT NOT NULL,
    cleanup_confirmed INTEGER NOT NULL CHECK(cleanup_confirmed IN (0,1)),
    PRIMARY KEY (owner_id, environment_id, profile_id, operation_id)
);
CREATE TRIGGER IF NOT EXISTS immutable_operation_identity
BEFORE UPDATE OF owner_id, environment_id, profile_id, operation_id, action,
    payload_tag, saved_revision, receipt_json, revoked_json, revocations_json
ON provider_connection_operations BEGIN SELECT RAISE(ABORT,'immutable operation'); END;
CREATE TRIGGER IF NOT EXISTS retained_operation_identity
BEFORE DELETE ON provider_connection_operations BEGIN SELECT RAISE(ABORT,'retained operation'); END;
CREATE TABLE IF NOT EXISTS provider_connection_revision_revocations (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    revision TEXT NOT NULL, operation_id TEXT NOT NULL, reference_json TEXT NOT NULL,
    PRIMARY KEY(owner_id, environment_id, profile_id, revision, operation_id)
);
CREATE TABLE IF NOT EXISTS provider_connection_discoveries (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    request_id TEXT NOT NULL, config_revision TEXT NOT NULL,
    status TEXT NOT NULL, cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)),
    PRIMARY KEY(owner_id, environment_id, profile_id, request_id)
);
-- Future cooperative actor registry only. Gate B supplies no admission API/stop claim.
CREATE TABLE IF NOT EXISTS provider_connection_actors (
    owner_id TEXT NOT NULL, environment_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, process_instance_id TEXT NOT NULL, lease_id TEXT NOT NULL,
    config_revision TEXT NOT NULL, credential_generation TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','revoked','quiescent')),
    revocation_operation_id TEXT,
    PRIMARY KEY(owner_id, environment_id, profile_id, actor_id, process_instance_id, lease_id)
);
PRAGMA user_version = 1;
