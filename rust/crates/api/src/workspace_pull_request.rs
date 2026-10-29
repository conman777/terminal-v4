use crate::{auth::AuthenticatedUser, state::AppState, workspace_git, ApiError};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const CACHE_TTL: Duration = Duration::from_secs(15);
const CACHE_LIMIT: usize = 64;
const VIEW_FIELDS: &str =
    "number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";

pub(crate) struct PullRequestCache {
    entries: Mutex<HashMap<String, (Instant, Value)>>,
}

impl PullRequestCache {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
    fn get(&self, key: &str) -> Option<Value> {
        let entries = self.entries.lock().unwrap();
        entries
            .get(key)
            .filter(|(at, _)| at.elapsed() < CACHE_TTL)
            .map(|(_, value)| value.clone())
    }
    fn put(&self, key: String, value: Value) {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= CACHE_LIMIT {
            entries.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        }
        if entries.len() >= CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(key, (Instant::now(), value));
    }
    pub(crate) fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

fn shared_cache() -> &'static PullRequestCache {
    static CACHE: OnceLock<PullRequestCache> = OnceLock::new();
    CACHE.get_or_init(PullRequestCache::new)
}

pub(crate) fn invalidate_cache() {
    shared_cache().clear();
}

pub(crate) fn summarize_pull_request(view: &Value) -> Value {
    let mut passed = 0;
    let mut failed = 0;
    let mut pending = 0;
    for check in view["statusCheckRollup"].as_array().into_iter().flatten() {
        let outcome = check["conclusion"]
            .as_str()
            .filter(|value| !value.is_empty())
            .or_else(|| check["state"].as_str())
            .unwrap_or("")
            .to_ascii_uppercase();
        match outcome.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => passed += 1,
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => failed += 1,
            _ => pending += 1,
        }
    }
    let mergeable = view["mergeable"].as_str().unwrap_or("UNKNOWN");
    json!({
        "number": view["number"], "url": view["url"], "title": view["title"], "state": view["state"],
        "isDraft": view["isDraft"].as_bool().unwrap_or(false),
        "mergeable": mergeable,
        "mergeStateStatus": view["mergeStateStatus"].as_str().unwrap_or("UNKNOWN"),
        "review": view["reviewDecision"].as_str().filter(|value| !value.is_empty()),
        "checks": { "passed": passed, "failed": failed, "pending": pending },
    })
}

enum ViewOutcome {
    Found(Value),
    NoPullRequest,
    Unavailable,
    Failed(String),
}

fn unavailable() -> Value {
    json!({ "pullRequest": null, "availability": "gh_unavailable", "reason": "Install the GitHub CLI (gh) and sign in to see pull request status" })
}

async fn fetch_view(program: &str, repo: &Path, branch: &str) -> ViewOutcome {
    let run = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(program)
            .current_dir(repo)
            .args(["pr", "view", branch, "--json", VIEW_FIELDS])
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::null())
            .output(),
    )
    .await;
    let Ok(run) = run else {
        return ViewOutcome::Failed("GitHub CLI timed out".into());
    };
    let Ok(output) = run else {
        return ViewOutcome::Unavailable;
    };
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        if detail
            .to_ascii_lowercase()
            .contains("no pull requests found")
        {
            return ViewOutcome::NoPullRequest;
        }
        return ViewOutcome::Failed(detail.trim().chars().take(400).collect());
    }
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(view) => ViewOutcome::Found(view),
        Err(_) => ViewOutcome::Failed("GitHub CLI returned unexpected output".into()),
    }
}

pub(crate) async fn status_with(
    program: &str,
    path: &str,
    cache: &PullRequestCache,
) -> Result<Value, ApiError> {
    let repo = workspace_git::repository(path).await?;
    let branch = workspace_git::current_branch(&repo).await?;
    let key = format!("{}\0{}", repo.display(), branch);
    if let Some(cached) = cache.get(&key) {
        return Ok(cached);
    }
    let value = match fetch_view(program, &repo, &branch).await {
        ViewOutcome::Found(view) => {
            json!({ "pullRequest": summarize_pull_request(&view), "availability": "ok" })
        }
        ViewOutcome::NoPullRequest => {
            json!({ "pullRequest": null, "availability": "none", "reason": "No pull request for this branch yet" })
        }
        ViewOutcome::Unavailable => return Ok(unavailable()),
        ViewOutcome::Failed(reason) => {
            return Ok(
                json!({ "pullRequest": null, "availability": "error", "reason": format!("Pull request status could not be checked: {reason}") }),
            );
        }
    };
    cache.put(key, value.clone());
    Ok(value)
}

