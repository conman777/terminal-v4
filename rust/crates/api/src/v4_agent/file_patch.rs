use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[path = "file_patch_syntax.rs"]
mod syntax;

const MAX_HUNKS: usize = 50;
const MAX_HUNK_BYTES: usize = 256_000;

pub(super) fn properties() -> Value {
    json!({
        "path":{"type":"string"},
        "hunks":{"type":"array","minItems":1,"maxItems":MAX_HUNKS,"items":{"type":"object","properties":{
            "old":{"type":"string"},"new":{"type":"string"},
            "expected_count":{"type":"integer","minimum":1,"maximum":1000}
        },"required":["old","new"],"additionalProperties":false}},
        "expected_revision":{"type":"string"},
        "dry_run":{"type":"boolean"},
        "validate_syntax":{"type":"string","enum":["json","toml","yaml"],"description":"Validate the complete result before writing; json, toml or yaml. TOML and YAML use conservative structural checks, not full parsers. Python is not supported."}
    })
}

pub(super) const DESCRIPTION: &str = "Atomically apply 1-50 ordered replacement hunks to one workspace file; all hunks apply or the file is unchanged. Each hunk replaces exactly expected_count (default 1) literal matches of old. If a hunk has no exact match, a unique match that differs only in per-line leading/trailing whitespace is used and new is re-indented; ambiguous matches fail. Optional expected_revision (a revision returned by a previous apply_patch) rejects stale files. dry_run validates and returns the current and resulting revision without writing. Optional validate_syntax (json, toml or yaml) checks the complete result before writing and refuses invalid syntax without executing anything; TOML and YAML use conservative structural checks that reject only definite errors, not full parsers. Other languages, including Python, are rejected.";

