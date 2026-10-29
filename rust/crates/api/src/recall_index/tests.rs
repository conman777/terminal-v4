use super::search::SearchPage;
use super::sync::CRASH_AT;
use super::*;
use std::cell::RefCell;

struct Files {
    root: PathBuf,
    after_manifest: RefCell<Option<Box<dyn Fn()>>>,
    hide: RefCell<Vec<String>>,
}

impl Files {
    fn new(root: &Path) -> Self {
        std::fs::create_dir_all(root).unwrap();
        Self {
            root: root.to_path_buf(),
            after_manifest: RefCell::new(None),
            hide: RefCell::new(Vec::new()),
        }
    }

    fn write(&self, name: &str, workspace: &str, title: &str, messages: &[(&str, &str)]) {
        let path = self.root.join(format!("{name}.json"));
        let body = serde_json::json!({
            "workspace": workspace, "title": title, "updated": "2026-10-20T10:00:00Z",
            "messages": messages,
        });
        std::fs::write(&path, body.to_string()).unwrap();
        let bump = std::time::SystemTime::now() + std::time::Duration::from_millis(5);
        std::fs::File::open(&path)
            .unwrap()
            .set_modified(bump)
            .unwrap();
    }

    fn remove(&self, name: &str) {
        std::fs::remove_file(self.root.join(format!("{name}.json"))).unwrap();
    }

    fn key(name: &str) -> String {
        format!("fake:{name}.json")
    }
}

impl Sources for Files {
    fn manifest(&self) -> Result<Manifest, String> {
        let mut manifest = Manifest::default();
        for entry in std::fs::read_dir(&self.root).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if self.hide.borrow().contains(&name) {
                continue;
            }
            let Some((size, mtime_ns)) = file_stat(&entry.path()) else {
                continue;
            };
            manifest.entries.push(ManifestEntry {
                key: format!("fake:{name}"),
                source: "terminal".into(),
                id: name.trim_end_matches(".json").into(),
                path: entry.path(),
                size,
                mtime_ns,
            });
        }
        manifest.entries.sort_by(|a, b| a.key.cmp(&b.key));
        if let Some(hook) = self.after_manifest.borrow().as_ref() {
            hook();
        }
        Ok(manifest)
    }

    fn read(&self, entry: &ManifestEntry) -> Result<IndexedDoc, String> {
        let text = std::fs::read_to_string(&entry.path).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let messages: Vec<(String, String)> = value["messages"]
            .as_array()
            .ok_or("bad")?
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().unwrap().to_owned(),
                    pair[1].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        Ok(IndexedDoc {
            workspace: value["workspace"].as_str().unwrap().into(),
            title: crate::session_search::safe_history_text(value["title"].as_str().unwrap()),
            provider: "fixture".into(),
            model: "m".into(),
            updated_at: value["updated"].as_str().unwrap().into(),
            fingerprint: format!("{}-{}", entry.size, entry.mtime_ns),
            messages: redact_messages(&messages, crate::session_search::safe_history_text),
            source_truncated: false,
        })
    }
}

fn request(query: &str) -> SearchRequest {
    SearchRequest {
        workspace: "/w".into(),
        account: false,
        query: query.into(),
        limit: 10,
        ..Default::default()
    }
}

fn page(index: &RecallIndex, files: &Files, req: &SearchRequest) -> SearchPage {
    match index.search(req, files).unwrap() {
        SearchOutcome::Page(page) => page,
        SearchOutcome::Fallback(reason) => panic!("unexpected fallback {reason}"),
    }
}

fn ids(page: &SearchPage) -> Vec<String> {
    page.hits.iter().map(|hit| hit.id.clone()).collect()
}

fn setup() -> (tempfile::TempDir, RecallIndex, Files) {
    let data = tempfile::tempdir().unwrap();
    let index = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
    let files = Files::new(&data.path().join("src"));
    (data, index, files)
}

fn build(index: &RecallIndex, files: &Files) {
    index.start_rebuild(files).unwrap();
    let progress = index.rebuild_step(files, 1000).unwrap();
    assert!(progress.activated, "{progress:?}");
}

fn raw_fts_text(data: &Path, owner: &str) -> String {
    let dir = data
        .join("recall-index")
        .join(hex::encode(sha2::Sha256::digest(owner.as_bytes())));
    let connection = rusqlite::Connection::open(dir.join("index.sqlite")).unwrap();
    let mut statement = connection.prepare("SELECT text FROM fts").unwrap();
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap();
    rows.flatten().collect::<Vec<_>>().join("\n")
}

