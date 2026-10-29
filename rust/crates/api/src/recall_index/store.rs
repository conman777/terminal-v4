use super::{now_ms, ChangeKind, IndexedDoc, Limits, ManifestEntry, RecallIndex};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use sha2::{Digest, Sha256};

pub(super) const SCHEMA_VERSION: &str = "1";
pub(super) const ROW_SPAN: i64 = 1_000_000;

pub(crate) enum Fail {
    Db(rusqlite::Error),
    Msg(String),
    Skip(&'static str),
    TotalLimit,
}

impl From<rusqlite::Error> for Fail {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error)
    }
}

impl From<String> for Fail {
    fn from(error: String) -> Self {
        Self::Msg(error)
    }
}

fn corrupt(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gens(
  id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  start_seq INTEGER NOT NULL, watermark TEXT NOT NULL, created_ms INTEGER NOT NULL,
  catchup_rounds INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
  source TEXT NOT NULL, doc_id TEXT NOT NULL, path TEXT NOT NULL, workspace_key TEXT NOT NULL,
  workspace TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_ms INTEGER, fingerprint TEXT NOT NULL, size INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL, messages INTEGER NOT NULL, text_bytes INTEGER NOT NULL,
  source_truncated INTEGER NOT NULL, UNIQUE(gen, key));
CREATE INDEX IF NOT EXISTS docs_scope ON docs(gen, owner, workspace_key);
CREATE TABLE IF NOT EXISTS skips(
  gen INTEGER NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,
  reason TEXT NOT NULL, PRIMARY KEY(gen, key));
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, role UNINDEXED, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS journal(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, kind TEXT NOT NULL,
  recorded_ms INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS journal_pending ON journal(applied, seq);
CREATE TABLE IF NOT EXISTS tombstones(
  key TEXT PRIMARY KEY, seq INTEGER NOT NULL, recorded_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS queue(
  rid INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL,
  doc_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,
  seq INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, UNIQUE(gen, key));
";

impl RecallIndex {
    fn try_connect(&self) -> Result<Connection, Fail> {
        let path = self.db_path();
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
            return Err(Fail::Msg("Recall index database path is not a file".into()));
        }
        let connection = Connection::open(&path)?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        connection.execute_batch("PRAGMA synchronous=FULL;")?;
        connection.execute_batch(SCHEMA)?;
        for (key, expected) in [
            ("schema", SCHEMA_VERSION.to_owned()),
            ("owner", hex::encode(Sha256::digest(self.owner.as_bytes()))),
        ] {
            connection.execute(
                "INSERT OR IGNORE INTO meta(key,value) VALUES(?1,?2)",
                params![key, expected],
            )?;
            let stored: String = connection.query_row(
                "SELECT value FROM meta WHERE key=?1",
                params![key],
                |row| row.get(0),
            )?;
            if stored != expected {
                return Err(Fail::Db(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                    Some("recall index metadata mismatch".into()),
                )));
            }
        }
        Ok(connection)
    }

    pub(super) fn connect(&self) -> Result<Connection, String> {
        match self.try_connect() {
            Ok(connection) => Ok(connection),
            Err(Fail::Db(error)) if corrupt(&error) => {
                self.quarantine();
                self.try_connect().map_err(|error| self.describe(error))
            }
            Err(error) => Err(self.describe(error)),
        }
    }

    pub(super) fn describe(&self, error: Fail) -> String {
        match error {
            Fail::Db(error) => {
                if corrupt(&error) {
                    self.quarantine();
                    "Recall index was corrupt and has been quarantined".into()
                } else {
                    format!("Recall index database error: {error}")
                }
            }
            Fail::Msg(message) => message,
            Fail::Skip(reason) => reason.into(),
            Fail::TotalLimit => "Recall index total size limit reached".into(),
        }
    }

    fn quarantine(&self) {
        let stamp = now_ms();
        let database = self.db_path();
        for suffix in ["", "-wal", "-shm"] {
            let from = self.dir.join(format!("index.sqlite{suffix}"));
            if std::fs::symlink_metadata(&from).is_ok() {
                let to = self
                    .dir
                    .join(format!("index.sqlite{suffix}.corrupt-{stamp}"));
                if std::fs::rename(&from, &to).is_err() {
                    let _ = std::fs::remove_file(&from);
                }
            }
        }
        let _ = database;
        let mut old: Vec<_> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("index.sqlite.corrupt-")
            })
            .map(|entry| entry.path())
            .collect();
        old.sort();
        while old.len() > 2 {
            let _ = std::fs::remove_file(old.remove(0));
        }
    }
}

