use super::*;
use crate::fixtures::{OPERATION, PROFILE, REQUEST};
use std::os::unix::fs::PermissionsExt;
fn root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
fn put() -> Value {
    json!({"operationId":OPERATION,"expectedRevision":null,"provider":"actual","mode":"local","baseUrl":"http://127.0.0.1:9/v1","auth":{"type":"none"}})
}
fn open(root: &Path, owner: &str) -> ConnectionService {
    ConnectionService::open_for_authenticated_execution(root, owner, "synthetic-server").unwrap()
}
#[test]
fn facade_is_send_and_request_body_cannot_choose_authenticated_scope() {
    fn send<T: Send>() {}
    send::<ConnectionService>();
    let root = root();
    let mut service = open(root.path(), "owner-A");
    let mut input = put();
    input["ownerId"] = json!("owner-B");
    assert_eq!(
        service.put(PROFILE, &input),
        Err(ConnectionError::InvalidInput)
    );
    assert_eq!(service.profiles().unwrap(), json!([]));
    let receipt = service.put(PROFILE, &put()).unwrap();
    assert_eq!(receipt["settingsSaved"], true);
    assert_eq!(receipt["cleanupConfirmed"], true);
    assert_eq!(
        service.profiles().unwrap()[0]["executionEnvironmentId"],
        "synthetic-server"
    );
}
#[test]
fn facade_profiles_and_discovery_lookup_are_owner_scoped() {
    let root = root();
    let mut first = open(root.path(), "owner-A");
    first.put(PROFILE, &put()).unwrap();
    let mut other = open(root.path(), "owner-B");
    assert_eq!(other.profiles().unwrap(), json!([]));
    assert_eq!(
        other.discover(PROFILE, REQUEST, 1),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(other.job(REQUEST), Err(ConnectionError::NotFound));
    assert_eq!(first.profiles().unwrap().as_array().unwrap().len(), 1);
}
#[test]
fn bearer_save_is_encrypted_redacted_and_exact_operation_retry_does_not_rotate() {
    let root = root();
    let mut service = open(root.path(), "owner-A");
    let input = json!({"operationId":OPERATION,"expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":"http://127.0.0.1:9/v1","auth":{"type":"bearer","credentialAction":"replace","secret":"synthetic-facade-private-token"}});
    let saved = service.put(PROFILE, &input).unwrap();
    let key = std::fs::read(root.path().join(storage::KEY_FILE)).unwrap();
    assert_eq!(service.put(PROFILE, &input).unwrap(), saved);
    assert_eq!(
        std::fs::read(root.path().join(storage::KEY_FILE)).unwrap(),
        key
    );
    assert!(!saved.to_string().contains("synthetic-facade-private-token"));
    assert!(!service
        .profiles()
        .unwrap()
        .to_string()
        .contains("synthetic-facade-private-token"));
    let raw = std::fs::read(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert!(!raw
        .windows(b"synthetic-facade-private-token".len())
        .any(|w| w == b"synthetic-facade-private-token"));
    let mut changed = input;
    changed["auth"]["secret"] = json!("different-synthetic-secret");
    assert_eq!(
        service.put(PROFILE, &changed),
        Err(ConnectionError::Conflict)
    );
}
#[test]
fn facade_cancel_tombstone_is_durable_and_prevents_network_on_replay() {
    let root = root();
    let mut service = open(root.path(), "owner-A");
    service.put(PROFILE, &put()).unwrap();
    service.cancel(PROFILE, REQUEST, 1).unwrap();
    drop(service);
    let mut loaded = open(root.path(), "owner-A");
    let job = loaded.discover(PROFILE, REQUEST, 2).unwrap();
    assert_eq!(job["status"], "cancelled");
    assert_eq!(job["cancelConfirmed"], true);
}
#[test]
fn tampered_checkpoint_fails_closed_and_preserves_the_feature_key() {
    let root = root();
    let mut service = open(root.path(), "owner-A");
    service.cancel(PROFILE, REQUEST, 1).unwrap();
    drop(service);
    let key = std::fs::read(root.path().join(storage::KEY_FILE)).unwrap();
    let connection = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    connection
        .execute(
            "UPDATE provider_connection_job_checkpoints SET payload=?1",
            [b"changed".as_slice()],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        ConnectionService::open_for_authenticated_execution(
            root.path(),
            "owner-A",
            "synthetic-server"
        ),
        Err(ConnectionError::StorageUnavailable)
    ));
    assert_eq!(
        std::fs::read(root.path().join(storage::KEY_FILE)).unwrap(),
        key
    );
}
#[test]
fn checkpoint_compare_and_swap_rejects_an_outdated_service_without_overwrite() {
    let root = root();
    let mut first = open(root.path(), "owner-A");
    let mut second = open(root.path(), "owner-A");
    assert_eq!(
        first.cancel(PROFILE, REQUEST, 1),
        Err(ConnectionError::StorageUnavailable)
    );
    assert_eq!(second.job(REQUEST), Err(ConnectionError::NotFound));
    assert_eq!(
        second.cancel(PROFILE, REQUEST, 2).unwrap()["status"],
        "cancelled"
    );
    drop(first);
    drop(second);
    let mut loaded = open(root.path(), "owner-A");
    assert_eq!(loaded.job(REQUEST).unwrap()["createdMs"], 2);
}

#[test]
fn malformed_target_and_missing_conditional_delete_are_typed_without_storage_changes() {
    let root = root();
    let mut service = open(root.path(), "owner-A");
    let mut input = put();
    input["baseUrl"] = json!("http://remote.example/v1");
    assert_eq!(
        service.put(PROFILE, &input),
        Err(ConnectionError::InvalidInput)
    );
    assert_eq!(service.profiles().unwrap(), json!([]));
    let input =
        json!({"operationId":OPERATION,"expectedRevision":"20000000-0000-4000-8000-000000000001"});
    assert_eq!(
        service.delete(PROFILE, &input),
        Err(ConnectionError::Conflict)
    );
}

#[test]
fn unchanged_reads_and_idle_ticks_do_not_rewrite_the_checkpoint() {
    let root = root();
    let mut service = open(root.path(), "owner-A");
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    let generation = || {
        db.query_row(
            "SELECT generation FROM provider_connection_job_checkpoints",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    let before = generation();
    for _ in 0..10 {
        assert_eq!(service.profiles().unwrap(), json!([]));
        assert_eq!(service.job(REQUEST), Err(ConnectionError::NotFound));
        let report = service.tick(1).unwrap();
        assert!(report.local_resources_stopped);
        assert!(report.cleanup_confirmed);
    }
    assert_eq!(generation(), before);
}