fn scalar(data: &Path, owner: &str, sql: &str) -> i64 {
    let dir = data
        .join("recall-index")
        .join(hex::encode(sha2::Sha256::digest(owner.as_bytes())));
    let connection = rusqlite::Connection::open(dir.join("index.sqlite")).unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn first_search_builds_the_index_inline_and_finds_matches() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "alpha", &[("user", "deploy the blue service")]);
    files.write(
        "b",
        "/w",
        "beta",
        &[
            ("user", "unrelated"),
            ("assistant", "blue service deploy notes"),
        ],
    );
    let page = page(&index, &files, &request("deploy blue"));
    let mut found = ids(&page);
    found.sort();
    assert_eq!(found, ["a.json".trim_end_matches(".json"), "b"]);
    let b = page.hits.iter().find(|hit| hit.id == "b").unwrap();
    assert_eq!((b.anchor, b.messages), (2, 2));
}

#[test]
fn owners_and_workspaces_are_isolated() {
    let data = tempfile::tempdir().unwrap();
    let files = Files::new(&data.path().join("src"));
    files.write("mine", "/w", "t", &[("user", "shared phrase mine")]);
    files.write(
        "other-ws",
        "/elsewhere",
        "t",
        &[("user", "shared phrase elsewhere")],
    );
    let owner = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
    let stranger = RecallIndex::open(data.path(), "stranger", Limits::default()).unwrap();
    let empty = Files::new(&data.path().join("empty"));
    build(&owner, &files);
    assert_eq!(ids(&page(&owner, &files, &request("shared"))), ["mine"]);
    let mut account = request("shared");
    account.account = true;
    assert_eq!(ids(&page(&owner, &files, &account)).len(), 2);
    build(&stranger, &empty);
    assert_eq!(
        ids(&page(&stranger, &empty, &request("shared"))),
        Vec::<String>::new()
    );

    let owner_db = data
        .path()
        .join("recall-index")
        .join(hex::encode(sha2::Sha256::digest(b"owner")));
    let stranger_db = data
        .path()
        .join("recall-index")
        .join(hex::encode(sha2::Sha256::digest(b"stranger")));
    let _ = (owner_db.clone(), stranger_db.clone());
    drop(stranger);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(stranger_db.join(format!("index.sqlite{suffix}")));
    }
    let checkpoint = rusqlite::Connection::open(owner_db.join("index.sqlite")).unwrap();
    checkpoint
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .unwrap();
    drop(checkpoint);
    std::fs::copy(
        owner_db.join("index.sqlite"),
        stranger_db.join("index.sqlite"),
    )
    .unwrap();
    let copied = RecallIndex::open(data.path(), "stranger", Limits::default()).unwrap();
    assert!(
        matches!(
            copied.search(&request("shared"), &empty).unwrap(),
            SearchOutcome::Fallback(_)
        ) || ids(&page(&copied, &empty, &request("shared"))).is_empty(),
        "a copied foreign database must never serve another owner's documents"
    );
}

#[test]
fn only_redacted_text_is_stored_and_split_secrets_are_withheld() {
    let (data, index, files) = setup();
    files.write(
        "a",
        "/w",
        "api_key=title-secret-value",
        &[
            (
                "user",
                "OPENAI_API_KEY=sk-live-secret-1234567890 visible-after",
            ),
            (
                "assistant",
                "-----BEGIN PRIVATE KEY-----\nfirst-half-material",
            ),
            (
                "assistant",
                "second-half-material\n-----END PRIVATE KEY-----",
            ),
            ("user", "ordinary needle text"),
        ],
    );
    build(&index, &files);
    let stored = raw_fts_text(data.path(), "owner");
    for secret in [
        "sk-live-secret",
        "title-secret-value",
        "first-half-material",
        "second-half-material",
    ] {
        assert!(!stored.contains(secret), "{secret} was stored");
        assert!(ids(&page(&index, &files, &request(secret))).is_empty());
    }
    let found = page(&index, &files, &request("needle"));
    assert_eq!(
        (ids(&found), found.hits[0].anchor),
        (vec!["a".to_string()], 4)
    );
}