pub(crate) async fn status(path: &str) -> Result<Value, ApiError> {
    status_with("gh", path, shared_cache()).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ActionInput {
    path: String,
    action: String,
    number: u64,
    #[serde(default)]
    method: Option<String>,
    confirm: String,
}

pub(crate) fn expected_confirmation(
    action: &str,
    number: u64,
    method: Option<&str>,
) -> Result<String, ApiError> {
    match (action, method) {
        ("ready", None) => Ok(format!("ready #{number}")),
        ("merge", Some(method @ ("merge" | "squash" | "rebase"))) => {
            Ok(format!("merge #{number} ({method})"))
        }
        ("merge", _) => Err(ApiError::bad_request(
            "Choose merge, squash or rebase to merge",
        )),
        ("ready", Some(_)) => Err(ApiError::bad_request("Marking ready takes no merge method")),
        _ => Err(ApiError::bad_request("Unsupported pull request action")),
    }
}

pub(crate) async fn act_with(
    program: &str,
    input: &ActionInput,
    cache: &PullRequestCache,
) -> Result<Value, ApiError> {
    let expected = expected_confirmation(&input.action, input.number, input.method.as_deref())?;
    if input.confirm != expected {
        return Err(ApiError::bad_request(
            "The confirmation does not match this action",
        ));
    }
    let repo = workspace_git::repository(&input.path).await?;
    let branch = workspace_git::current_branch(&repo).await?;
    let view = match fetch_view(program, &repo, &branch).await {
        ViewOutcome::Found(view) => view,
        ViewOutcome::NoPullRequest => {
            return Err(ApiError::bad_request("This branch has no pull request"))
        }
        ViewOutcome::Unavailable => {
            return Err(ApiError::bad_request(
                "Install the GitHub CLI (gh) and sign in to change pull requests",
            ))
        }
        ViewOutcome::Failed(reason) => {
            return Err(ApiError::bad_request(format!(
                "Pull request status could not be checked: {reason}"
            )))
        }
    };
    if view["number"].as_u64() != Some(input.number) || view["state"].as_str() != Some("OPEN") {
        return Err(ApiError::bad_request(
            "The pull request for this branch changed. Refresh and try again",
        ));
    }
    let draft = view["isDraft"].as_bool().unwrap_or(false);
    match input.action.as_str() {
        "ready" if !draft => return Err(ApiError::bad_request("This pull request is not a draft")),
        "merge" if draft => {
            return Err(ApiError::bad_request("Mark the draft ready before merging"))
        }
        "merge" if view["mergeable"].as_str() == Some("CONFLICTING") => {
            return Err(ApiError::bad_request(
                "This pull request has merge conflicts",
            ))
        }
        _ => {}
    }
    let number = input.number.to_string();
    let mut args: Vec<&str> = vec!["pr", &input.action, &number];
    if let Some(method) = input.method.as_deref() {
        args.push(match method {
            "squash" => "--squash",
            "rebase" => "--rebase",
            _ => "--merge",
        });
    }
    let run = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(program)
            .current_dir(&repo)
            .args(&args)
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::null())
            .output(),
    )
    .await;
    cache.clear();
    let Ok(run) = run else {
        return Err(ApiError::bad_request(
            "GitHub did not answer in time. The action may or may not have completed: refresh the pull request before retrying",
        ));
    };
    let output = run.map_err(|_| {
        ApiError::bad_request("Install the GitHub CLI (gh) and sign in to change pull requests")
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(format!(
            "GitHub CLI could not {} the pull request: {}",
            input.action,
            detail.trim().chars().take(400).collect::<String>()
        )));
    }
    Ok(json!({ "done": true, "action": input.action, "number": input.number }))
}

