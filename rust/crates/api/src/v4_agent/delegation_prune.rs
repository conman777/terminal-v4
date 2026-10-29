//! Bounded pruning of fully delivered delegation records.
//!
//! Only a record with a committed outcome and a verified queue receipt is ever
//! pruned. It leaves a small tombstone that keeps its operation, child and task
//! identities consumed and its binding digest, so a replayed admission is still
//! recognised and never relaunches a child. Undelivered, uncertain and unfinished
//! records are never touched. When the tombstone table is full, pruning stops and
//! admission fails closed.
use super::*;
use sha2::{Digest, Sha256};

pub(super) const MAX_TOMBSTONES: i64 = 262_144;
const RETAINED_AFTER_PRUNE: i64 = MAX_RECORDS / 2;

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS pruned (owner TEXT NOT NULL, operation_id TEXT NOT NULL, child TEXT NOT NULL, task TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(owner, operation_id), UNIQUE(owner, child), UNIQUE(owner, task));";

fn digest(binding: &str) -> String {
    format!("{:x}", Sha256::digest(binding.as_bytes()))
}

pub(super) fn tombstone_count(db: &Connection) -> Result<i64> {
    db.query_row("SELECT count(*) FROM pruned", [], |row| row.get(0))
        .map_err(|_| "Invalid outbox schema".into())
}