#[test]
fn updates_and_deletions_are_reflected_and_tombstones_are_cleaned() {
    let (data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "oldphrase here")]);
    files.write("b", "/w", "t", &[("user", "keepphrase here")]);
    build(&index, &files);
    files.write("a", "/w", "t", &[("user", "newphrase here")]);
    assert!(ids(&page(&index, &files, &request("oldphrase"))).is_empty());
    assert_eq!(ids(&page(&index, &files, &request("newphrase"))), ["a"]);
    files.remove("b");
    assert!(ids(&page(&index, &files, &request("keepphrase"))).is_empty());
    assert!(!raw_fts_text(data.path(), "owner").contains("keepphrase"));
    assert_eq!(
        scalar(data.path(), "owner", "SELECT COUNT(*) FROM tombstones"),
        0
    );
    assert_eq!(
        scalar(
            data.path(),
            "owner",
            "SELECT COUNT(*) FROM journal WHERE kind='delete' AND applied=1"
        ),
        1
    );
}

#[test]
fn crash_between_journal_and_apply_recovers_on_next_sync() {
    let (data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "doomed phrase")]);
    files.write("b", "/w", "t", &[("user", "stable phrase")]);
    build(&index, &files);
    files.remove("a");
    CRASH_AT.with(|at| *at.borrow_mut() = Some("after_delete_journal"));
    assert!(index.sync(&files).is_err());
    CRASH_AT.with(|at| *at.borrow_mut() = None);
    assert_eq!(
        scalar(data.path(), "owner", "SELECT COUNT(*) FROM tombstones"),
        1
    );
    assert!(raw_fts_text(data.path(), "owner").contains("doomed"));
    assert!(ids(&page(&index, &files, &request("doomed"))).is_empty());
    assert_eq!(
        scalar(data.path(), "owner", "SELECT COUNT(*) FROM tombstones"),
        0
    );
    assert!(!raw_fts_text(data.path(), "owner").contains("doomed"));
    assert_eq!(ids(&page(&index, &files, &request("stable"))), ["b"]);
}

#[test]
fn crash_before_tombstone_confirmation_keeps_the_tombstone_until_cleanup() {
    let (data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "doomed phrase")]);
    build(&index, &files);
    files.remove("a");
    CRASH_AT.with(|at| *at.borrow_mut() = Some("before_tombstone_confirm"));
    assert!(index.sync(&files).is_err());
    CRASH_AT.with(|at| *at.borrow_mut() = None);
    assert_eq!(
        scalar(data.path(), "owner", "SELECT COUNT(*) FROM tombstones"),
        1
    );
    assert!(!raw_fts_text(data.path(), "owner").contains("doomed"));
    assert!(ids(&page(&index, &files, &request("doomed"))).is_empty());
    assert_eq!(
        scalar(data.path(), "owner", "SELECT COUNT(*) FROM tombstones"),
        0
    );
}

#[test]
fn crash_during_apply_rolls_back_and_the_change_is_retried() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "first version")]);
    build(&index, &files);
    files.write("a", "/w", "t", &[("user", "second version")]);
    CRASH_AT.with(|at| *at.borrow_mut() = Some("apply_before_commit"));
    assert!(index.sync(&files).is_err());
    CRASH_AT.with(|at| *at.borrow_mut() = None);
    assert_eq!(ids(&page(&index, &files, &request("second"))), ["a"]);
    assert!(ids(&page(&index, &files, &request("first"))).is_empty());
}

#[test]
fn interrupted_rebuild_resumes_from_a_new_index_handle_and_stays_inactive_until_complete() {
    let data = tempfile::tempdir().unwrap();
    let files = Files::new(&data.path().join("src"));
    for n in 0..6 {
        files.write(
            &format!("d{n}"),
            "/w",
            "t",
            &[("user", &format!("rebuildtoken{n} common"))],
        );
    }
    {
        let index = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
        index.start_rebuild(&files).unwrap();
        let progress = index.rebuild_step(&files, 2).unwrap();
        assert_eq!(
            (progress.remaining, progress.activated, progress.indexed),
            (4, false, 2)
        );
        assert!(matches!(
            index.sync(&files).unwrap(),
            Freshness::Incomplete(_)
        ));
    }
    files.write(
        "d3",
        "/w",
        "t",
        &[("user", "rebuildtoken3 changed during rebuild")],
    );
    files.remove("d4");
    files.write("late", "/w", "t", &[("user", "rebuildtoken-late common")]);
    let index = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
    let mut progress = index.rebuild_step(&files, 2).unwrap();
    for _ in 0..10 {
        if progress.activated {
            break;
        }
        progress = index.rebuild_step(&files, 2).unwrap();
    }
    assert!(progress.activated, "{progress:?}");
    let mut found = ids(&page(&index, &files, &request("common")));
    found.sort();
    assert_eq!(found, ["d0", "d1", "d2", "d5", "late"]);
    assert_eq!(ids(&page(&index, &files, &request("changed"))), ["d3"]);
}

