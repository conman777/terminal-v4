use super::*;

#[test]
fn read_only_policy_is_explicit_allowlist_and_filters_definitions() {
    let allowed = [
        "list_files",
        "read_file",
        "search_text",
        "recall_sessions",
        "read_session",
        "read_context_archive",
        "discover_skills",
        "list_skill_files",
        "read_skill_file",
    ];
    let definitions = tool_definitions(
        ToolPolicy::ReadOnlyChild,
        Path::new("/nonexistent"),
        "owner",
    )
    .unwrap();
    let names: Vec<_> = definitions
        .iter()
        .map(|definition| definition["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, allowed);
    for name in allowed {
        assert!(ToolPolicy::ReadOnlyChild.allows(name));
    }
    for name in [
        "write_file",
        "replace_text",
        "run_command",
        "create_schedule",
        "todo_list",
        "propose_knowledge",
        "inspect_knowledge",
        "mcp_call_tool",
        "mcp_list_servers",
        "browser_open",
        "future_tool",
        "",
    ] {
        assert!(!ToolPolicy::ReadOnlyChild.allows(name), "{name}");
    }
}

#[test]
fn read_only_mode_requires_unattended_new_v4_child() {
    let base = ["--provider", "deepseek", "--owner-hex", "6f776e6572"];
    let child_id = "6873f484-883c-44fd-80be-d779060bead6";
    let args = |extra: &[&str]| {
        base.iter()
            .chain(extra.iter())
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };
    assert!(options(&args(&[
        "--tool-policy",
        "read-only-child",
        "--query",
        "fixture",
        "--child-session",
        child_id,
    ]))
    .is_ok());
    for extra in [
        vec!["--tool-policy", "read-only-child"],
        vec!["--tool-policy", "read-only-child", "--query", "fixture"],
        vec!["--query", "fixture", "--child-session", child_id],
        vec![
            "--tool-policy",
            "read-only-child",
            "--query",
            "fixture",
            "--child-session",
            "00000000-0000-0000-0000-000000000000",
        ],
        vec![
            "--tool-policy",
            "read-only-child",
            "--query",
            "fixture",
            "--child-session",
            "not-a-uuid",
        ],
        vec!["--tool-policy", "unknown", "--query", "fixture"],
        vec![
            "--tool-policy",
            "read-only-child",
            "--query",
            "fixture",
            "--resume",
            "00000000-0000-0000-0000-000000000000",
        ],
    ] {
        assert!(options(&args(&extra)).is_err());
    }
    assert_eq!(
        options(&args(&[])).unwrap().tool_policy,
        ToolPolicy::Standard
    );
}

#[test]
fn child_launcher_carries_policy_and_rejects_other_agent_runtimes() {
    let root = tempfile::tempdir().unwrap();
    let child_id = uuid::Uuid::new_v4();
    let command = read_only_child_command(
        root.path(),
        "owner",
        "deepseek",
        "fixture",
        None,
        root.path(),
        child_id,
    )
    .unwrap();
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--tool-policy", "read-only-child"]));
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--child-session" && pair[1] == child_id.to_string()));
    assert!(read_only_child_command(
        root.path(),
        "owner",
        "codex",
        "fixture",
        None,
        root.path(),
        child_id
    )
    .is_err());
    assert!(read_only_child_command(
        root.path(),
        "owner",
        "deepseek",
        "fixture",
        None,
        root.path(),
        uuid::Uuid::nil()
    )
    .is_err());
    let regular = owner_task_command(
        root.path(),
        "owner",
        "deepseek",
        "fixture",
        None,
        root.path(),
    )
    .unwrap();
    assert!(!regular
        .as_std()
        .get_args()
        .any(|arg| arg == "--tool-policy"));
}
