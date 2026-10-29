use super::store::{
    active_generation, building_generation, bump_revision, delete_doc, delete_everywhere, in_txn,
    indexed_stats, max_journal_seq, put_doc, put_skip, record, skipped_count, Fail,
};
use super::{now_ms, ChangeKind, Freshness, ManifestEntry, RecallIndex, Sources};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[cfg(test)]
thread_local! {
    pub(super) static CRASH_AT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
static CRASH_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn crash(point: &str) -> Result<(), Fail> {
    #[cfg(test)]
    {
        if CRASH_AT.with(|at| at.borrow().is_some_and(|expected| expected == point)) {
            return Err(Fail::Msg(format!("simulated crash at {point}")));
        }
        if std::env::var("RECALL_INDEX_ABORT_AT").is_ok_and(|expected| expected == point) {
            let limit: usize = std::env::var("RECALL_INDEX_ABORT_AFTER")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(1);
            if CRASH_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 >= limit {
                std::process::abort();
            }
        }
    }
    let _ = point;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RebuildProgress {
    pub generation: i64,
    pub remaining: usize,
    pub indexed: usize,
    pub skipped: usize,
    pub activated: bool,
    pub failed: Option<String>,
}

fn stat_matches(indexed: Option<&(u64, String)>, entry: &ManifestEntry) -> bool {
    indexed.is_some_and(|(size, mtime)| *size == entry.size && *mtime == entry.mtime_ns.to_string())
}

#[allow(dead_code)]
impl RecallIndex {
    pub(crate) fn record_change(&self, key: &str, kind: ChangeKind) -> Result<i64, String> {
        let connection = self.connect()?;
        in_txn(&connection, || record(&connection, key, kind)).map_err(|error| self.describe(error))
    }

    pub(crate) fn sync(&self, sources: &dyn Sources) -> Result<Freshness, String> {
        let connection = self.connect()?;
        self.sync_inner(&connection, sources)
            .map_err(|error| self.describe(error))
    }

    pub(super) fn sync_inner(
        &self,
        connection: &Connection,
        sources: &dyn Sources,
    ) -> Result<Freshness, Fail> {
        let Some((generation, _)) = active_generation(connection)? else {
            return Ok(Freshness::Incomplete(
                if building_generation(connection)?.is_some() {
                    "rebuilding"
                } else {
                    "no_active_generation"
                }
                .into(),
            ));
        };
        let pending: Vec<(i64, String, String)> = {
            let mut statement = connection
                .prepare("SELECT seq,key,kind FROM journal WHERE applied=0 ORDER BY seq")?;
            let rows =
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut dirty = HashSet::new();
        for (seq, key, kind) in &pending {
            if kind == "delete" {
                in_txn(connection, || {
                    delete_everywhere(connection, key)?;
                    connection
                        .execute("UPDATE journal SET applied=1 WHERE seq=?1", params![seq])?;
                    Ok(())
                })?;
            } else {
                dirty.insert(key.clone());
            }
        }
        let manifest = sources.manifest().map_err(Fail::Msg)?;
        if manifest.truncated || manifest.entries.len() > self.limits.max_manifest_entries {
            return Ok(Freshness::Incomplete("source_listing_truncated".into()));
        }
        let live: HashMap<&str, &ManifestEntry> = manifest
            .entries
            .iter()
            .map(|entry| (entry.key.as_str(), entry))
            .collect();
        let indexed = indexed_stats(connection, generation)?;
        let vanished: Vec<String> = indexed
            .keys()
            .filter(|key| !live.contains_key(key.as_str()))
            .cloned()
            .collect();
        for key in vanished {
            let seq = in_txn(connection, || record(connection, &key, ChangeKind::Delete))?;
            crash("after_delete_journal")?;
            in_txn(connection, || {
                delete_everywhere(connection, &key)?;
                connection.execute("UPDATE journal SET applied=1 WHERE seq=?1", params![seq])?;
                Ok(())
            })?;
            crash("before_tombstone_confirm")?;
        }
        let changed: Vec<&ManifestEntry> = manifest
            .entries
            .iter()
            .filter(|entry| {
                dirty.contains(&entry.key) || !stat_matches(indexed.get(&entry.key), entry)
            })
            .collect();
        let budget = self.limits.sync_max_docs;
        for entry in changed.iter().take(budget) {
            let kind = if indexed.contains_key(&entry.key) {
                ChangeKind::Update
            } else {
                ChangeKind::Create
            };
            let seq = in_txn(connection, || record(connection, &entry.key, kind))?;
            crash("after_change_journal")?;
            let doc = sources.read(entry);
            let outcome = in_txn(connection, || {
                match &doc {
                    Ok(doc) => match put_doc(
                        connection,
                        &self.owner,
                        generation,
                        entry,
                        doc,
                        &self.limits,
                    ) {
                        Ok(()) => {}
                        Err(Fail::Skip(reason)) => put_skip(connection, generation, entry, reason)?,
                        Err(error) => return Err(error),
                    },
                    Err(_) => put_skip(connection, generation, entry, "unreadable")?,
                }
                bump_revision(connection, generation)?;
                connection.execute("UPDATE journal SET applied=1 WHERE seq=?1", params![seq])?;
                crash("apply_before_commit")?;
                Ok(())
            });
            match outcome {
                Ok(()) => {}
                Err(Fail::TotalLimit) => {
                    return Ok(Freshness::Incomplete("index_size_limit".into()))
                }
                Err(error) => return Err(error),
            }
        }
        sweep_tombstones(connection)?;
        let remaining = changed.len().saturating_sub(budget);
        if remaining > 0 {
            return Ok(Freshness::Incomplete(format!(
                "pending_changes:{remaining}"
            )));
        }
        if !pending.is_empty() {
            in_txn(connection, || {
                for (seq, _, _) in &pending {
                    connection
                        .execute("UPDATE journal SET applied=1 WHERE seq=?1", params![seq])?;
                }
                Ok(())
            })?;
        }
        Ok(Freshness::Complete {
            generation,
            skipped: skipped_count(connection, generation)?,
        })
    }

    pub(crate) fn start_rebuild(&self, sources: &dyn Sources) -> Result<i64, String> {
        let connection = self.connect()?;
        self.start_rebuild_inner(&connection, sources)
            .map_err(|error| self.describe(error))
    }

    pub(super) fn start_rebuild_inner(
        &self,
        connection: &Connection,
        sources: &dyn Sources,
    ) -> Result<i64, Fail> {
        if let Some(generation) = building_generation(connection)? {
            return Ok(generation);
        }
        let manifest = sources.manifest().map_err(Fail::Msg)?;
        if manifest.truncated || manifest.entries.len() > self.limits.max_manifest_entries {
            return Err(Fail::Msg(
                "Conversation source set exceeds the recall index limit".into(),
            ));
        }
        let mut watermark: HashMap<&str, (usize, i128)> = HashMap::new();
        for entry in &manifest.entries {
            let slot = watermark.entry(entry.source.as_str()).or_default();
            slot.0 += 1;
            slot.1 = slot.1.max(entry.mtime_ns);
        }
        let watermark = serde_json::to_string(
            &watermark
                .into_iter()
                .map(|(source, (count, newest))| {
                    (
                        source.to_owned(),
                        serde_json::json!({"count":count,"maxMtimeNs":newest.to_string()}),
                    )
                })
                .collect::<std::collections::BTreeMap<_, _>>(),
        )
        .unwrap_or_default();
        in_txn(connection, || {
            if let Some(generation) = building_generation(connection)? {
                return Ok(generation);
            }
            let seq = max_journal_seq(connection)?;
            connection.execute(
                "INSERT INTO gens(state,start_seq,watermark,created_ms) VALUES('building',?1,?2,?3)",
                params![seq, watermark, now_ms()],
            )?;
            let generation = connection.last_insert_rowid();
            for entry in &manifest.entries {
                enqueue(connection, generation, entry, seq)?;
            }
            Ok(generation)
        })
    }

    pub(crate) fn rebuild_step(
        &self,
        sources: &dyn Sources,
        max_docs: usize,
    ) -> Result<RebuildProgress, String> {
        let connection = self.connect()?;
        self.rebuild_step_inner(&connection, sources, max_docs)
            .map_err(|error| self.describe(error))
    }

    pub(super) fn rebuild_step_inner(
        &self,
        connection: &Connection,
        sources: &dyn Sources,
        max_docs: usize,
    ) -> Result<RebuildProgress, Fail> {
        let Some(generation) = building_generation(connection)? else {
            return Err(Fail::Msg("No recall index rebuild is in progress".into()));
        };
        let mut processed = 0;
        let mut failed = None;
        while processed < max_docs {
            let row = connection
                .query_row(
                    "SELECT rid,key,source,doc_id,path,size,mtime_ns,seq FROM queue WHERE gen=?1 AND done=0 ORDER BY rid LIMIT 1",
                    params![generation],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            ManifestEntry {
                                key: row.get(1)?,
                                source: row.get(2)?,
                                id: row.get(3)?,
                                path: PathBuf::from(row.get::<_, String>(4)?),
                                size: row.get::<_, i64>(5)? as u64,
                                mtime_ns: row.get::<_, String>(6)?.parse().unwrap_or(0),
                            },
                            row.get::<_, i64>(7)?,
                        ))
                    },
                )
                .optional()?;
            let Some((rid, entry, seq)) = row else { break };
            let doc = sources.read(&entry);
            let outcome = in_txn(connection, || {
                let still_queued: bool = connection
                    .query_row(
                        "SELECT done=0 FROM queue WHERE rid=?1",
                        params![rid],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
                let tombstoned: bool = connection
                    .query_row(
                        "SELECT seq>?2 FROM tombstones WHERE key=?1",
                        params![entry.key, seq],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
                if still_queued && !tombstoned {
                    match &doc {
                        Ok(doc) => match put_doc(
                            connection,
                            &self.owner,
                            generation,
                            &entry,
                            doc,
                            &self.limits,
                        ) {
                            Ok(()) => {}
                            Err(Fail::Skip(reason)) => {
                                put_skip(connection, generation, &entry, reason)?
                            }
                            Err(error) => return Err(error),
                        },
                        Err(_) => put_skip(connection, generation, &entry, "unreadable")?,
                    }
                }
                connection.execute("UPDATE queue SET done=1 WHERE rid=?1", params![rid])?;
                Ok(())
            });
            match outcome {
                Ok(()) => {}
                Err(Fail::TotalLimit) => {
                    mark_failed(connection, generation, "total_size_limit")?;
                    failed = Some("total_size_limit".to_owned());
                    break;
                }
                Err(error) => return Err(error),
            }
            processed += 1;
            crash("after_doc")?;
        }
        let mut activated = false;
        let remaining = queue_remaining(connection, generation)?;
        if failed.is_none() && remaining == 0 {
            match self.finalize(connection, sources, generation)? {
                Finalize::Activated => activated = true,
                Finalize::Requeued => {}
                Finalize::Failed(reason) => failed = Some(reason),
            }
        }
        if activated {
            cleanup_retired(connection, 2_000)?;
        }
        Ok(RebuildProgress {
            generation,
            remaining: queue_remaining(connection, generation)?,
            indexed: count(connection, "docs", generation)?,
            skipped: count(connection, "skips", generation)?,
            activated,
            failed,
        })
    }

    fn finalize(
        &self,
        connection: &Connection,
        sources: &dyn Sources,
        generation: i64,
    ) -> Result<Finalize, Fail> {
        let manifest = sources.manifest().map_err(Fail::Msg)?;
        if manifest.truncated || manifest.entries.len() > self.limits.max_manifest_entries {
            mark_failed(connection, generation, "source_listing_truncated")?;
            return Ok(Finalize::Failed("source_listing_truncated".into()));
        }
        let indexed = indexed_stats(connection, generation)?;
        let live: HashSet<&str> = manifest
            .entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect();
        let vanished: Vec<&String> = indexed
            .keys()
            .filter(|key| !live.contains(key.as_str()))
            .collect();
        let changed: Vec<&ManifestEntry> = manifest
            .entries
            .iter()
            .filter(|entry| !stat_matches(indexed.get(&entry.key), entry))
            .collect();
        if !vanished.is_empty() || !changed.is_empty() {
            let rounds: u32 = connection.query_row(
                "SELECT catchup_rounds FROM gens WHERE id=?1",
                params![generation],
                |row| row.get(0),
            )?;
            if rounds >= self.limits.max_catchup_rounds {
                mark_failed(connection, generation, "source_churn")?;
                return Ok(Finalize::Failed("source_churn".into()));
            }
            in_txn(connection, || {
                for key in &vanished {
                    delete_doc(connection, generation, key)?;
                    connection.execute(
                        "DELETE FROM queue WHERE gen=?1 AND key=?2",
                        params![generation, key],
                    )?;
                }
                let seq = max_journal_seq(connection)?;
                for entry in &changed {
                    enqueue(connection, generation, entry, seq)?;
                }
                connection.execute(
                    "UPDATE gens SET catchup_rounds=catchup_rounds+1 WHERE id=?1",
                    params![generation],
                )?;
                Ok(())
            })?;
            return Ok(if changed.is_empty() {
                self.finalize(connection, sources, generation)?
            } else {
                Finalize::Requeued
            });
        }
        in_txn(connection, || {
            crash("before_activate")?;
            let state: Option<String> = connection
                .query_row(
                    "SELECT state FROM gens WHERE id=?1",
                    params![generation],
                    |row| row.get(0),
                )
                .optional()?;
            if state.as_deref() != Some("building") {
                return Err(Fail::Msg(
                    "Recall index rebuild is no longer current".into(),
                ));
            }
            connection.execute("UPDATE gens SET state='retired' WHERE state='active'", [])?;
            connection.execute(
                "UPDATE gens SET state='active', revision=revision+1 WHERE id=?1",
                params![generation],
            )?;
            connection.execute("DELETE FROM queue WHERE gen=?1", params![generation])?;
            Ok(())
        })?;
        Ok(Finalize::Activated)
    }
}

enum Finalize {
    Activated,
    Requeued,
    Failed(String),
}

fn enqueue(
    connection: &Connection,
    generation: i64,
    entry: &ManifestEntry,
    seq: i64,
) -> Result<(), Fail> {
    connection.execute(
        "INSERT INTO queue(gen,key,source,doc_id,path,size,mtime_ns,seq,done) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0)
         ON CONFLICT(gen,key) DO UPDATE SET path=excluded.path,size=excluded.size,mtime_ns=excluded.mtime_ns,seq=excluded.seq,done=0",
        params![
            generation,
            entry.key,
            entry.source,
            entry.id,
            entry.path.to_string_lossy(),
            entry.size as i64,
            entry.mtime_ns.to_string(),
            seq
        ],
    )?;
    Ok(())
}

fn queue_remaining(connection: &Connection, generation: i64) -> Result<usize, Fail> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM queue WHERE gen=?1 AND done=0",
        params![generation],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

fn count(connection: &Connection, table: &str, generation: i64) -> Result<usize, Fail> {
    let sql = match table {
        "docs" => "SELECT COUNT(*) FROM docs WHERE gen=?1",
        _ => "SELECT COUNT(*) FROM skips WHERE gen=?1",
    };
    let count: i64 = connection.query_row(sql, params![generation], |row| row.get(0))?;
    Ok(count as usize)
}

fn mark_failed(connection: &Connection, generation: i64, note: &str) -> Result<(), Fail> {
    connection.execute(
        "UPDATE gens SET state='failed', note=?2 WHERE id=?1 AND state='building'",
        params![generation, note],
    )?;
    Ok(())
}

fn sweep_tombstones(connection: &Connection) -> Result<(), Fail> {
    let keys: Vec<String> = {
        let mut statement = connection.prepare("SELECT key FROM tombstones")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for key in keys {
        in_txn(connection, || {
            let remaining: i64 = connection.query_row(
                "SELECT (SELECT COUNT(*) FROM docs WHERE key=?1) + (SELECT COUNT(*) FROM skips WHERE key=?1) + (SELECT COUNT(*) FROM queue WHERE key=?1 AND done=0)",
                params![key],
                |row| row.get(0),
            )?;
            let unapplied: i64 = connection.query_row(
                "SELECT COUNT(*) FROM journal WHERE key=?1 AND kind='delete' AND applied=0",
                params![key],
                |row| row.get(0),
            )?;
            if remaining == 0 && unapplied == 0 {
                connection.execute("DELETE FROM tombstones WHERE key=?1", params![key])?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

pub(super) fn cleanup_retired(connection: &Connection, chunk: usize) -> Result<(), Fail> {
    let generations: Vec<i64> = {
        let mut statement =
            connection.prepare("SELECT id FROM gens WHERE state IN ('retired','failed')")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for generation in generations {
        let keys: Vec<String> = {
            let mut statement = connection.prepare("SELECT key FROM docs WHERE gen=?1 LIMIT ?2")?;
            let rows = statement.query_map(params![generation, chunk as i64], |row| row.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        in_txn(connection, || {
            for key in &keys {
                delete_doc(connection, generation, key)?;
            }
            if keys.len() < chunk {
                connection.execute("DELETE FROM skips WHERE gen=?1", params![generation])?;
                connection.execute("DELETE FROM queue WHERE gen=?1", params![generation])?;
                connection.execute("DELETE FROM gens WHERE id=?1", params![generation])?;
            }
            Ok(())
        })?;
    }
    Ok(())
}