#[test]
fn deletions_recorded_during_a_rebuild_are_not_resurrected_from_the_snapshot() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "ghostphrase")]);
    files.write("b", "/w", "t", &[("user", "livephrase")]);
    index.start_rebuild(&files).unwrap();
    index
        .record_change(&Files::key("a"), ChangeKind::Delete)
        .unwrap();
    files.hide.borrow_mut().push("a.json".into());
    let progress = index.rebuild_step(&files, 100).unwrap();
    assert!(progress.activated);
    assert!(ids(&page(&index, &files, &request("ghostphrase"))).is_empty());
    assert_eq!(ids(&page(&index, &files, &request("livephrase"))), ["b"]);
}

#[test]
fn activation_failure_leaves_the_previous_generation_serving() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "servedphrase")]);
    build(&index, &files);
    let old = page(&index, &files, &request("servedphrase")).generation;
    index.start_rebuild(&files).unwrap();
    CRASH_AT.with(|at| *at.borrow_mut() = Some("before_activate"));
    assert!(index.rebuild_step(&files, 100).is_err());
    CRASH_AT.with(|at| *at.borrow_mut() = None);
    assert_eq!(
        page(&index, &files, &request("servedphrase")).generation,
        old
    );
    let progress = index.rebuild_step(&files, 100).unwrap();
    assert!(progress.activated);
    assert_ne!(
        page(&index, &files, &request("servedphrase")).generation,
        old
    );
}

