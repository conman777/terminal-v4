use rusqlite::{params, Connection, OptionalExtension, Result, TransactionBehavior};

#[derive(Clone)]
struct Scope<'a> {
    owner: &'a str,
    session: &'a str,
    generation: &'a str,
    workspace: &'a str,
}

fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE structured_invitations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL, generation TEXT NOT NULL, workspace TEXT NOT NULL, secret_hash TEXT NOT NULL, expires INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE structured_guests (credential_hash TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES structured_invitations(id));")
}

fn issue(
    db: &mut Connection,
    scope: &Scope<'_>,
    id: &str,
    secret: &str,
    expires: i64,
    uses: i64,
) -> Result<bool> {
    if [
        scope.owner,
        scope.session,
        scope.generation,
        scope.workspace,
        id,
        secret,
    ]
    .iter()
    .any(|value| value.is_empty())
        || !(1..=8).contains(&uses)
    {
        return Ok(false);
    }
    Ok(db.execute("INSERT INTO structured_invitations(id,owner,session,generation,workspace,secret_hash,expires,max_uses) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![id,scope.owner,scope.session,scope.generation,scope.workspace,super::hash(secret),expires,uses])? == 1)
}

fn exchange(
    db: &mut Connection,
    id: &str,
    secret: &str,
    credential: &str,
    now: i64,
) -> Result<bool> {
    if credential.is_empty() {
        return Ok(false);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let eligible = tx.query_row("SELECT 1 FROM structured_invitations WHERE id=?1 AND secret_hash=?2 AND expires>?3 AND revoked=0 AND uses<max_uses", params![id,super::hash(secret),now], |_| Ok(())).optional()?.is_some();
    if !eligible {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO structured_guests(credential_hash,invitation_id) VALUES (?1,?2)",
        params![super::hash(credential), id],
    )?;
    tx.execute(
        "UPDATE structured_invitations SET uses=uses+1 WHERE id=?1",
        [id],
    )?;
    tx.commit()?;
    Ok(true)
}

fn authorize(db: &Connection, scope: &Scope<'_>, credential: &str, now: i64) -> Result<bool> {
    Ok(db.query_row("SELECT 1 FROM structured_guests g JOIN structured_invitations i ON i.id=g.invitation_id WHERE g.credential_hash=?1 AND i.owner=?2 AND i.session=?3 AND i.generation=?4 AND i.workspace=?5 AND i.expires>?6 AND i.revoked=0", params![super::hash(credential),scope.owner,scope.session,scope.generation,scope.workspace,now], |_| Ok(())).optional()?.is_some())
}

fn revoke(db: &Connection, owner: &str, id: &str) -> Result<bool> {
    Ok(db.execute(
        "UPDATE structured_invitations SET revoked=1 WHERE id=?1 AND owner=?2 AND revoked=0",
        params![id, owner],
    )? == 1)
}

fn revoke_generation(db: &Connection, scope: &Scope<'_>) -> Result<usize> {
    db.execute("UPDATE structured_invitations SET revoked=1 WHERE owner=?1 AND session=?2 AND generation=?3 AND workspace=?4 AND revoked=0", params![scope.owner,scope.session,scope.generation,scope.workspace])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope<'a>(
        owner: &'a str,
        session: &'a str,
        generation: &'a str,
        workspace: &'a str,
    ) -> Scope<'a> {
        Scope {
            owner,
            session,
            generation,
            workspace,
        }
    }

    #[test]
    fn persisted_guest_is_scoped_to_owner_workspace_and_session_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invitations.sqlite");
        let mut db = Connection::open(&path).unwrap();
        initialize(&db).unwrap();
        let original = scope("owner", "session", "generation-1", "/workspace");
        assert!(issue(&mut db, &original, "invite", "invite-secret", 100, 1).unwrap());
        assert!(!exchange(&mut db, "invite", "wrong", "credential", 1).unwrap());
        assert!(exchange(&mut db, "invite", "invite-secret", "credential", 1).unwrap());
        assert!(!exchange(&mut db, "invite", "invite-secret", "credential-2", 1).unwrap());
        drop(db);
        let db = Connection::open(path).unwrap();
        assert!(authorize(&db, &original, "credential", 99).unwrap());
        for other in [
            scope("other", "session", "generation-1", "/workspace"),
            scope("owner", "other", "generation-1", "/workspace"),
            scope("owner", "session", "generation-2", "/workspace"),
            scope("owner", "session", "generation-1", "/other"),
        ] {
            assert!(!authorize(&db, &other, "credential", 99).unwrap());
        }
        assert!(!authorize(&db, &original, "credential", 100).unwrap());
    }

    #[test]
    fn owner_revocation_and_generation_cleanup_disable_new_and_existing_guests() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        let first = scope("owner", "session", "generation-1", "/workspace");
        let second = scope("owner", "other", "generation-1", "/workspace");
        for (scope, id, secret, credential) in [
            (&first, "first", "first-secret", "first-credential"),
            (&first, "second", "second-secret", "second-credential"),
            (&second, "other", "other-secret", "other-credential"),
        ] {
            assert!(issue(&mut db, scope, id, secret, 100, 2).unwrap());
            assert!(exchange(&mut db, id, secret, credential, 1).unwrap());
        }
        assert!(!revoke(&db, "stranger", "first").unwrap());
        assert!(authorize(&db, &first, "first-credential", 1).unwrap());
        assert!(revoke(&db, "owner", "first").unwrap());
        assert!(!authorize(&db, &first, "first-credential", 1).unwrap());
        assert!(!exchange(&mut db, "first", "first-secret", "new-credential", 1).unwrap());
        assert_eq!(revoke_generation(&db, &first).unwrap(), 1);
        assert!(!authorize(&db, &first, "second-credential", 1).unwrap());
        assert!(authorize(&db, &second, "other-credential", 1).unwrap());
    }

    #[test]
    fn simultaneous_exchange_respects_guest_limit_across_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invitations.sqlite");
        let mut db = Connection::open(&path).unwrap();
        initialize(&db).unwrap();
        let scope = scope("owner", "session", "generation", "/workspace");
        assert!(issue(&mut db, &scope, "invite", "secret", 100, 1).unwrap());
        drop(db);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["credential-1", "credential-2"]
            .into_iter()
            .map(|credential| {
                let barrier = barrier.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut db = Connection::open(path).unwrap();
                    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    exchange(&mut db, "invite", "secret", credential, 1).unwrap()
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
    }
}