fn revision(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

fn leading(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

fn fuzzy_replace(content: &str, old: &str, new: &str) -> Result<String, String> {
    let wanted: Vec<&str> = old.lines().map(str::trim).collect();
    if wanted.is_empty() || wanted.iter().all(|line| line.is_empty()) {
        return Err("no match".into());
    }
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let mut found = None;
    for start in 0..lines.len().saturating_sub(wanted.len() - 1) {
        if lines[start..start + wanted.len()]
            .iter()
            .zip(&wanted)
            .all(|(line, want)| line.trim() == *want)
            && found.replace(start).is_some()
        {
            return Err("ambiguous whitespace-tolerant match".into());
        }
    }
    let start = found.ok_or("no match")?;
    let window = &lines[start..start + wanted.len()];
    let file_indent = leading(window[0]);
    let old_indent = old.lines().next().map(leading).unwrap_or("");
    let crlf = window[0].ends_with("\r\n");
    let ends_newline = window[window.len() - 1].ends_with('\n');
    let mut replacement = String::new();
    let new_lines: Vec<&str> = new.lines().collect();
    for (i, line) in new_lines.iter().enumerate() {
        let rest = line.strip_prefix(old_indent).unwrap_or(line);
        if !line.trim().is_empty() {
            replacement.push_str(if line.starts_with(old_indent) {
                file_indent
            } else {
                ""
            });
            replacement.push_str(rest);
        }
        if i + 1 < new_lines.len() || ends_newline {
            replacement.push_str(if crlf { "\r\n" } else { "\n" });
        }
    }
    let mut out = String::with_capacity(content.len() + replacement.len());
    out.extend(lines[..start].iter().copied());
    out.push_str(&replacement);
    out.extend(lines[start + wanted.len()..].iter().copied());
    Ok(out)
}

pub(super) fn apply(path: &Path, input: &Value) -> Result<String, String> {
    let hunks = input
        .get("hunks")
        .and_then(Value::as_array)
        .filter(|h| (1..=MAX_HUNKS).contains(&h.len()))
        .ok_or("hunks must contain 1 to 50 entries")?;
    let dry_run = match input.get("dry_run") {
        None => false,
        Some(v) => v.as_bool().ok_or("dry_run must be a boolean")?,
    };
    let expected_revision = match input.get("expected_revision") {
        None => None,
        Some(v) => Some(v.as_str().ok_or("expected_revision must be a string")?),
    };
    let validate_language = match input.get("validate_syntax") {
        None => None,
        Some(Value::String(language)) if syntax::is_supported(language) => Some(language.as_str()),
        Some(Value::String(language)) => {
            return Err(format!(
                "Unsupported validate_syntax language: {language}; supported: {}",
                syntax::SUPPORTED
            ));
        }
        Some(_) => {
            return Err(format!(
                "validate_syntax must be a string (supported: {})",
                syntax::SUPPORTED
            ))
        }
    };
    let original = super::read(path)?;
    let before = revision(&original);
    if expected_revision.is_some_and(|expected| expected != before) {
        return Err("File changed since expected_revision; read the file again".into());
    }
    let mut content = original.clone();
    for (index, hunk) in hunks.iter().enumerate() {
        let fail =
            |reason: &str| format!("Hunk {} failed: {reason}; no changes written", index + 1);
        let object = hunk.as_object().ok_or_else(|| fail("not an object"))?;
        if object
            .keys()
            .any(|k| !matches!(k.as_str(), "old" | "new" | "expected_count"))
        {
            return Err(fail("unexpected fields"));
        }
        let old = hunk["old"]
            .as_str()
            .ok_or_else(|| fail("old must be a string"))?;
        let new = hunk["new"]
            .as_str()
            .ok_or_else(|| fail("new must be a string"))?;
        let expected = match hunk.get("expected_count") {
            None => 1,
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=1000).contains(n))
                .ok_or_else(|| fail("expected_count must be 1 to 1000"))?
                as usize,
        };
        if old.is_empty() || old.len() > MAX_HUNK_BYTES || new.len() > MAX_HUNK_BYTES {
            return Err(fail("old must be non-empty and hunks at most 256 KB"));
        }
        let exact = content.matches(old).take(expected + 1).count();
        content = if exact == expected {
            content.replace(old, new)
        } else if exact == 0 && expected == 1 {
            fuzzy_replace(&content, old, new).map_err(|e| fail(&e))?
        } else {
            return Err(fail("matching occurrence count differs"));
        };
        if content.len() as u64 > super::FILE_BYTES {
            return Err(fail("result exceeds 512 KB"));
        }
    }
    if let Some(language) = validate_language {
        syntax::validate(language, &content)?;
    }
    let after = revision(&content);
    if dry_run {
        return Ok(json!({"dryRun":true,"changed":content != original,"revision":before,"resultRevision":after,"hunks":hunks.len()}).to_string());
    }
    if content == original {
        return Ok(json!({"changed":false,"revision":before,"hunks":hunks.len()}).to_string());
    }
    if revision(&super::read(path)?) != before {
        return Err("File changed while patching; read the file again".into());
    }
    super::write(path, &content)?;
    Ok(json!({"changed":true,"revision":after,"previousRevision":before,"hunks":hunks.len(),"bytes":content.len()}).to_string())
}

#[cfg(test)]
mod tests {
    use super::super::file_tool;
    use super::*;
    use crate::v4_agent::{tool_definitions, ToolPolicy};