#[test]
fn concurrent_writers_converge_without_corruption() {
    let (data, index, files) = setup();
    for n in 0..8 {
        files.write(
            &format!("d{n}"),
            "/w",
            "t",
            &[("user", &format!("seed{n} phrase"))],
        );
    }
    build(&index, &files);
    let root = files.root.clone();
    let data_path = data.path().to_path_buf();
    let handles: Vec<_> = (0..4)
        .map(|worker| {
            let root = root.clone();
            let data_path = data_path.clone();
            std::thread::spawn(move || {
                let files = Files::new(&root);
                let index = RecallIndex::open(&data_path, "owner", Limits::default()).unwrap();
                for round in 0..6 {
                    if worker == 0 {
                        files.write(
                            &format!("d{}", round % 8),
                            "/w",
                            "t",
                            &[("user", &format!("round{round} phrase"))],
                        );
                    }
                    if worker == 1 && round == 3 {
                        let _ = std::fs::remove_file(root.join("d7.json"));
                    }
                    let _ = index.record_change(&Files::key("d0"), ChangeKind::Update);
                    let _ = index.sync(&files);
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert!(matches!(
        index.sync(&files).unwrap(),
        Freshness::Complete { .. }
    ));
    let docs = scalar(
        data.path(),
        "owner",
        "SELECT COUNT(*) FROM docs WHERE gen=(SELECT id FROM gens WHERE state='active')",
    );
    assert_eq!(docs, 7);
    assert_eq!(
        scalar(
            data.path(),
            "owner",
            "SELECT COUNT(*) FROM pragma_integrity_check WHERE integrity_check='ok'"
        ),
        1
    );
    assert!(ids(&page(&index, &files, &request("seed7"))).is_empty());
}

#[test]
fn oversized_and_unreadable_records_are_skipped_and_reported() {
    let data = tempfile::tempdir().unwrap();
    let limits = Limits {
        max_doc_text_bytes: 64,
        ..Limits::default()
    };
    let index = RecallIndex::open(data.path(), "owner", limits).unwrap();
    let files = Files::new(&data.path().join("src"));
    files.write("ok", "/w", "t", &[("user", "smallneedle")]);
    files.write("big", "/w", "t", &[("user", &"bigneedle ".repeat(20))]);
    std::fs::write(files.root.join("broken.json"), "{not json").unwrap();
    build(&index, &files);
    let found = page(&index, &files, &request("needle"));
    assert!(ids(&found).is_empty());
    let found = page(&index, &files, &request("smallneedle"));
    assert_eq!((ids(&found), found.skipped), (vec!["ok".to_string()], 2));
}

#[test]
fn total_size_limit_fails_the_rebuild_and_reports_fallback() {
    let data = tempfile::tempdir().unwrap();
    let index = RecallIndex::open(
        data.path(),
        "owner",
        Limits {
            max_total_text_bytes: 40,
            ..Limits::default()
        },
    )
    .unwrap();
    let files = Files::new(&data.path().join("src"));
    for n in 0..3 {
        files.write(
            &format!("d{n}"),
            "/w",
            "t",
            &[("user", "twenty chars of text")],
        );
    }
    index.start_rebuild(&files).unwrap();
    let progress = index.rebuild_step(&files, 100).unwrap();
    assert_eq!(
        (progress.activated, progress.failed.as_deref()),
        (false, Some("total_size_limit"))
    );
    let SearchOutcome::Fallback(reason) = index.search(&request("twenty"), &files).unwrap() else {
        panic!("incomplete index must fall back")
    };
    assert!(
        reason.starts_with("rebuild") || reason.contains("size"),
        "{reason}"
    );
}

#[test]
fn oversized_source_sets_refuse_to_build() {
    let data = tempfile::tempdir().unwrap();
    let index = RecallIndex::open(
        data.path(),
        "owner",
        Limits {
            max_manifest_entries: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let files = Files::new(&data.path().join("src"));
    for n in 0..3 {
        files.write(&format!("d{n}"), "/w", "t", &[("user", "text")]);
    }
    assert!(index.start_rebuild(&files).is_err());
    assert!(matches!(
        index.search(&request("text"), &files).unwrap(),
        SearchOutcome::Fallback(_)
    ));
}

#[test]
fn pending_changes_beyond_the_sync_budget_report_incomplete_freshness() {
    let data = tempfile::tempdir().unwrap();
    let index = RecallIndex::open(
        data.path(),
        "owner",
        Limits {
            sync_max_docs: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let files = Files::new(&data.path().join("src"));
    files.write("seed", "/w", "t", &[("user", "seed")]);
    build(&index, &files);
    for n in 0..5 {
        files.write(&format!("n{n}"), "/w", "t", &[("user", "burst text")]);
    }
    let SearchOutcome::Fallback(reason) = index.search(&request("burst"), &files).unwrap() else {
        panic!("stale index must not answer")
    };
    assert_eq!(reason, "pending_changes:3");
    assert!(matches!(
        index.sync(&files).unwrap(),
        Freshness::Incomplete(_)
    ));
    assert!(matches!(
        index.sync(&files).unwrap(),
        Freshness::Complete { .. }
    ));
    assert_eq!(ids(&page(&index, &files, &request("burst"))).len(), 5);
}

#[test]
fn corrupt_database_is_quarantined_and_rebuilt() {
    let (data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "survivor phrase")]);
    build(&index, &files);
    drop(index);
    let dir = data
        .path()
        .join("recall-index")
        .join(hex::encode(sha2::Sha256::digest(b"owner")));
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("index.sqlite{suffix}")));
    }
    std::fs::write(
        dir.join("index.sqlite"),
        b"this is not a sqlite database at all, just garbage bytes.......",
    )
    .unwrap();
    let index = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
    assert!(matches!(
        index.search(&request("survivor"), &files).unwrap(),
        SearchOutcome::Fallback(_) | SearchOutcome::Page(_)
    ));
    let found = page(&index, &files, &request("survivor"));
    assert_eq!(ids(&found), ["a"]);
    assert!(std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
}

#[cfg(unix)]
#[test]
fn symlinked_index_storage_is_rejected() {
    let data = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), data.path().join("recall-index")).unwrap();
    assert!(RecallIndex::open(data.path(), "owner", Limits::default()).is_err());
}

#[test]
fn pagination_is_bound_and_rejects_changed_or_expired_generations() {
    let (_data, index, files) = setup();
    for n in 0..5 {
        files.write(
            &format!("d{n}"),
            "/w",
            "t",
            &[("user", "pagedterm content")],
        );
    }
    build(&index, &files);
    let mut first = request("pagedterm");
    first.limit = 2;
    let one = page(&index, &files, &first);
    let cursor = one.next_cursor.clone().unwrap();
    let mut next = first.clone();
    next.cursor = Some(cursor.clone());
    let two = page(&index, &files, &next);
    let three = {
        let mut third = first.clone();
        third.cursor = two.next_cursor.clone();
        page(&index, &files, &third)
    };
    let mut all: Vec<_> = [ids(&one), ids(&two), ids(&three)].concat();
    all.sort();
    all.dedup();
    assert_eq!((all.len(), three.next_cursor), (5, None));

    let mut other_query = next.clone();
    other_query.query = "content".into();
    assert!(index.search(&other_query, &files).is_err());
    let mut other_workspace = next.clone();
    other_workspace.workspace = "/other".into();
    assert!(index.search(&other_workspace, &files).is_err());
    let mut other_filter = next.clone();
    other_filter.source = Some("v4".into());
    assert!(index.search(&other_filter, &files).is_err());
    let mut tampered = next.clone();
    tampered.cursor = Some(format!("{cursor}x"));
    assert!(index.search(&tampered, &files).is_err());

    files.write("d0", "/w", "t", &[("user", "pagedterm content rewritten")]);
    let error = index.search(&next, &files).err().unwrap();
    assert!(error.contains("changed or expired"), "{error}");

    let fresh = page(&index, &files, &first);
    let mut resumed = first.clone();
    resumed.cursor = fresh.next_cursor.clone();
    build_new_generation(&index, &files);
    assert!(index
        .search(&resumed, &files)
        .err()
        .unwrap()
        .contains("changed or expired"));
}

fn build_new_generation(index: &RecallIndex, files: &Files) {
    index.start_rebuild(files).unwrap();
    assert!(index.rebuild_step(files, 1000).unwrap().activated);
}

#[test]
fn hits_whose_source_changed_after_the_freshness_check_are_not_returned() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "racing phrase")]);
    build(&index, &files);
    let target = files.root.join("a.json");
    *files.after_manifest.borrow_mut() = Some(Box::new(move || {
        std::fs::write(&target, "{}").unwrap();
    }));
    let SearchOutcome::Fallback(reason) = index.search(&request("racing"), &files).unwrap() else {
        panic!("changed source must not be served from the index")
    };
    assert_eq!(reason, "source_changed_during_search");
    *files.after_manifest.borrow_mut() = None;
}

