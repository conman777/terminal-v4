use super::history::{self, Source};
use super::{checked_storage_path, session_reference};
use crate::recall_index::{
    self, IndexedDoc, Limits, Manifest, ManifestEntry, RecallIndex, SearchOutcome, SearchRequest,
    Sources,
};
use crate::session_search::safe_history_text;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::Cell, collections::HashSet, path::Path};

const PAGE_ENTRIES: usize = 2_000;
const MAX_PAGES: usize = 25;
const INDEX_READ_BUDGET: u64 = 80_000_000;

pub(super) struct HistorySources<'a> {
    data: &'a Path,
    owner: &'a str,
    workspace: &'a Path,
    omitted: Cell<usize>,
}

impl<'a> HistorySources<'a> {
    pub(super) fn new(data: &'a Path, owner: &'a str, workspace: &'a Path) -> Self {
        Self {
            data,
            owner,
            workspace,
            omitted: Cell::new(0),
        }
    }

    fn roots(&self) -> Vec<std::path::PathBuf> {
        let hashed = hex::encode(Sha256::digest(self.owner.as_bytes()));
        let mut roots = vec![
            self.data.join("v4-agent-history").join(&hashed),
            self.data.join("native-history").join(&hashed),
            self.data.join("structured-sessions").join(&hashed),
        ];
        roots.push(self.data.join("users").join(self.owner));
        roots
    }
}

impl Sources for HistorySources<'_> {
    fn manifest(&self) -> Result<Manifest, String> {
        let mut manifest = Manifest::default();
        let mut seen = HashSet::new();
        let mut omitted = 0;
        for page in 0..MAX_PAGES {
            let (candidates, more, page_omitted, warnings) = history::candidates(
                self.data,
                self.owner,
                self.workspace,
                true,
                page * PAGE_ENTRIES,
            );
            omitted += page_omitted + warnings.len();
            for candidate in candidates {
                let Some((size, mtime_ns)) = recall_index::file_stat(&candidate.path) else {
                    omitted += 1;
                    continue;
                };
                let Ok(relative) = candidate.path.strip_prefix(self.data) else {
                    omitted += 1;
                    continue;
                };
                let key = format!(
                    "{}:{}",
                    candidate.source.name(),
                    relative.to_string_lossy().replace('\\', "/")
                );
                if !seen.insert(key.clone()) {
                    continue;
                }
                let id = candidate
                    .path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                manifest.entries.push(ManifestEntry {
                    key,
                    source: candidate.source.name().to_owned(),
                    id,
                    path: candidate.path,
                    size,
                    mtime_ns,
                });
            }
            if !more {
                break;
            }
            if page + 1 == MAX_PAGES {
                manifest.truncated = true;
            }
        }
        manifest.omitted = omitted;
        self.omitted.set(omitted);
        Ok(manifest)
    }

    fn read(&self, entry: &ManifestEntry) -> Result<IndexedDoc, String> {
        let source = Source::parse(&entry.source)?;
        if !self.roots().iter().any(|root| entry.path.starts_with(root)) {
            return Err("Indexed conversation is outside this account's history".into());
        }
        checked_storage_path(self.data, &entry.path)?;
        let candidate = history::candidate_at(entry.path.clone(), source, entry.size);
        let transcript =
            history::read_candidate_with_budget(self.data, &candidate, INDEX_READ_BUDGET)?;
        let messages: Vec<(String, String)> = transcript
            .messages
            .iter()
            .map(|message| (message.role.clone(), message.text.clone()))
            .collect();
        Ok(IndexedDoc {
            workspace: transcript.workspace,
            title: safe_history_text(&transcript.title),
            provider: transcript.provider,
            model: transcript.model,
            updated_at: transcript.updated_at,
            fingerprint: transcript.fingerprint,
            messages: recall_index::redact_messages(&messages, safe_history_text),
            source_truncated: transcript.truncated,
        })
    }
}

pub(super) struct IndexFilters<'a> {
    pub query: &'a str,
    pub limit: usize,
    pub account: bool,
    pub source: Option<Source>,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub role: Option<&'a str>,
    pub updated_after: Option<time::OffsetDateTime>,
    pub updated_before: Option<time::OffsetDateTime>,
    pub cursor: Option<&'a str>,
    pub scope: &'a str,
}