pub(super) fn active_generation(connection: &Connection) -> Result<Option<(i64, i64)>, Fail> {
    Ok(connection
        .query_row(
            "SELECT id, revision FROM gens WHERE state='active' ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(super) fn building_generation(connection: &Connection) -> Result<Option<i64>, Fail> {
    Ok(connection
        .query_row(
            "SELECT id FROM gens WHERE state='building' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn bump_revision(connection: &Connection, generation: i64) -> Result<(), Fail> {
    connection.execute(
        "UPDATE gens SET revision=revision+1 WHERE id=?1",
        params![generation],
    )?;
    Ok(())
}

pub(super) fn max_journal_seq(connection: &Connection) -> Result<i64, Fail> {
    Ok(
        connection.query_row("SELECT COALESCE(MAX(seq),0) FROM journal", [], |row| {
            row.get(0)
        })?,
    )
}

pub(super) fn record(connection: &Connection, key: &str, kind: ChangeKind) -> Result<i64, Fail> {
    connection.execute(
        "INSERT INTO journal(key,kind,recorded_ms) VALUES(?1,?2,?3)",
        params![key, kind.name(), now_ms()],
    )?;
    let seq = connection.last_insert_rowid();
    if kind == ChangeKind::Delete {
        connection.execute(
            "INSERT INTO tombstones(key,seq,recorded_ms) VALUES(?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET seq=excluded.seq, recorded_ms=excluded.recorded_ms",
            params![key, seq, now_ms()],
        )?;
    } else {
        connection.execute(
            "DELETE FROM tombstones WHERE key=?1 AND seq<?2",
            params![key, seq],
        )?;
    }
    Ok(seq)
}

pub(super) fn delete_doc(
    connection: &Connection,
    generation: i64,
    key: &str,
) -> Result<bool, Fail> {
    let ids: Vec<i64> = {
        let mut statement = connection.prepare("SELECT id FROM docs WHERE gen=?1 AND key=?2")?;
        let rows = statement.query_map(params![generation, key], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in &ids {
        connection.execute(
            "DELETE FROM fts WHERE rowid>=?1 AND rowid<?2",
            params![id * ROW_SPAN, (id + 1) * ROW_SPAN],
        )?;
        connection.execute("DELETE FROM docs WHERE id=?1", params![id])?;
    }
    connection.execute(
        "DELETE FROM skips WHERE gen=?1 AND key=?2",
        params![generation, key],
    )?;
    Ok(!ids.is_empty())
}

pub(super) fn delete_everywhere(connection: &Connection, key: &str) -> Result<(), Fail> {
    let generations: Vec<i64> = {
        let mut statement = connection.prepare("SELECT id FROM gens")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for generation in generations {
        if delete_doc(connection, generation, key)? {
            bump_revision(connection, generation)?;
        }
    }
    connection.execute("DELETE FROM queue WHERE key=?1", params![key])?;
    Ok(())
}

pub(super) fn generation_bytes(connection: &Connection, generation: i64) -> Result<u64, Fail> {
    let total: i64 = connection.query_row(
        "SELECT COALESCE(SUM(text_bytes),0) FROM docs WHERE gen=?1",
        params![generation],
        |row| row.get(0),
    )?;
    Ok(total.max(0) as u64)
}

pub(super) fn put_doc(
    connection: &Connection,
    owner: &str,
    generation: i64,
    entry: &ManifestEntry,
    doc: &IndexedDoc,
    limits: &Limits,
) -> Result<(), Fail> {
    let text_bytes: usize = doc.title.len()
        + doc
            .messages
            .iter()
            .filter_map(|message| message.text.as_ref())
            .map(String::len)
            .sum::<usize>();
    if text_bytes > limits.max_doc_text_bytes || doc.messages.len() >= (ROW_SPAN - 1) as usize {
        return Err(Fail::Skip("oversized"));
    }
    delete_doc(connection, generation, &entry.key)?;
    if generation_bytes(connection, generation)?.saturating_add(text_bytes as u64)
        > limits.max_total_text_bytes
    {
        return Err(Fail::TotalLimit);
    }
    let workspace_key = hex::encode(Sha256::digest(
        crate::session_search::normalize_workspace_path(&doc.workspace).as_bytes(),
    ));
    let updated_ms = time::OffsetDateTime::parse(
        &doc.updated_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .map(|moment| (moment.unix_timestamp_nanos() / 1_000_000) as i64);
    connection.execute(
        "INSERT INTO docs(gen,owner,key,source,doc_id,path,workspace_key,workspace,title,provider,model,updated_at,updated_ms,fingerprint,size,mtime_ns,messages,text_bytes,source_truncated)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![
            generation,
            owner,
            entry.key,
            entry.source,
            entry.id,
            entry.path.to_string_lossy(),
            workspace_key,
            doc.workspace,
            doc.title,
            doc.provider,
            doc.model,
            doc.updated_at,
            updated_ms,
            doc.fingerprint,
            entry.size as i64,
            entry.mtime_ns.to_string(),
            doc.messages.len() as i64,
            text_bytes as i64,
            doc.source_truncated
        ],
    )?;
    let id = connection.last_insert_rowid();
    if !doc.title.trim().is_empty() {
        connection.execute(
            "INSERT INTO fts(rowid,text,role) VALUES(?1,?2,'title')",
            params![id * ROW_SPAN, doc.title],
        )?;
    }
    for message in &doc.messages {
        if let Some(text) = &message.text {
            connection.execute(
                "INSERT INTO fts(rowid,text,role) VALUES(?1,?2,?3)",
                params![id * ROW_SPAN + message.anchor as i64, text, message.role],
            )?;
        }
    }
    connection.execute(
        "DELETE FROM skips WHERE gen=?1 AND key=?2",
        params![generation, entry.key],
    )?;
    Ok(())
}

pub(super) fn put_skip(
    connection: &Connection,
    generation: i64,
    entry: &ManifestEntry,
    reason: &str,
) -> Result<(), Fail> {
    delete_doc(connection, generation, &entry.key)?;
    connection.execute(
        "INSERT OR REPLACE INTO skips(gen,key,size,mtime_ns,reason) VALUES(?1,?2,?3,?4,?5)",
        params![
            generation,
            entry.key,
            entry.size as i64,
            entry.mtime_ns.to_string(),
            reason
        ],
    )?;
    Ok(())
}

pub(super) fn indexed_stats(
    connection: &Connection,
    generation: i64,
) -> Result<std::collections::HashMap<String, (u64, String)>, Fail> {
    let mut stats = std::collections::HashMap::new();
    for sql in [
        "SELECT key,size,mtime_ns FROM docs WHERE gen=?1",
        "SELECT key,size,mtime_ns FROM skips WHERE gen=?1",
    ] {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![generation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (key, size, mtime) = row?;
            stats.insert(key, (size, mtime));
        }
    }
    Ok(stats)
}

pub(super) fn skipped_count(connection: &Connection, generation: i64) -> Result<usize, Fail> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM skips WHERE gen=?1",
        params![generation],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

pub(super) fn in_txn<T>(
    connection: &Connection,
    body: impl FnOnce() -> Result<T, Fail>,
) -> Result<T, Fail> {
    connection.execute_batch("BEGIN IMMEDIATE")?;
    match body() {
        Ok(value) => {
            connection.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