#[test]
fn queries_without_indexable_terms_fall_back() {
    let (_data, index, files) = setup();
    files.write("a", "/w", "t", &[("user", "x")]);
    build(&index, &files);
    for query in ["!!!", "ok ???"] {
        assert!(matches!(
            index.search(&request(query), &files).unwrap(),
            SearchOutcome::Fallback(reason) if reason == "query_not_indexable"
        ));
    }
}

#[test]
fn killed_rebuild_process_resumes_and_activates() {
    if let Ok(root) = std::env::var("RECALL_INDEX_CHILD_DATA") {
        let data = PathBuf::from(root);
        let files = Files::new(&data.join("src"));
        let index = RecallIndex::open(&data, "owner", Limits::default()).unwrap();
        index.start_rebuild(&files).unwrap();
        let _ = index.rebuild_step(&files, 1000);
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let files = Files::new(&data.path().join("src"));
    for n in 0..6 {
        files.write(
            &format!("d{n}"),
            "/w",
            "t",
            &[("user", &format!("killtoken{n} shared"))],
        );
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "recall_index::tests::killed_rebuild_process_resumes_and_activates",
            "--test-threads=1",
        ])
        .env("RECALL_INDEX_CHILD_DATA", data.path())
        .env("RECALL_INDEX_ABORT_AT", "after_doc")
        .env("RECALL_INDEX_ABORT_AFTER", "3")
        .status()
        .unwrap();
    assert!(!status.success(), "child must have been killed mid-rebuild");
    let index = RecallIndex::open(data.path(), "owner", Limits::default()).unwrap();
    assert_eq!(scalar(data.path(), "owner", "SELECT COUNT(*) FROM docs"), 3);
    assert_eq!(
        scalar(
            data.path(),
            "owner",
            "SELECT COUNT(*) FROM gens WHERE state='active'"
        ),
        0
    );
    assert!(matches!(
        index.search(&request("shared"), &files).unwrap(),
        SearchOutcome::Fallback(_) | SearchOutcome::Page(_)
    ));
    let progress = index.rebuild_step(&files, 100);
    let _ = progress;
    let found = page(&index, &files, &request("shared"));
    assert_eq!(found.hits.len(), 6);
}