pub(super) fn try_search(
    data: &Path,
    owner: &str,
    workspace: &Path,
    filters: &IndexFilters,
) -> Result<Result<Value, String>, String> {
    let unavailable = |reason: String| Ok(Err(reason));
    let index = match RecallIndex::open(data, owner, Limits::default()) {
        Ok(index) => index,
        Err(error) if filters.cursor.is_some() => return Err(error),
        Err(_) => return unavailable("index_unavailable".into()),
    };
    let sources = HistorySources::new(data, owner, workspace);
    let millis = |moment: time::OffsetDateTime| (moment.unix_timestamp_nanos() / 1_000_000) as i64;
    let request = SearchRequest {
        workspace: workspace.to_string_lossy().into_owned(),
        account: filters.account,
        query: filters.query.to_owned(),
        source: filters.source.map(|source| source.name().to_owned()),
        provider: filters.provider.map(str::to_owned),
        model: filters.model.map(str::to_owned),
        role: filters.role.map(str::to_owned),
        updated_after_ms: filters.updated_after.map(millis),
        updated_before_ms: filters.updated_before.map(millis),
        limit: filters.limit,
        cursor: filters.cursor.map(str::to_owned),
    };
    let outcome = match index.search(&request, &sources) {
        Ok(outcome) => outcome,
        Err(error) if filters.cursor.is_some() => return Err(error),
        Err(_) => return unavailable("index_error".into()),
    };
    let page = match outcome {
        SearchOutcome::Fallback(reason) => return unavailable(reason),
        SearchOutcome::Page(page) => page,
    };
    let sessions: Vec<Value> = page
        .hits
        .iter()
        .map(|hit| {
            let source = Source::parse(&hit.source).unwrap_or(Source::V4);
            json!({
                "sessionId": hit.id, "source": hit.source, "provider": hit.provider,
                "model": hit.model, "workspacePath": hit.workspace,
                "title": hit.title.chars().take(100).collect::<String>(),
                "updatedAt": hit.updated_at, "messages": hit.messages, "anchor": hit.anchor,
                "reference": session_reference(source, &hit.id, &hit.workspace, hit.anchor),
                "fingerprint": hit.fingerprint, "excerpt": hit.excerpt,
                "truncated": hit.truncated, "truncatedAtSource": hit.source_truncated,
            })
        })
        .collect();
    let mut result = json!({
        "sessions": sessions, "scanned": 0, "scannedBytes": 0, "unreadable": page.skipped,
        "scope": filters.scope, "nextOffset": null, "candidateLimitPerSource": PAGE_ENTRIES,
        "candidatePage": 0, "nextCandidatePage": null, "candidateScanTruncated": false,
        "omitted": sources.omitted.get(), "scanLimit": history::SCAN_FILES,
        "byteLimit": history::SCAN_BYTES, "warnings": [],
        "index": {
            "used": true, "complete": true, "generation": page.generation,
            "matchMode": "token_prefix", "skippedRecords": page.skipped,
            "nextCursor": page.next_cursor,
            "note": "Indexed token-prefix search over redacted text; mid-word substrings match only the bounded scan. Source listing omissions are counted in omitted.",
        },
    });
    if let Some(undated) = page.undated {
        result["undated"] = json!(undated);
    }
    Ok(Ok(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        data: tempfile::TempDir,
        workspace: std::path::PathBuf,
        _workspace_guard: tempfile::TempDir,
    }

    fn hashed(owner: &str) -> String {
        hex::encode(Sha256::digest(owner.as_bytes()))
    }

    fn fixture() -> Fixture {
        let data = tempfile::tempdir().unwrap();
        let guard = tempfile::tempdir().unwrap();
        let workspace = guard.path().canonicalize().unwrap();
        Fixture {
            data,
            workspace,
            _workspace_guard: guard,
        }
    }

    impl Fixture {
        fn enable(&self) {
            let directory = self.data.path().join("recall-index");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("ENABLED"), "").unwrap();
        }

        fn v4(&self, owner: &str, text: &str) -> String {
            let mut session =
                crate::v4_agent::new_session("openai-api", "fixture", &self.workspace);
            session.messages.push(crate::v4_agent::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: text.into(),
            });
            crate::v4_agent::save(self.data.path(), owner, &mut session).unwrap();
            session.id
        }

        fn terminal(&self, owner: &str, id: &str, fragments: &[&str]) {
            let db = rusqlite::Connection::open(self.data.path().join("terminal.db")).unwrap();
            db.execute_batch("CREATE TABLE IF NOT EXISTS users(id TEXT)")
                .unwrap();
            db.execute("INSERT INTO users(id) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=?1)", [owner]).unwrap();
            let directory = self.data.path().join("users").join(owner).join("sessions");
            std::fs::create_dir_all(&directory).unwrap();
            let history: Vec<_> = fragments
                .iter()
                .enumerate()
                .map(|(n, text)| json!({"text":text,"ts":n,"seq":n}))
                .collect();
            std::fs::write(
                directory.join(format!("{id}.json")),
                json!({"id":id,"title":"term","cwd":self.workspace,"createdAt":"2026-10-23T01:00:00Z","updatedAt":"2026-10-23T01:00:00Z","shell":"sh","history":history}).to_string(),
            )
            .unwrap();
        }

        fn structured(&self, owner: &str, id: &str, text: &str) {
            let directory = self
                .data
                .path()
                .join("structured-sessions")
                .join(hashed(owner));
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join(format!("{id}.json")),
                json!({"version":1,"ownerId":owner,"snapshot":{"id":id,"title":"structured","cwd":self.workspace,"provider":"deepseek","updatedAt":"2026-10-24T01:00:00Z","events":[{"type":"user_message_accepted","messageId":"m1","content":text}]}}).to_string(),
            )
            .unwrap();
        }

        fn imported(&self, owner: &str, text: &str) -> std::path::PathBuf {
            let key = hex::encode(Sha256::digest(
                crate::session_search::normalize_workspace_path(&self.workspace.to_string_lossy())
                    .as_bytes(),
            ));
            let directory = self
                .data
                .path()
                .join("native-history")
                .join(hashed(owner))
                .join(key);
            std::fs::create_dir_all(&directory).unwrap();
            let id = hex::encode(Sha256::digest(text.as_bytes()));
            let path = directory.join(format!("{id}.json"));
            std::fs::write(
                &path,
                json!({"sourceId":id,"workspacePath":self.workspace,"title":"imported","provider":"claude","updatedAt":"2026-10-25T01:00:00Z","messages":[{"role":"user","text":text}]}).to_string(),
            )
            .unwrap();
            path
        }

        fn recall(&self, owner: &str, input: Value) -> Value {
            serde_json::from_str(
                &super::super::dispatch(
                    self.data.path(),
                    owner,
                    &self.workspace,
                    "recall_sessions",
                    &input,
                )
                .unwrap(),
            )
            .unwrap()
        }

        fn ids(&self, owner: &str, query: &str) -> Vec<String> {
            let mut found: Vec<String> = self
                .recall(owner, json!({"query":query,"scope":"account","limit":25}))["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["sessionId"].as_str().unwrap().to_owned())
                .collect();
            found.sort();
            found
        }

        fn stored_text(&self, owner: &str) -> String {
            let path = self
                .data
                .path()
                .join("recall-index")
                .join(hashed(owner))
                .join("index.sqlite");
            let connection = rusqlite::Connection::open(path).unwrap();
            let mut statement = connection.prepare("SELECT text FROM fts").unwrap();
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap();
            rows.flatten().collect::<Vec<_>>().join("\n")
        }
    }

    const TERMINAL: &str = "pty-0001";
    const STRUCTURED: &str = "ss-00000000-0000-4000-8000-000000000001";

    #[test]
    fn index_is_off_by_default_and_scan_output_has_no_index_block() {
        let fixture = fixture();
        fixture.v4("owner", "needle in default scan");
        let result = fixture.recall("owner", json!({"query":"needle"}));
        assert_eq!(
            (
                result["sessions"].as_array().unwrap().len(),
                result.get("index")
            ),
            (1, None)
        );
        assert!(!fixture.data.path().join("recall-index").exists());
    }

    #[test]
    fn indexed_recall_covers_all_sources_for_the_owner_only_and_matches_the_scan() {
        let fixture = fixture();
        let v4 = fixture.v4("owner", "needle from v4");
        fixture.terminal("owner", TERMINAL, &["needle from ", "terminal"]);
        fixture.structured("owner", STRUCTURED, "needle from structured");
        let imported = fixture.imported("owner", "needle from imported");
        fixture.v4("other", "needle from another account");
        fixture.terminal("other", "pty-other", &["needle other terminal"]);
        fixture.structured(
            "other",
            "ss-00000000-0000-4000-8000-000000000002",
            "needle other",
        );

        let scanned = fixture.ids("owner", "needle");
        assert_eq!(scanned.len(), 4);
        fixture.enable();
        let indexed = fixture.recall(
            "owner",
            json!({"query":"needle","scope":"account","limit":25}),
        );
        assert_eq!(indexed["index"]["used"], true);
        assert_eq!(fixture.ids("owner", "needle"), scanned);
        assert!(scanned.contains(&v4) && scanned.contains(&TERMINAL.to_string()));
        assert!(scanned.contains(&STRUCTURED.to_string()));
        assert!(imported.exists());
        let workspace_scoped = fixture.recall("owner", json!({"query":"needle","limit":25}));
        assert_eq!(workspace_scoped["sessions"].as_array().unwrap().len(), 4);
        let mut other = fixture.recall("other", json!({"query":"needle","scope":"account"}));
        assert_eq!(other["sessions"].as_array().unwrap().len(), 3);
        assert!(!other.to_string().contains("from v4"));
        other["sessions"] = json!([]);
        let filtered = fixture.recall(
            "owner",
            json!({"query":"needle","scope":"account","source":"structured","provider":"DEEPSEEK"}),
        );
        assert_eq!(filtered["sessions"][0]["sessionId"], STRUCTURED);
        assert_eq!(filtered["sessions"].as_array().unwrap().len(), 1);
        let dated = fixture.recall("owner", json!({"query":"needle","scope":"account","updatedAfter":"2026-10-25","updatedBefore":"2026-10-26"}));
        assert_eq!(dated["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(dated["sessions"][0]["source"], "imported");
        assert_eq!(dated["undated"], 0);
    }

    #[test]
    fn reassembled_terminal_fragments_are_redacted_before_they_are_indexed() {
        let fixture = fixture();
        fixture.enable();
        fixture.terminal(
            "owner",
            TERMINAL,
            &[
                "OPENAI_API_",
                "KEY=sk-fragmentsecret123456",
                "\nvisible tail",
            ],
        );
        fixture.structured(
            "owner",
            STRUCTURED,
            "-----BEGIN PRIVATE KEY-----\nkeybody-part-one",
        );
        let got = fixture.ids("owner", "visible");
        assert_eq!(got, [TERMINAL]);
        let stored = fixture.stored_text("owner");
        for secret in ["fragmentsecret", "keybody-part-one"] {
            assert!(!stored.contains(secret), "{secret}");
            assert!(fixture.ids("owner", secret).is_empty());
        }
    }

    #[test]
    fn source_mutations_and_deletions_are_visible_without_a_manual_reindex() {
        let fixture = fixture();
        fixture.enable();
        let v4 = fixture.v4("owner", "originalterm");
        let imported = fixture.imported("owner", "importedterm");
        assert_eq!(fixture.ids("owner", "originalterm"), [v4]);
        assert_eq!(fixture.ids("owner", "importedterm").len(), 1);
        fixture.structured("owner", STRUCTURED, "freshterm");
        assert_eq!(fixture.ids("owner", "freshterm"), [STRUCTURED]);
        std::fs::remove_file(&imported).unwrap();
        assert!(fixture.ids("owner", "importedterm").is_empty());
        assert!(!fixture.stored_text("owner").contains("importedterm"));
        let history = fixture
            .data
            .path()
            .join("v4-agent-history")
            .join(hashed("owner"));
        let mut pending = vec![history];
        let mut removed = 0;
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if std::fs::read_to_string(&path)
                    .is_ok_and(|text| text.contains("originalterm"))
                {
                    std::fs::remove_file(&path).unwrap();
                    removed += 1;
                }
            }
        }
        assert!(removed > 0);
        assert!(fixture.ids("owner", "originalterm").is_empty());
    }

    #[test]
    fn index_cursor_pages_and_rejects_a_changed_generation() {
        let fixture = fixture();
        fixture.enable();
        for n in 0..3 {
            fixture.terminal("owner", &format!("pty-{n}"), &["pagedword content"]);
        }
        let first = fixture.recall("owner", json!({"query":"pagedword","limit":2}));
        assert_eq!(first["sessions"].as_array().unwrap().len(), 2);
        let cursor = first["index"]["nextCursor"].as_str().unwrap().to_owned();
        let second = fixture.recall(
            "owner",
            json!({"query":"pagedword","limit":2,"indexCursor":cursor}),
        );
        assert_eq!(second["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(second["index"]["nextCursor"], Value::Null);
        fixture.terminal("owner", "pty-0", &["pagedword rewritten"]);
        let stale = super::super::dispatch(
            fixture.data.path(),
            "owner",
            &fixture.workspace,
            "recall_sessions",
            &json!({"query":"pagedword","limit":2,"indexCursor":cursor}),
        );
        assert!(stale.unwrap_err().contains("changed or expired"));
        let mixed = super::super::dispatch(
            fixture.data.path(),
            "owner",
            &fixture.workspace,
            "recall_sessions",
            &json!({"query":"pagedword","limit":2,"indexCursor":cursor,"offset":1}),
        );
        assert!(mixed.is_err());
    }

    #[test]
    fn incomplete_freshness_reports_the_scan_fallback_instead_of_a_negative() {
        let fixture = fixture();
        fixture.enable();
        let hash = hashed("owner");
        std::fs::create_dir_all(fixture.data.path().join("recall-index").join(&hash)).unwrap();
        std::fs::write(
            fixture
                .data
                .path()
                .join("recall-index")
                .join(&hash)
                .join("index.sqlite"),
            b"not a database, definitely corrupt content for sqlite..........",
        )
        .unwrap();
        fixture.v4("owner", "fallbackterm");
        let result = fixture.recall("owner", json!({"query":"fallbackterm"}));
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(result["index"]["used"], true);
        assert!(
            std::fs::read_dir(fixture.data.path().join("recall-index").join(&hash))
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        );
    }
}