    fn setup(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("f.txt");
        std::fs::write(&path, content).unwrap();
        (root, path)
    }
    fn patch(root: &Path, extra: Value) -> Result<String, String> {
        let mut input = json!({"path":"f.txt"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        file_tool(root, "apply_patch", &input)
    }

    #[test]
    fn applies_multiple_hunks_in_order_and_returns_revision() {
        let (root, path) = setup("a\nb\nc\n");
        let out = patch(
            root.path(),
            json!({"hunks":[{"old":"a","new":"A"},{"old":"A\nb","new":"A\nB"}]}),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A\nB\nc\n");
        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out["revision"], revision("A\nB\nc\n"));
    }

    #[test]
    fn failing_later_hunk_leaves_file_unchanged() {
        let (root, path) = setup("a\nb\nc\n");
        for hunks in [
            json!([{"old":"a","new":"A"},{"old":"zzz","new":"x"}]),
            json!([{"old":"a","new":"A"},{"old":"\n","new":"x"}]),
            json!([{"old":"a","new":"A"},{"old":"","new":"x"}]),
            json!([{"old":"a","new":"A"},{"old":"b","new":"x","extra":1}]),
        ] {
            assert!(patch(root.path(), json!({"hunks":hunks})).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nb\nc\n");
        }
    }

    #[test]
    fn expected_count_is_enforced_and_oversize_results_rejected() {
        let (root, path) = setup("x x\n");
        assert!(patch(root.path(), json!({"hunks":[{"old":"x","new":"y"}]})).is_err());
        assert!(patch(
            root.path(),
            json!({"hunks":[{"old":"x","new":"y","expected_count":3}]})
        )
        .is_err());
        assert!(patch(root.path(), json!({"hunks":[{"old":"x","new":"y".repeat(250_000),"expected_count":2},{"old":"x","new":"z"}]})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x x\n");
        patch(
            root.path(),
            json!({"hunks":[{"old":"x","new":"y","expected_count":2}]}),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "y y\n");
    }

    #[test]
    fn whitespace_tolerant_match_reindents_when_unique() {
        let (root, path) = setup("fn a() {\n    if x {\n        go();\n    }\n}\n");
        patch(root.path(), json!({"hunks":[{"old":"if x {\n    go();\n}","new":"if x {\n    stop();\n    go();\n}"}]})).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fn a() {\n    if x {\n        stop();\n        go();\n    }\n}\n"
        );
    }

    #[test]
    fn whitespace_tolerant_match_preserves_relative_indent_with_shared_prefix() {
        let (root, path) = setup("\t\tfoo();\n\t\tbar();\nend\n");
        patch(root.path(), json!({"hunks":[{"old":"    foo();\n    bar();","new":"    foo();\n      baz();\n    bar();"}]})).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "\t\tfoo();\n\t\t  baz();\n\t\tbar();\nend\n"
        );
    }

    #[test]
    fn ambiguous_whitespace_match_is_rejected() {
        let original = "  go();\n    go();\n";
        let (root, path) = setup(original);
        let err = patch(
            root.path(),
            json!({"hunks":[{"old":"\tgo();\n","new":"stop();\n"}]}),
        )
        .unwrap_err();
        assert!(err.contains("ambiguous"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn stale_revision_is_rejected_and_matching_revision_applies() {
        let (root, path) = setup("a\n");
        let rev = revision("a\n");
        std::fs::write(&path, "a\nb\n").unwrap();
        assert!(patch(
            root.path(),
            json!({"expected_revision":rev,"hunks":[{"old":"a","new":"A"}]})
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nb\n");
        patch(
            root.path(),
            json!({"expected_revision":revision("a\nb\n"),"hunks":[{"old":"a","new":"A"}]}),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A\nb\n");
    }

    #[test]
    fn dry_run_reports_without_writing() {
        let (root, path) = setup("a\n");
        let out: Value = serde_json::from_str(
            &patch(
                root.path(),
                json!({"dry_run":true,"hunks":[{"old":"a","new":"A"}]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(out["resultRevision"], revision("A\n"));
        assert_eq!(out["revision"], revision("a\n"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\n");
    }

    #[test]
    fn syntax_validation_checks_complete_result_before_writing() {
        let original = "{\"value\": 1}";
        let (root, path) = setup(original);
        let out = patch(
            root.path(),
            json!({"validate_syntax":"json", "hunks":[
                {"old":"1", "new":"["}, {"old":"[}", "new":"[2, 3]}"}
            ]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"value\": [2, 3]}"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap()["changed"],
            true
        );
        let current = std::fs::read_to_string(&path).unwrap();
        let err = patch(
            root.path(),
            json!({"validate_syntax":"json", "hunks":[
                {"old":"[2, 3]", "new":"[2,"}
            ]}),
        )
        .unwrap_err();
        assert!(err.contains("JSON"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), current);
    }

    #[test]
    fn syntax_validation_dry_run_checks_result_without_mutation() {
        let original = "{\"value\": 1}";
        let (root, path) = setup(original);
        let out: Value = serde_json::from_str(
            &patch(
                root.path(),
                json!({
                    "validate_syntax":"json", "dry_run":true,
                    "hunks":[{"old":"1", "new":"2"}]
                }),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(out["resultRevision"], revision("{\"value\": 2}"));
        let err = patch(
            root.path(),
            json!({"validate_syntax":"json", "dry_run":true,
            "hunks":[{"old":"1", "new":"invalid"}]}),
        )
        .unwrap_err();
        assert!(err.contains("JSON"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn syntax_validation_rejects_stale_revision_and_unsupported_requests() {
        let original = "{\"value\": 1}";
        let (root, path) = setup(original);
        let err = patch(
            root.path(),
            json!({"validate_syntax":"json", "expected_revision":revision("stale"),
            "hunks":[{"old":"1", "new":"2"}]}),
        )
        .unwrap_err();
        assert!(err.contains("expected_revision"), "{err}");
        for language in [
            json!("python"),
            json!("JSON"),
            json!("yml"),
            json!(null),
            json!(true),
        ] {
            let err = patch(
                root.path(),
                json!({"validate_syntax":language,
                "hunks":[{"old":"1", "new":"2"}]}),
            )
            .unwrap_err();
            assert!(err.contains("validate_syntax"), "{err}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn toml_and_yaml_validation_refuse_to_write_invalid_results() {
        for (language, original, old, bad, good) in [
            ("toml", "a = 1\n", "1", "[", "2"),
            ("yaml", "a: 1\n", "a: 1", "a: [1", "a: 2"),
        ] {
            let (root, path) = setup(original);
            let err = patch(
                root.path(),
                json!({"validate_syntax":language, "hunks":[{"old":old, "new":bad}]}),
            )
            .unwrap_err();
            assert!(err.contains(&language.to_uppercase()), "{err}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
            let dry = patch(
                root.path(),
                json!({"validate_syntax":language, "dry_run":true, "hunks":[{"old":old, "new":bad}]}),
            );
            assert!(dry.is_err());
            patch(
                root.path(),
                json!({"validate_syntax":language, "hunks":[{"old":old, "new":good}]}),
            )
            .unwrap();
            assert_ne!(std::fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn python_validation_is_rejected_with_the_supported_list() {
        let (root, path) = setup("x = 1\n");
        let err = patch(
            root.path(),
            json!({"validate_syntax":"python", "hunks":[{"old":"1", "new":"2"}]}),
        )
        .unwrap_err();
        assert!(err.contains("json, toml, yaml"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x = 1\n");
    }

    #[test]
    fn syntax_validation_schema_is_exposed() {
        let props = properties();
        assert_eq!(props["validate_syntax"]["type"], "string");
    }

    #[test]
    fn hunk_count_is_bounded() {
        let (root, path) = setup("a\n");
        let hunks: Vec<_> = (0..51).map(|_| json!({"old":"a","new":"a"})).collect();
        assert!(patch(root.path(), json!({"hunks":hunks})).is_err());
        assert!(patch(root.path(), json!({"hunks":[]})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\n");
    }

    #[test]
    fn crlf_files_keep_crlf_in_tolerant_matches() {
        let (root, path) = setup("  a\r\n  b\r\n");
        patch(
            root.path(),
            json!({"hunks":[{"old":"a\nb","new":"a\nc\nb"}]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "  a\r\n  c\r\n  b\r\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn protected_traversal_and_symlink_targets_are_rejected_without_changes() {
        let (root, _) = setup("a\n");
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("t"), "a\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("t"), root.path().join("link")).unwrap();
        std::fs::write(root.path().join(".env"), "a\n").unwrap();
        for p in ["link", "../x", ".env", "/etc/hosts"] {
            let input = json!({"path":p,"hunks":[{"old":"a","new":"b"}]});
            assert!(
                file_tool(root.path(), "apply_patch", &input).is_err(),
                "{p}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(outside.path().join("t")).unwrap(),
            "a\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(".env")).unwrap(),
            "a\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn permissions_survive_a_patch() {
        use std::os::unix::fs::PermissionsExt;
        let (root, path) = setup("a\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();
        patch(root.path(), json!({"hunks":[{"old":"a","new":"b"}]})).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o751
        );
    }

    #[test]
    fn read_only_child_policy_filters_apply_patch() {
        assert!(!ToolPolicy::ReadOnlyChild.allows("apply_patch"));
        let defs = tool_definitions(
            ToolPolicy::ReadOnlyChild,
            Path::new("/nonexistent"),
            "owner",
        )
        .unwrap();
        assert!(defs.iter().all(|d| d["name"] != "apply_patch"));
        let defs = tool_definitions(ToolPolicy::Standard, Path::new("/nonexistent"), "owner");
        if let Ok(defs) = defs {
            assert!(defs.iter().any(|d| d["name"] == "apply_patch"));
        }
    }
}
