use super::file_tool;
use serde_json::{json, Value};

fn search(root: &std::path::Path, input: Value) -> Value {
    serde_json::from_str(&file_tool(root, "search_text", &input).unwrap()).unwrap()
}

#[test]
fn regex_and_filename_search_preserve_scope_and_exclude_protected_files() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::write(root.path().join("src/main.rs"), "First\nTODO: check\n").unwrap();
    std::fs::write(root.path().join("src/other.txt"), "todo: later\n").unwrap();
    std::fs::write(root.path().join(".env.local"), "TODO: secret\n").unwrap();
    std::fs::write(outside.path().join("external.rs"), "TODO: external\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("external")).unwrap();
    let found = search(
        root.path(),
        json!({"path":".","text":"^todo:","regex":true,"case_sensitive":false}),
    );
    let mut rows = found["matches"].as_array().unwrap().clone();
    rows.sort_by_key(|row| row["path"].as_str().unwrap().to_owned());
    assert_eq!(
        rows,
        vec![
            json!({"path":"src/main.rs","line":2,"text":"TODO: check"}),
            json!({"path":"src/other.txt","line":1,"text":"todo: later"})
        ]
    );
    let files = search(
        root.path(),
        json!({"path":".","text":"\\.rs$","regex":true,"mode":"files"}),
    );
    assert_eq!(files["matches"], json!([{"path":"src/main.rs"}]));
    assert_eq!(files["truncated"], false);
}

#[test]
fn search_rejects_invalid_options_and_does_not_expose_symlink_targets() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "private needle").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("alias")).unwrap();
    for args in [
        json!({"path":".","text":"[","regex":true}),
        json!({"path":".","text":"a".repeat(257),"regex":true}),
        json!({"path":".","text":"needle","mode":"unknown"}),
        json!({"path":".","text":"needle","regex":"yes"}),
        json!({"path":"alias","text":"needle"}),
        json!({"path":"../outside","text":"needle"}),
    ] {
        assert!(
            file_tool(root.path(), "search_text", &args).is_err(),
            "{args}"
        );
    }
    assert_eq!(
        search(root.path(), json!({"path":".","text":"private needle"}))["matches"],
        json!([])
    );
    let protected_root = root.path().join(".ssh");
    std::fs::create_dir(&protected_root).unwrap();
    std::fs::write(protected_root.join("id_key"), "private needle").unwrap();
    assert!(file_tool(
        &protected_root,
        "search_text",
        &json!({"path":".","text":"private needle"})
    )
    .is_err());
}

#[test]
fn search_limits_results_and_keeps_long_line_matches_visible() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("long.txt"),
        format!("{} needle at the end\n", "x".repeat(2_000)),
    )
    .unwrap();
    let found = search(root.path(), json!({"path":"long.txt","text":"needle"}));
    assert!(found["matches"][0]["text"]
        .as_str()
        .unwrap()
        .contains("needle"));
    assert!(
        found["matches"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count()
            <= 500
    );

    std::fs::write(root.path().join("many.txt"), "needle\n".repeat(101)).unwrap();
    let limited = search(root.path(), json!({"path":"many.txt","text":"needle"}));
    assert_eq!(limited["matches"].as_array().unwrap().len(), 100);
    assert_eq!(limited["truncated"], true);
}

#[test]
fn regex_search_reports_lines_exceeding_its_scan_limit() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("long.txt"),
        format!("{} needle", "x".repeat(20_000)),
    )
    .unwrap();
    let result = search(
        root.path(),
        json!({"path":"long.txt","text":"needle","regex":true}),
    );
    assert_eq!(result["matches"], json!([]));
    assert_eq!(result["truncated"], true);
}

#[test]
fn search_skips_fifos_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let fifo = std::ffi::CString::new(root.path().join("pipe").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    std::fs::write(root.path().join("notes.txt"), "needle").unwrap();
    let found = search(root.path(), json!({"path":".","text":"needle"}));
    assert_eq!(
        found["matches"],
        json!([{"path":"notes.txt","line":1,"text":"needle"}])
    );
}