pub(super) fn replayed(db: &Connection, binding: &Binding) -> Result<Option<Admission>> {
    let expected = digest(&encode(binding)?);
    let found: Option<String> = db
        .query_row(
            "SELECT digest FROM pruned WHERE owner=?1 AND operation_id=?2",
            params![binding.owner, binding.operation_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read pruned delegation identity")?;
    if let Some(found) = found {
        return if found == expected {
            Ok(Some(Admission::Existing))
        } else {
            Err("Delegation binding conflict".into())
        };
    }
    let reused: i64 = db
        .query_row(
            "SELECT count(*) FROM pruned WHERE owner=?1 AND (child=?2 OR task=?3)",
            params![binding.owner, binding.child_session, binding.task],
            |row| row.get(0),
        )
        .map_err(|_| "Cannot read pruned delegation identity")?;
    if reused != 0 {
        return Err("Delegation identity already used".into());
    }
    Ok(None)
}

/// Removes the oldest delivered records, keeping at most half the ledger's
/// capacity, and returns how many were removed. Must run in the caller's
/// immediate transaction.
pub(super) fn prune_delivered(db: &Connection) -> Result<i64> {
    let count: i64 = db
        .query_row("SELECT count(*) FROM records", [], |row| row.get(0))
        .map_err(|_| "Cannot check outbox capacity")?;
    let room = MAX_TOMBSTONES - tombstone_count(db)?;
    let limit = (count - RETAINED_AFTER_PRUNE).min(room);
    if limit <= 0 {
        return Ok(0);
    }
    let mut candidates = Vec::new();
    {
        let mut statement = db
            .prepare("SELECT owner, operation_id, child, task, binding FROM records WHERE terminal IS NOT NULL AND receipt IS NOT NULL ORDER BY rowid LIMIT ?1")
            .map_err(|_| "Cannot inspect delivered delegations")?;
        let mut rows = statement
            .query(params![limit])
            .map_err(|_| "Cannot inspect delivered delegations")?;
        while let Some(row) = rows
            .next()
            .map_err(|_| "Cannot inspect delivered delegations")?
        {
            let get = |index| row.get::<_, String>(index);
            candidates.push((
                get(0).map_err(|_| "Corrupt outbox record")?,
                get(1).map_err(|_| "Corrupt outbox record")?,
                get(2).map_err(|_| "Corrupt outbox record")?,
                get(3).map_err(|_| "Corrupt outbox record")?,
                digest(&get(4).map_err(|_| "Corrupt outbox record")?),
            ));
        }
    }
    for (owner, operation, child, task, digest) in &candidates {
        db.execute(
            "INSERT INTO pruned(owner,operation_id,child,task,digest) VALUES(?1,?2,?3,?4,?5)",
            params![owner, operation, child, task, digest],
        )
        .map_err(|_| "Cannot record pruned delegation identity")?;
        db.execute(
            "DELETE FROM records WHERE owner=?1 AND operation_id=?2 AND terminal IS NOT NULL AND receipt IS NOT NULL",
            params![owner, operation],
        )
        .map_err(|_| "Cannot prune delivered delegation")?;
    }
    Ok(candidates.len() as i64)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::followup_queue::{Mutation, MutationReceipt, QueueOperation};

    fn binding(index: i64) -> Binding {
        Binding {
            owner: "owner".into(),
            data_root: "/tmp".into(),
            parent_session: "parent".into(),
            parent_turn: "turn".into(),
            parent_incarnation: None,
            queue_identity: Uuid::new_v4(),
            child_session: format!("child-{index}"),
            task: format!("task-{index}"),
            workspace: "/tmp/workspace".into(),
            provider: "openai-api".into(),
            model: "model-1".into(),
            prompt: "Inspect the project".into(),
            permission: Permission::ReadOnlyChild,
            operation_id: Uuid::new_v4(),
            authorization: None,
        }
    }

    fn terminal(b: &Binding) -> Terminal {
        Terminal {
            outcome: Outcome::Succeeded,
            result: "exact result".into(),
            source_digest: None,
            mutation: Mutation {
                operation_id: b.operation_id,
                expected_queue_revision: 5,
                operation: QueueOperation::Enqueue {
                    item_id: Uuid::new_v4(),
                    text: "exact result".into(),
                    run_when_idle: false,
                },
            },
        }
    }

    fn receipt(t: &Terminal) -> MutationReceipt {
        let QueueOperation::Enqueue { item_id, .. } = t.mutation.operation else {
            unreachable!()
        };
        MutationReceipt {
            operation_id: t.mutation.operation_id,
            queue_revision: 6,
            item_id: Some(item_id),
            item_revision: Some(1),
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum State {
        Delivered,
        Undelivered,
        Uncertain,
        Unfinished,
    }

    fn open_store() -> (tempfile::TempDir, std::path::PathBuf, Outbox) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = dir.path().join("outbox");
        let outbox = Outbox::create(&path).unwrap();
        (dir, path, outbox)
    }

    fn reopen(path: &Path) -> Outbox {
        for _ in 0..100 {
            match Outbox::open(path) {
                Ok(store) => return store,
                Err(error) if error == "Outbox is already in use" => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("Cannot reopen outbox: {error}"),
            }
        }
        panic!("Outbox remained locked");
    }

    fn fill(outbox: &Outbox, state: impl Fn(i64) -> State) -> Vec<(Binding, State)> {
        let mut db = outbox.db.lock().unwrap();
        let tx = db.transaction().unwrap();
        let mut rows = Vec::new();
        for index in 0..MAX_RECORDS {
            let b = binding(index);
            let state = state(index);
            let t = terminal(&b);
            let (terminal, receipt, attempted) = match state {
                State::Delivered => (
                    Some(encode(&t).unwrap()),
                    Some(encode(&receipt(&t)).unwrap()),
                    1,
                ),
                State::Undelivered => (Some(encode(&t).unwrap()), None, 0),
                State::Uncertain => (Some(encode(&t).unwrap()), None, 1),
                State::Unfinished => (None, None, 0),
            };
            tx.execute(
                "INSERT INTO records(owner,operation_id,child,task,binding,terminal,receipt,delivery_attempted) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![b.owner, b.operation_id.to_string(), b.child_session, b.task, encode(&b).unwrap(), terminal, receipt, attempted],
            )
            .unwrap();
            rows.push((b, state));
        }
        tx.commit().unwrap();
        rows
    }

    fn fresh(index: i64) -> Binding {
        binding(10_000 + index)
    }

    #[test]
    fn full_ledger_prunes_only_delivered_records_and_still_refuses_their_replay() {
        let (_dir, path, outbox) = open_store();
        let rows = fill(&outbox, |index| match index % 4 {
            0 => State::Delivered,
            1 => State::Undelivered,
            2 => State::Uncertain,
            _ => State::Unfinished,
        });
        let new = fresh(1);
        assert_eq!(outbox.admit(&new).unwrap(), Admission::New);
        drop(outbox);

        let outbox = reopen(&path);
        let retained: std::collections::HashSet<Uuid> = outbox
            .list("owner")
            .unwrap()
            .into_iter()
            .map(|record| record.binding.operation_id)
            .collect();
        let delivered: Vec<&Binding> = rows
            .iter()
            .filter(|(_, state)| *state == State::Delivered)
            .map(|(b, _)| b)
            .collect();
        assert_eq!(delivered.len(), 256);
        assert!(delivered
            .iter()
            .all(|b| !retained.contains(&b.operation_id)));
        assert!(rows
            .iter()
            .filter(|(_, state)| *state != State::Delivered)
            .all(|(b, _)| retained.contains(&b.operation_id)));
        assert!(retained.contains(&new.operation_id));
        assert_eq!(retained.len(), 1024 - 256 + 1);
        assert_eq!(tombstone_count(&outbox.db.lock().unwrap()).unwrap(), 256);

        assert_eq!(outbox.admit(delivered[0]).unwrap(), Admission::Existing);
        let mut altered = delivered[1].clone();
        altered.prompt = "A different prompt".into();
        assert_eq!(
            outbox.admit(&altered),
            Err("Delegation binding conflict".to_string())
        );
        let mut reused = fresh(2);
        reused.child_session = delivered[2].child_session.clone();
        assert_eq!(
            outbox.admit(&reused),
            Err("Delegation identity already used".to_string())
        );
        let mut reused_task = fresh(3);
        reused_task.task = delivered[3].task.clone();
        assert!(outbox.admit(&reused_task).is_err());
        assert!(outbox
            .read("owner", delivered[0].operation_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn full_ledger_of_delivered_records_keeps_the_newest_half() {
        let (_dir, path, outbox) = open_store();
        let rows = fill(&outbox, |_| State::Delivered);
        assert_eq!(outbox.admit(&fresh(1)).unwrap(), Admission::New);
        drop(outbox);

        let outbox = reopen(&path);
        let retained: Vec<Uuid> = {
            let mut records = outbox.list("owner").unwrap();
            records.retain(|record| record.binding.child_session != fresh(1).child_session);
            records
                .into_iter()
                .map(|record| record.binding.operation_id)
                .collect()
        };
        assert_eq!(retained.len(), 512);
        assert!(rows[512..]
            .iter()
            .all(|(b, _)| retained.contains(&b.operation_id)));
        assert_eq!(outbox.admit(&rows[0].0).unwrap(), Admission::Existing);
        assert_eq!(tombstone_count(&outbox.db.lock().unwrap()).unwrap(), 512);
    }

    #[test]
    fn full_ledger_without_delivered_records_refuses_and_prunes_nothing() {
        let (_dir, path, outbox) = open_store();
        let rows = fill(&outbox, |index| {
            if index % 2 == 0 {
                State::Undelivered
            } else {
                State::Uncertain
            }
        });
        assert!(outbox.admit(&fresh(1)).is_err());
        drop(outbox);

        let outbox = reopen(&path);
        let records = outbox.list("owner").unwrap();
        assert_eq!(records.len(), rows.len());
        assert_eq!(tombstone_count(&outbox.db.lock().unwrap()).unwrap(), 0);
        assert!(records.iter().all(|record| record.receipt.is_none()));
    }

    #[test]
    fn full_tombstone_table_stops_pruning_and_refuses_admission() {
        let (_dir, path, outbox) = open_store();
        fill(&outbox, |_| State::Delivered);
        outbox
            .db
            .lock()
            .unwrap()
            .execute(
                "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1 < ?1) INSERT INTO pruned SELECT 'gone', 'op-' || i, 'child-' || i, 'task-' || i, 'x' FROM n",
                params![MAX_TOMBSTONES],
            )
            .unwrap();
        assert!(outbox.admit(&fresh(1)).is_err());
        drop(outbox);

        let outbox = reopen(&path);
        assert_eq!(outbox.list("owner").unwrap().len(), MAX_RECORDS as usize);
        assert_eq!(
            tombstone_count(&outbox.db.lock().unwrap()).unwrap(),
            MAX_TOMBSTONES
        );
    }
}