async fn action_route(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<ActionInput>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(act_with("gh", &input, shared_cache()).await?))
}

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/workspace/git/pull-request/action",
        axum::routing::post(action_route),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-b", "feature"],
            vec!["config", "user.name", "t"],
            vec!["config", "user.email", "t@example.test"],
            vec!["commit", "--allow-empty", "-m", "init"],
        ] {
            let status = std::process::Command::new("git")
                .current_dir(dir.path())
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        dir
    }

    fn fake_gh(view: &str, view_exit: i32, view_stderr: &str, act_exit: i32) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("view.json"), view).unwrap();
        std::fs::write(dir.path().join("view.err"), view_stderr).unwrap();
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> \"{d}/calls.log\"\nif [ \"$2\" = view ]; then\n  if [ {view_exit} -ne 0 ]; then cat \"{d}/view.err\" >&2; exit {view_exit}; fi\n  cat \"{d}/view.json\"; exit 0\nfi\nif [ {act_exit} -ne 0 ]; then echo 'boom: not allowed' >&2; exit {act_exit}; fi\nexit 0\n",
            d = dir.path().display()
        );
        let program = dir.path().join("gh");
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    fn calls(gh: &tempfile::TempDir) -> Vec<String> {
        std::fs::read_to_string(gh.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn program(gh: &tempfile::TempDir) -> String {
        gh.path().join("gh").display().to_string()
    }

    const OPEN: &str = r#"{"number":7,"url":"https://github.com/acme/app/pull/7","title":"Fix","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[{"conclusion":"SUCCESS"}]}"#;

    #[test]
    fn summary_counts_checks_and_carries_draft_and_conflict_state() {
        let view = json!({"number": 7, "url": "u", "title": "Fix", "state": "OPEN", "isDraft": true, "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY", "reviewDecision": "APPROVED",
            "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}, {"conclusion": "", "state": "PENDING"}, {"state": "SUCCESS"}]});
        assert_eq!(
            summarize_pull_request(&view),
            json!({"number": 7, "url": "u", "title": "Fix", "state": "OPEN", "isDraft": true, "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY", "review": "APPROVED",
                "checks": {"passed": 2, "failed": 1, "pending": 1}})
        );
    }

    #[test]
    fn confirmation_names_the_exact_action() {
        assert_eq!(
            [
                expected_confirmation("ready", 7, None).unwrap(),
                expected_confirmation("merge", 7, Some("squash")).unwrap(),
            ],
            ["ready #7".to_string(), "merge #7 (squash)".to_string()]
        );
        assert_eq!(
            [
                expected_confirmation("merge", 7, None).is_err(),
                expected_confirmation("merge", 7, Some("force")).is_err(),
                expected_confirmation("close", 7, None).is_err(),
                expected_confirmation("ready", 7, Some("squash")).is_err(),
            ],
            [true; 4]
        );
    }

    #[tokio::test]
    async fn status_is_cached_so_gh_is_asked_once_within_the_window() {
        let repo = repo();
        let gh = fake_gh(OPEN, 0, "", 0);
        let cache = PullRequestCache::new();
        let path = repo.path().to_str().unwrap();
        let first = status_with(&program(&gh), path, &cache).await.unwrap();
        let second = status_with(&program(&gh), path, &cache).await.unwrap();
        assert_eq!(
            (
                first == second,
                first["availability"].clone(),
                calls(&gh).len()
            ),
            (true, json!("ok"), 1)
        );
    }

    #[tokio::test]
    async fn status_distinguishes_no_pull_request_from_a_failing_gh_and_does_not_cache_failures() {
        let repo = repo();
        let path = repo.path().to_str().unwrap();
        let none = fake_gh("", 1, "no pull requests found for branch \"feature\"", 0);
        let broken = fake_gh("", 1, "HTTP 401: Bad credentials", 0);
        let cache = PullRequestCache::new();
        let none_status = status_with(&program(&none), path, &cache).await.unwrap();
        let cache = PullRequestCache::new();
        let first = status_with(&program(&broken), path, &cache).await.unwrap();
        status_with(&program(&broken), path, &cache).await.unwrap();
        let missing = status_with("gh-not-installed-for-test", path, &cache)
            .await
            .unwrap();
        assert_eq!(
            (
                none_status["availability"].clone(),
                first["availability"].clone(),
                first["reason"]
                    .as_str()
                    .unwrap()
                    .contains("Bad credentials"),
                calls(&broken).len(),
                missing["availability"].clone(),
            ),
            (
                json!("none"),
                json!("error"),
                true,
                2,
                json!("gh_unavailable")
            )
        );
    }

    fn input(path: &str, action: &str, method: Option<&str>, confirm: &str) -> ActionInput {
        ActionInput {
            path: path.into(),
            action: action.into(),
            number: 7,
            method: method.map(String::from),
            confirm: confirm.into(),
        }
    }

    #[tokio::test]
    async fn merge_requires_the_exact_confirmation_before_gh_runs_anything() {
        let repo = repo();
        let gh = fake_gh(OPEN, 0, "", 0);
        let cache = PullRequestCache::new();
        let wrong = act_with(
            &program(&gh),
            &input(
                repo.path().to_str().unwrap(),
                "merge",
                Some("squash"),
                "merge #7",
            ),
            &cache,
        )
        .await;
        assert_eq!(
            (wrong.unwrap_err().message, calls(&gh).len()),
            ("The confirmation does not match this action".to_string(), 0)
        );
    }

    #[tokio::test]
    async fn merge_runs_the_chosen_method_once_and_clears_the_cache() {
        let repo = repo();
        let gh = fake_gh(OPEN, 0, "", 0);
        let cache = PullRequestCache::new();
        let path = repo.path().to_str().unwrap();
        status_with(&program(&gh), path, &cache).await.unwrap();
        let done = act_with(
            &program(&gh),
            &input(path, "merge", Some("squash"), "merge #7 (squash)"),
            &cache,
        )
        .await
        .unwrap();
        assert_eq!(
            (done["done"].clone(), calls(&gh), cache.get(&format!("{}\0feature", std::fs::canonicalize(path).unwrap().display()))),
            (
                json!(true),
                vec![
                    "pr view feature --json number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup".to_string(),
                    "pr view feature --json number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup".to_string(),
                    "pr merge 7 --squash".to_string(),
                ],
                None
            )
        );
    }

    #[tokio::test]
    async fn actions_refuse_conflicts_drafts_stale_numbers_and_surface_gh_failures() {
        let repo = repo();
        let path = repo.path().to_str().unwrap();
        let cache = PullRequestCache::new();
        let conflict = fake_gh(&OPEN.replace("MERGEABLE", "CONFLICTING"), 0, "", 0);
        let draft = fake_gh(
            &OPEN.replace("\"isDraft\":false", "\"isDraft\":true"),
            0,
            "",
            0,
        );
        let failing = fake_gh(OPEN, 0, "", 1);
        let merge = |gh: &tempfile::TempDir| {
            let program = program(gh);
            let cache = &cache;
            async move {
                act_with(
                    &program,
                    &input(path, "merge", Some("merge"), "merge #7 (merge)"),
                    cache,
                )
                .await
            }
        };
        let ready_not_draft = act_with(
            &program(&failing),
            &input(path, "ready", None, "ready #7"),
            &cache,
        )
        .await;
        let mut stale = input(path, "merge", Some("merge"), "merge #8 (merge)");
        stale.number = 8;
        let stale = act_with(&program(&failing), &stale, &cache).await;
        assert_eq!(
            [
                merge(&conflict).await.unwrap_err().message,
                merge(&draft).await.unwrap_err().message,
                ready_not_draft.unwrap_err().message,
                stale.unwrap_err().message,
                merge(&failing).await.unwrap_err().message,
            ],
            [
                "This pull request has merge conflicts".to_string(),
                "Mark the draft ready before merging".to_string(),
                "This pull request is not a draft".to_string(),
                "The pull request for this branch changed. Refresh and try again".to_string(),
                "GitHub CLI could not merge the pull request: boom: not allowed".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn marking_a_draft_ready_runs_gh_pr_ready() {
        let repo = repo();
        let draft = fake_gh(
            &OPEN.replace("\"isDraft\":false", "\"isDraft\":true"),
            0,
            "",
            0,
        );
        let cache = PullRequestCache::new();
        act_with(
            &program(&draft),
            &input(repo.path().to_str().unwrap(), "ready", None, "ready #7"),
            &cache,
        )
        .await
        .unwrap();
        assert_eq!(
            calls(&draft).last().cloned(),
            Some("pr ready 7".to_string())
        );
    }
}
