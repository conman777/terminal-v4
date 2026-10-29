use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use uuid::Uuid;

#[path = "owner_registry.rs"]
mod owner_registry;

const MAX_OWNERS: usize = 4096;

/// The callback must call `check_before_write` immediately before canonical
/// persistence. Its final check is the expiry linearization point: the write
/// may finish after expiry. Logout cannot commit until this transaction ends.
/// Callback errors roll back SQLite, but any separately persisted canonical
/// receipt must still be reconciled. A false commit flag is also uncertain.
pub(super) struct SharedOwnerAdmission<'a> {
    state: &'a crate::state::AppState,
}

pub(super) struct PersistAdmission<'a> {
    tx: &'a rusqlite::Transaction<'a>,
    owner: &'a str,
    authority: &'a crate::auth::LocalAuthority,
}

impl PersistAdmission<'_> {
    fn check_before_write(&self) -> Result<(), String> {
        let held: bool = self
            .tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                [self.owner],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect structured owner hold")?;
        if held {
            return Err("Structured owner cleanup is in progress".into());
        }
        let current: i64 = self
            .tx
            .query_row(
                "SELECT COALESCE((SELECT generation FROM auth_generations WHERE user_id=?1),0)",
                [self.owner],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect structured authorization")?;
        let (generation, _) = self
            .authority
            .valid_for(self.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Structured authorization is invalid or expired")?;
        if generation != current {
            return Err("Structured authorization has been revoked".into());
        }
        Ok(())
    }
}

impl<'a> SharedOwnerAdmission<'a> {
    fn new(state: &'a crate::state::AppState) -> Self {
        Self { state }
    }

    #[cfg(test)]
    fn initialize(state: &crate::state::AppState) -> Result<(), String> {
        state.lock_db()?.execute_batch(
            "CREATE TABLE structured_owner_holds (owner TEXT PRIMARY KEY, request TEXT NOT NULL)",
        ).map_err(|_| "Cannot initialize structured owner admission".into())
    }

    fn hold(tx: &rusqlite::Transaction<'_>, owner: &str, request: Uuid) -> Result<(), String> {
        validate_owner(owner)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                [owner],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect structured owner holds")?;
        if !exists {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM structured_owner_holds", [], |row| {
                    row.get(0)
                })
                .map_err(|_| "Cannot inspect structured owner holds")?;
            if count >= MAX_OWNERS as i64 {
                return Err("Structured owner hold capacity reached".into());
            }
        }
        tx.execute(
            "INSERT INTO structured_owner_holds(owner,request) VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET request=excluded.request",
            rusqlite::params![owner, request.to_string()],
        ).map_err(|_| "Cannot hold structured owner")?;
        Ok(())
    }

    fn release(tx: &rusqlite::Transaction<'_>, owner: &str, request: Uuid) -> Result<(), String> {
        validate_owner(owner)?;
        let removed = tx
            .execute(
                "DELETE FROM structured_owner_holds WHERE owner=?1 AND request=?2",
                rusqlite::params![owner, request.to_string()],
            )
            .map_err(|_| "Cannot release structured owner hold")?;
        if removed != 1 {
            return Err("Structured owner hold changed".into());
        }
        Ok(())
    }

    fn admit<T, E>(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        accept: impl FnOnce(&PersistAdmission<'_>) -> Result<T, E>,
    ) -> Result<(Result<T, E>, bool), String> {
        validate_owner(owner)?;
        let mut db = self.state.lock_db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Structured owner admission unavailable")?;
        let guard = PersistAdmission {
            tx: &tx,
            owner,
            authority,
        };
        guard.check_before_write()?;
        match accept(&guard) {
            Ok(value) => Ok((Ok(value), tx.commit().is_ok())),
            Err(error) => {
                let _ = tx.rollback();
                Ok((Err(error), false))
            }
        }
    }
}

fn validate_owner(owner: &str) -> Result<(), String> {
    if owner.trim().is_empty() || owner.len() > 256 || owner.chars().any(char::is_control) {
        return Err("Invalid owner".into());
    }
    Ok(())
}

pub(super) struct OwnerAdmission {
    owners: Mutex<HashMap<String, OwnerState>>,
    changed: Notify,
}

