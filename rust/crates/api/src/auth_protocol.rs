use rusqlite::{params, Connection, OptionalExtension, Transaction};

const PROTOCOL_VERSION: i64 = 1;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Inactive,
    Active,
}

fn valid_scope(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

pub(crate) fn install(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch("CREATE TABLE auth_protocol_cutovers (owner TEXT NOT NULL PRIMARY KEY, session TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE auth_protocol_installation (id INTEGER PRIMARY KEY CHECK(id=1), record_count INTEGER NOT NULL CHECK(record_count>=0));
        INSERT INTO auth_protocol_installation VALUES (1, 0);
        CREATE TRIGGER auth_protocol_count_insert AFTER INSERT ON auth_protocol_cutovers BEGIN
            UPDATE auth_protocol_installation SET record_count=record_count+1 WHERE id=1;
            SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT, 'auth protocol installation unavailable') END;
        END;")
        .map_err(|_| "Cannot install auth protocol store".into())
}

pub(crate) fn cutover(tx: &Transaction<'_>, owner: &str, session: &str) -> Result<(), String> {
    if !valid_scope(owner) || !valid_scope(session) {
        return Err("Invalid auth protocol scope".into());
    }
    if validate(tx, owner, session, None)? != Status::Inactive {
        return Err("Auth protocol scope already activated".into());
    }
    tx.execute(
        "INSERT INTO auth_protocol_cutovers (owner, session, version) VALUES (?1, ?2, ?3)",
        params![owner, session, PROTOCOL_VERSION],
    )
    .map_err(|_| "Cannot create auth protocol cutover".to_string())?;
    Ok(())
}

// The marker applies to every session for the owner. Callers must authenticate claims;
// an admission fence is also needed to order external effects against cutover.
pub(crate) fn validate(
    db: &Connection,
    owner: &str,
    session: &str,
    credential: Option<(&str, &str, i64)>,
) -> Result<Status, String> {
    if !valid_scope(owner)
        || (!session.is_empty() && !valid_scope(session))
        || (session.is_empty() && credential.is_some())
    {
        return Err("Invalid auth protocol scope".into());
    }
    let (expected, actual, owners, trigger, owner_rows, marker): (i64, i64, i64, bool, i64, Option<i64>) = db.query_row(
        "SELECT record_count, (SELECT count(*) FROM auth_protocol_cutovers), (SELECT count(DISTINCT owner) FROM auth_protocol_cutovers), EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='auth_protocol_count_insert'), (SELECT count(*) FROM auth_protocol_cutovers WHERE owner=?1), (SELECT version FROM auth_protocol_cutovers WHERE owner=?1) FROM auth_protocol_installation WHERE id=1",
        params![owner], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).optional().map_err(|_| "Auth protocol marker unavailable or corrupt".to_string())?
        .ok_or("Auth protocol marker unavailable or corrupt")?;
    if expected < 0 || expected != actual || owners != actual || !trigger {
        return Err("Auth protocol marker unavailable or corrupt".into());
    }
    match (owner_rows, marker) {
        (0, None) if credential.is_none() => Ok(Status::Inactive),
        (1, Some(PROTOCOL_VERSION)) if credential == Some((owner, session, PROTOCOL_VERSION)) => {
            Ok(Status::Active)
        }
        _ => Err("Auth protocol marker or credential rejected".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;

    #[test]
    fn auth_protocol_default_inactive_and_missing_store_fails_closed() {
        let mut db = Connection::open_in_memory().unwrap();
        assert!(validate(&db, "alice", "session-a", None).is_err());
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            validate(&db, "alice", "session-a", None).unwrap(),
            Status::Inactive
        );
    }

    #[test]
    fn auth_protocol_cutover_is_atomic_and_bound_to_owner_and_session() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            cutover(&tx, "alice", "session-a").unwrap();
        }
        assert_eq!(
            validate(&db, "alice", "session-a", None).unwrap(),
            Status::Inactive
        );
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        cutover(&tx, "alice", "session-a").unwrap();
        tx.commit().unwrap();
        assert_eq!(
            validate(&db, "alice", "session-a", Some(("alice", "session-a", 1))).unwrap(),
            Status::Active
        );
        for credential in [
            None,
            Some(("bob", "session-a", 1)),
            Some(("alice", "session-b", 1)),
            Some(("alice", "session-a", 0)),
            Some(("alice", "session-a", 2)),
        ] {
            assert!(validate(&db, "alice", "session-a", credential).is_err());
        }
        assert_eq!(
            validate(&db, "bob", "session-a", None).unwrap(),
            Status::Inactive
        );
        let tx = db.transaction().unwrap();
        assert!(cutover(&tx, "alice", "session-a").is_err());
    }

    #[test]
    fn account_cutover_rejects_legacy_credentials_for_every_session() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        cutover(&tx, "alice", "session-a").unwrap();
        tx.commit().unwrap();

        assert!(validate(&db, "alice", "legacy", None).is_err());
        assert!(validate(&db, "alice", "session-b", None).is_err());
        assert_eq!(
            validate(&db, "alice", "session-b", Some(("alice", "session-b", 1))).unwrap(),
            Status::Active
        );
        assert_eq!(
            validate(&db, "bob", "legacy", None).unwrap(),
            Status::Inactive
        );
        assert!(validate(&db, "bob", "session-b", Some(("bob", "session-b", 1))).is_err());
        assert!(db
            .execute(
                "INSERT INTO auth_protocol_cutovers VALUES (?1, ?2, ?3)",
                ("alice", "session-b", 1)
            )
            .is_err());
    }

    #[test]
    fn legacy_tokens_without_session_remain_usable_only_before_cutover() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(validate(&db, "alice", "", None).unwrap(), Status::Inactive);
        assert!(validate(&db, "alice", "", Some(("alice", "", 1))).is_err());
        let tx = db.transaction().unwrap();
        cutover(&tx, "alice", "new-session").unwrap();
        tx.commit().unwrap();
        assert!(validate(&db, "alice", "", None).is_err());
    }

    #[test]
    fn duplicate_owner_markers_in_an_old_store_fail_closed() {
        for (first, second) in [(1, 99), (99, 1)] {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE auth_protocol_cutovers (owner TEXT NOT NULL, session TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (owner, session));
                CREATE TABLE auth_protocol_installation (id INTEGER PRIMARY KEY, record_count INTEGER NOT NULL);
                INSERT INTO auth_protocol_installation VALUES (1, 0);
                CREATE TRIGGER auth_protocol_count_insert AFTER INSERT ON auth_protocol_cutovers BEGIN
                    UPDATE auth_protocol_installation SET record_count=record_count+1 WHERE id=1;
                END;").unwrap();
            db.execute(
                "INSERT INTO auth_protocol_cutovers VALUES ('alice', 'one', ?1)",
                [first],
            )
            .unwrap();
            db.execute(
                "INSERT INTO auth_protocol_cutovers VALUES ('alice', 'two', ?1)",
                [second],
            )
            .unwrap();
            assert!(validate(&db, "alice", "one", Some(("alice", "one", 1))).is_err());
            assert!(validate(&db, "bob", "legacy", None).is_err());
        }
    }

    #[test]
    fn null_version_in_an_old_store_does_not_reactivate_legacy_access() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_protocol_cutovers (owner TEXT NOT NULL, session TEXT NOT NULL, version INTEGER, PRIMARY KEY (owner, session));
            CREATE TABLE auth_protocol_installation (id INTEGER PRIMARY KEY, record_count INTEGER NOT NULL);
            INSERT INTO auth_protocol_installation VALUES (1, 0);
            CREATE TRIGGER auth_protocol_count_insert AFTER INSERT ON auth_protocol_cutovers BEGIN
                UPDATE auth_protocol_installation SET record_count=record_count+1 WHERE id=1;
            END;
            INSERT INTO auth_protocol_cutovers VALUES ('alice', 'one', NULL);").unwrap();
        assert!(validate(&db, "alice", "legacy", None).is_err());
        assert_eq!(
            validate(&db, "bob", "legacy", None).unwrap(),
            Status::Inactive
        );
    }

    #[test]
    fn auth_protocol_corrupt_marker_and_invalid_scope_fail_closed() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        db.execute(
            "INSERT INTO auth_protocol_cutovers VALUES (?1, ?2, ?3)",
            ("alice", "session-a", 99),
        )
        .unwrap();
        assert!(validate(&db, "alice", "session-a", Some(("alice", "session-a", 99))).is_err());
        db.execute("UPDATE auth_protocol_cutovers SET version = ?1", ["broken"])
            .unwrap();
        assert!(validate(&db, "alice", "session-a", None).is_err());
        assert!(validate(&db, "", "session-a", None).is_err());
        let tx = db.transaction().unwrap();
        assert!(cutover(&tx, "alice", "\n").is_err());
    }

    #[test]
    fn deleted_cutover_record_cannot_reactivate_legacy_access() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        cutover(&tx, "alice", "session-a").unwrap();
        tx.commit().unwrap();
        db.execute(
            "DELETE FROM auth_protocol_cutovers WHERE owner = ?1 AND session = ?2",
            ("alice", "session-a"),
        )
        .unwrap();
        assert!(validate(&db, "alice", "session-a", None).is_err());
        assert!(validate(&db, "bob", "session-b", None).is_err());
    }

    #[test]
    fn missing_installation_prevents_cutover_and_validation() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        db.execute("DELETE FROM auth_protocol_installation", [])
            .unwrap();
        let tx = db.transaction().unwrap();
        assert!(cutover(&tx, "alice", "session-a").is_err());
        tx.commit().unwrap();
        assert!(validate(&db, "alice", "session-a", None).is_err());
        let count: i64 = db
            .query_row("SELECT count(*) FROM auth_protocol_cutovers", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn missing_count_trigger_prevents_cutover_and_validation() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        db.execute("DROP TRIGGER auth_protocol_count_insert", [])
            .unwrap();
        assert!(validate(&db, "alice", "session-a", None).is_err());
        let tx = db.transaction().unwrap();
        assert!(cutover(&tx, "alice", "session-a").is_err());
        tx.commit().unwrap();
        let count: i64 = db
            .query_row("SELECT count(*) FROM auth_protocol_cutovers", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