struct OwnerState {
    epoch: Uuid,
    hold: Option<Uuid>,
    inflight: usize,
}

pub(super) struct Ticket {
    owner: String,
    epoch: Uuid,
}

#[derive(Clone)]
pub(super) struct Hold {
    owner: String,
    id: Uuid,
}

pub(super) struct Permit {
    gate: Arc<OwnerAdmission>,
    owner: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut owners = self
            .gate
            .owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(state) = owners.get_mut(&self.owner) {
            state.inflight -= 1;
            if state.inflight == 0 {
                self.gate.changed.notify_waiters();
            }
        }
    }
}

impl OwnerAdmission {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            owners: Mutex::new(HashMap::new()),
            changed: Notify::new(),
        })
    }

    fn state<'a>(
        owners: &'a mut HashMap<String, OwnerState>,
        owner: &str,
    ) -> Result<&'a mut OwnerState, String> {
        if owner.is_empty() || owner.len() > 256 || owner.chars().any(char::is_control) {
            return Err("Invalid owner".into());
        }
        if !owners.contains_key(owner) && owners.len() >= MAX_OWNERS {
            return Err("Owner admission capacity reached".into());
        }
        Ok(owners
            .entry(owner.to_owned())
            .or_insert_with(|| OwnerState {
                epoch: Uuid::new_v4(),
                hold: None,
                inflight: 0,
            }))
    }

    fn ticket(&self, owner: &str) -> Result<Ticket, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        let state = Self::state(&mut owners, owner)?;
        if state.hold.is_some() {
            return Err("Owner cleanup is in progress".into());
        }
        Ok(Ticket {
            owner: owner.to_owned(),
            epoch: state.epoch,
        })
    }

    fn enter(self: &Arc<Self>, ticket: &Ticket) -> Result<Permit, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        let state = owners
            .get_mut(&ticket.owner)
            .ok_or("Owner admission unavailable")?;
        if state.hold.is_some() || state.epoch != ticket.epoch {
            return Err("Owner admission is stale or held".into());
        }
        state.inflight = state
            .inflight
            .checked_add(1)
            .ok_or("Owner admission capacity reached")?;
        Ok(Permit {
            gate: self.clone(),
            owner: ticket.owner.clone(),
        })
    }

    fn hold(&self, owner: &str) -> Result<Hold, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        let state = Self::state(&mut owners, owner)?;
        if state.hold.is_some() {
            return Err("Owner cleanup is already in progress".into());
        }
        let id = Uuid::new_v4();
        state.epoch = Uuid::new_v4();
        state.hold = Some(id);
        Ok(Hold {
            owner: owner.to_owned(),
            id,
        })
    }

    fn current_hold(&self, owner: &str) -> Result<Option<Hold>, String> {
        let owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        Ok(owners
            .get(owner)
            .and_then(|state| state.hold)
            .map(|id| Hold {
                owner: owner.to_owned(),
                id,
            }))
    }

    fn enter_cleanup(self: &Arc<Self>, hold: &Hold) -> Result<Permit, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        let state = owners
            .get_mut(&hold.owner)
            .ok_or("Owner hold unavailable")?;
        if state.hold != Some(hold.id) {
            return Err("Owner hold is stale".into());
        }
        state.inflight = state
            .inflight
            .checked_add(1)
            .ok_or("Owner admission capacity reached")?;
        Ok(Permit {
            gate: self.clone(),
            owner: hold.owner.clone(),
        })
    }

    async fn wait_idle(&self, hold: &Hold) -> Result<(), String> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let owners = self
                    .owners
                    .lock()
                    .map_err(|_| "Owner admission unavailable")?;
                let state = owners.get(&hold.owner).ok_or("Owner hold unavailable")?;
                if state.hold != Some(hold.id) {
                    return Err("Owner hold is stale".into());
                }
                if state.inflight == 0 {
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    fn release(&self, hold: &Hold) -> Result<(), String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner admission unavailable")?;
        let state = owners
            .get_mut(&hold.owner)
            .ok_or("Owner hold unavailable")?;
        if state.hold != Some(hold.id) {
            return Err("Owner hold is stale".into());
        }
        if state.inflight != 0 {
            return Err("Owner cleanup is still in progress".into());
        }
        state.hold = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn shared_admission_rejects_expired_revoked_and_held_credentials() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "shared-owner-admission-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        SharedOwnerAdmission::initialize(&state).unwrap();
        let admission = SharedOwnerAdmission::new(&state);
        let now = crate::v4_agent::interaction::now_ms();
        let old = crate::auth::LocalAuthority::for_test("alice", 0, now + 60_000);
        let expired = crate::auth::LocalAuthority::for_test("alice", 0, now - 1);
        let wrong = crate::auth::LocalAuthority::for_test("bob", 0, now + 60_000);
        assert!(admission
            .admit("alice", &expired, |_| Ok::<_, String>(()))
            .is_err());
        assert!(admission
            .admit("alice", &wrong, |_| Ok::<_, String>(()))
            .is_err());
        let first = Uuid::new_v4();
        {
            let mut db = state.lock_db().unwrap();
            let tx = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            SharedOwnerAdmission::hold(&tx, "alice", first).unwrap();
            tx.execute(
                "INSERT INTO auth_generations(user_id,generation) VALUES('alice',1)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let fresh = crate::auth::LocalAuthority::for_test("alice", 1, now + 60_000);
        assert!(admission
            .admit("alice", &old, |_| Ok::<_, String>(()))
            .is_err());
        assert!(admission
            .admit("alice", &fresh, |_| Ok::<_, String>(()))
            .is_err());
        let second = Uuid::new_v4();
        {
            let mut db = state.lock_db().unwrap();
            let tx = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            SharedOwnerAdmission::hold(&tx, "alice", second).unwrap();
            assert!(SharedOwnerAdmission::release(&tx, "alice", first).is_err());
            SharedOwnerAdmission::release(&tx, "alice", second).unwrap();
            tx.commit().unwrap();
        }
        assert!(admission
            .admit("alice", &old, |_| Ok::<_, String>(()))
            .is_err());
        assert_eq!(
            admission
                .admit("alice", &fresh, |_| Ok::<_, String>(42))
                .unwrap(),
            (Ok(42), true)
        );
    }

    #[test]
    fn shared_admission_serializes_acceptance_with_logout_transaction() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "shared-owner-admission-fixture".into(),
            ..Default::default()
        };
        let first = crate::state::AppState::new(config.clone()).unwrap();
        let second = crate::state::AppState::new(config).unwrap();
        SharedOwnerAdmission::initialize(&first).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "alice",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let first_ref = &first;
            let authority_ref = &authority;
            let submit = scope.spawn(move || {
                SharedOwnerAdmission::new(first_ref).admit("alice", authority_ref, |_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok::<_, String>("accepted")
                })
            });
            entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let logout = scope.spawn(|| {
                let mut db = second.lock_db().unwrap();
                let tx = db
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .unwrap();
                SharedOwnerAdmission::hold(&tx, "alice", Uuid::new_v4()).unwrap();
                tx.execute(
                    "INSERT INTO auth_generations(user_id,generation) VALUES('alice',1)",
                    [],
                )
                .unwrap();
                tx.commit().unwrap();
                finished_tx.send(()).unwrap();
            });
            assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
            release_tx.send(()).unwrap();
            assert_eq!(submit.join().unwrap().unwrap(), (Ok("accepted"), true));
            finished_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            logout.join().unwrap();
        });
        assert!(SharedOwnerAdmission::new(&first)
            .admit("alice", &authority, |_| Ok::<_, String>(()))
            .is_err());
    }

    #[test]
    fn shared_admission_rechecks_expiry_after_a_delayed_callback() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "shared-owner-admission-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        SharedOwnerAdmission::initialize(&state).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "alice",
            0,
            crate::v4_agent::interaction::now_ms() + 50,
        );
        let outcome = SharedOwnerAdmission::new(&state)
            .admit("alice", &authority, |guard| {
                std::thread::sleep(Duration::from_millis(80));
                guard.check_before_write()?;
                Ok::<_, String>("would persist")
            })
            .unwrap();
        assert!(outcome.0.is_err());
        assert!(!outcome.1);
    }

    #[test]
    fn shared_admission_rolls_back_callback_errors_and_exposes_commit_failure() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "shared-owner-admission-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        SharedOwnerAdmission::initialize(&state).unwrap();
        state.lock_db().unwrap().execute_batch(
            "PRAGMA foreign_keys=ON; CREATE TABLE admission_parent(id INTEGER PRIMARY KEY); CREATE TABLE admission_child(parent INTEGER REFERENCES admission_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TABLE admission_marker(value INTEGER)"
        ).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "alice",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let admission = SharedOwnerAdmission::new(&state);
        let outcome = admission
            .admit("alice", &authority, |guard| {
                guard
                    .tx
                    .execute("INSERT INTO admission_marker VALUES(1)", [])
                    .unwrap();
                Err::<(), _>("callback failed")
            })
            .unwrap();
        assert_eq!(outcome, (Err("callback failed"), false));
        let count: i64 = state
            .lock_db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM admission_marker", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let receipt = data.path().join("canonical-receipt");
        let outcome = admission
            .admit("alice", &authority, |guard| {
                guard.check_before_write().unwrap();
                std::fs::write(&receipt, "accepted").unwrap();
                guard
                    .tx
                    .execute("INSERT INTO admission_child VALUES(999)", [])
                    .unwrap();
                Ok::<_, String>("accepted")
            })
            .unwrap();
        assert_eq!(outcome, (Ok("accepted"), false));
        assert_eq!(std::fs::read_to_string(receipt).unwrap(), "accepted");
        let count: i64 = state
            .lock_db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM admission_child", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn shared_logout_child() {
        let Some(path) = std::env::var_os("V4_TEST_OWNER_ADMISSION_ROOT") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        let mut db = rusqlite::Connection::open(path.join("terminal.db")).unwrap();
        db.busy_timeout(Duration::from_secs(5)).unwrap();
        std::fs::write(path.join("logout-ready"), "ready").unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        SharedOwnerAdmission::hold(&tx, "alice", Uuid::new_v4()).unwrap();
        tx.execute(
            "INSERT INTO auth_generations(user_id,generation) VALUES('alice',1)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        std::fs::write(path.join("logout-finished"), "done").unwrap();
    }

    #[test]
    fn shared_admission_fences_logout_in_another_process() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "shared-owner-admission-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        SharedOwnerAdmission::initialize(&state).unwrap();
        let authority = crate::auth::LocalAuthority::for_test(
            "alice",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let mut child = None;
        let result = SharedOwnerAdmission::new(&state)
            .admit("alice", &authority, |guard| {
                child = Some(
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("--exact")
                        .arg("structured::owner_admission::tests::shared_logout_child")
                        .env("V4_TEST_OWNER_ADMISSION_ROOT", data.path())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .unwrap(),
                );
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while !data.path().join("logout-ready").exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "logout process did not start"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::thread::sleep(Duration::from_millis(80));
                assert!(!data.path().join("logout-finished").exists());
                guard.check_before_write()?;
                std::fs::write(data.path().join("canonical-receipt"), "accepted").unwrap();
                Ok::<_, String>(())
            })
            .unwrap();
        assert_eq!(result, (Ok(()), true));
        assert!(child.unwrap().wait().unwrap().success());
        assert!(data.path().join("logout-finished").exists());
        assert!(SharedOwnerAdmission::new(&state)
            .admit("alice", &authority, |_| Ok::<_, String>(()))
            .is_err());
    }

    #[tokio::test]
    async fn hold_fences_old_tickets_and_waits_for_only_that_owners_work() {
        let gate = OwnerAdmission::new();
        let alice_ticket = gate.ticket("alice").unwrap();
        let alice_work = gate.enter(&alice_ticket).unwrap();
        let bob_ticket = gate.ticket("bob").unwrap();
        let bob_work = gate.enter(&bob_ticket).unwrap();
        let hold = gate.hold("alice").unwrap();
        assert!(gate.ticket("alice").is_err());
        assert!(gate.enter(&alice_ticket).is_err());
        assert!(gate.enter(&bob_ticket).is_ok());
        assert!(gate.release(&hold).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.wait_idle(&hold))
                .await
                .is_err()
        );
        drop(alice_work);
        let cleanup = gate.enter_cleanup(&hold).unwrap();
        assert!(gate.release(&hold).is_err());
        drop(cleanup);
        tokio::time::timeout(Duration::from_secs(1), gate.wait_idle(&hold))
            .await
            .unwrap()
            .unwrap();
        gate.release(&hold).unwrap();
        assert!(gate.enter(&alice_ticket).is_err());
        assert!(gate.enter(&gate.ticket("alice").unwrap()).is_ok());
        assert!(gate.enter_cleanup(&hold).is_err());
        drop(bob_work);
    }

    #[tokio::test]
    async fn abandoned_hold_remains_closed_and_stale_hold_cannot_release_a_new_one() {
        let gate = OwnerAdmission::new();
        let old = gate.hold("alice").unwrap();
        assert!(gate.hold("alice").is_err());
        let recovered = gate.current_hold("alice").unwrap().unwrap();
        gate.wait_idle(&recovered).await.unwrap();
        gate.release(&recovered).unwrap();
        let next = gate.hold("alice").unwrap();
        assert!(gate.release(&old).is_err());
        assert!(gate.ticket("alice").is_err());
        gate.release(&next).unwrap();
        assert!(gate.ticket("alice").is_ok());
    }

    #[test]
    fn hold_and_first_admission_cannot_pass_each_other_unaccounted() {
        for _ in 0..100 {
            let gate = OwnerAdmission::new();
            let ticket = gate.ticket("alice").unwrap();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            std::thread::scope(|scope| {
                let worker_gate = gate.clone();
                let worker_barrier = barrier.clone();
                let worker = scope.spawn(move || {
                    worker_barrier.wait();
                    worker_gate.enter(&ticket)
                });
                barrier.wait();
                let hold = gate.hold("alice").unwrap();
                let admitted = worker.join().unwrap();
                if let Ok(permit) = admitted {
                    assert!(gate.release(&hold).is_err());
                    drop(permit);
                }
                gate.release(&hold).unwrap();
            });
        }
    }

    #[tokio::test]
    async fn multiple_waiters_are_not_lost_when_last_permit_finishes() {
        let gate = OwnerAdmission::new();
        let ticket = gate.ticket("alice").unwrap();
        let permit = gate.enter(&ticket).unwrap();
        let hold = gate.hold("alice").unwrap();
        let first = tokio::spawn({
            let gate = gate.clone();
            let hold = hold.clone();
            async move { gate.wait_idle(&hold).await }
        });
        let second = tokio::spawn({
            let gate = gate.clone();
            let hold = hold.clone();
            async move { gate.wait_idle(&hold).await }
        });
        tokio::task::yield_now().await;
        drop(permit);
        tokio::time::timeout(Duration::from_secs(1), async {
            first.await.unwrap().unwrap();
            second.await.unwrap().unwrap();
        })
        .await
        .unwrap();
        gate.release(&hold).unwrap();
    }

    #[tokio::test]
    async fn signout_revocation_and_owner_hold_reject_a_delayed_authenticated_request() {
        let data = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "owner-admission-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        state
            .create_local_user_for_test("alice", "fixture-password")
            .unwrap();
        let original = state
            .login("alice", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let gate = OwnerAdmission::new();
        let delayed = gate.ticket(&original.user.id).unwrap();
        assert!(
            crate::auth::authenticate_local_token(&state, &original.tokens.access_token).is_ok()
        );
        let active = gate.enter(&delayed).unwrap();
        let hold = gate.hold(&original.user.id).unwrap();
        state.logout_user(&original.user.id).unwrap();
        assert!(gate.enter(&delayed).is_err());
        assert!(gate.release(&hold).is_err());
        drop(active);
        gate.wait_idle(&hold).await.unwrap();
        gate.release(&hold).unwrap();
        assert!(gate.enter(&delayed).is_err());
        let new_ticket = gate.ticket(&original.user.id).unwrap();
        let _permit = gate.enter(&new_ticket).unwrap();
        assert!(
            crate::auth::authenticate_local_token(&state, &original.tokens.access_token).is_err()
        );
        let fresh = state
            .login("alice", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        assert!(crate::auth::authenticate_local_token(&state, &fresh.tokens.access_token).is_ok());
    }
}
