//! Per-turn file changes, like T3 Code's "N changed files" card: the workspace is snapshotted
//! when a turn is accepted and again when it completes, and the difference is kept per turn.
use super::{sanitize_identifier, StructuredSessionManager};
use crate::{auth::AuthenticatedUser, state::AppState, workspace_git, ApiError};
use axum::{
    extract::{Path as RoutePath, State},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);
const KEPT_TURNS: usize = 200;

#[derive(Default)]
pub(super) struct TurnStarts {
    starts: std::sync::Mutex<HashMap<String, (PathBuf, String)>>,
    /// The latest turn each session began, for providers that end a turn with the session (Claude).
    open: std::sync::Mutex<HashMap<String, String>>,
    #[cfg(test)]
    begin_pause: std::sync::Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
    >,
}

pub(super) struct PendingStart<'a> {
    starts: &'a TurnStarts,
    session_id: String,
    turn_id: String,
    committed: bool,
}

impl PendingStart<'_> {
    pub(super) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PendingStart<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut open = self.starts.open.lock().unwrap();
        if open.get(&self.session_id) == Some(&self.turn_id) {
            open.remove(&self.session_id);
        }
        self.starts
            .starts
            .lock()
            .unwrap()
            .remove(&start_key(&self.session_id, &self.turn_id));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnChanges {
    pub from: String,
    pub to: String,
    pub files: Vec<Value>,
    pub added: u64,
    pub removed: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Journal {
    turns: BTreeMap<String, TurnChanges>,
    order: Vec<String>,
}

fn journal_path(data_dir: &Path, user_id: &str, session_id: &str) -> PathBuf {
    data_dir
        .join("structured-turn-changes")
        .join(hex::encode(Sha256::digest(user_id.as_bytes())))
        .join(format!("{}.json", sanitize_identifier(session_id)))
}

fn read_journal(path: &Path) -> Journal {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_journal(path: &Path, journal: &Journal) -> std::io::Result<()> {
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(parent)?;
    let file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file(), journal)?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

async fn snapshot(cwd: &str) -> Option<(PathBuf, String)> {
    tokio::time::timeout(SNAPSHOT_TIMEOUT, workspace_git::working_tree(cwd))
        .await
        .ok()?
        .ok()
}

fn start_key(session_id: &str, turn_id: &str) -> String {
    format!("{session_id}\n{turn_id}")
}

impl TurnStarts {
    #[cfg(test)]
    pub(super) fn has_open(&self, session_id: &str) -> bool {
        self.open.lock().unwrap().contains_key(session_id)
    }
    pub(super) fn pending(&self, session_id: &str, turn_id: &str) -> PendingStart<'_> {
        PendingStart {
            starts: self,
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            committed: false,
        }
    }
    #[cfg(test)]
    pub(super) fn pause_next_begin(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = tokio::sync::oneshot::channel();
        *self.begin_pause.lock().unwrap() = Some((entered, wait_release));
        (wait_entered, release)
    }

    pub(super) async fn prepare(&self, cwd: &str) -> Option<(PathBuf, String)> {
        #[cfg(test)]
        let pause = self.begin_pause.lock().unwrap().take();
        #[cfg(test)]
        if let Some((entered, release)) = pause {
            let _ = entered.send(());
            let _ = release.await;
        }
        snapshot(cwd).await
    }

    pub(super) fn begin_prepared(
        &self,
        session_id: &str,
        turn_id: &str,
        start: Option<(PathBuf, String)>,
    ) {
        self.open
            .lock()
            .unwrap()
            .insert(session_id.into(), turn_id.into());
        if let Some(start) = start {
            self.starts
                .lock()
                .unwrap()
                .entry(start_key(session_id, turn_id))
                .or_insert(start);
        }
    }

    pub(super) async fn begin(&self, session_id: &str, turn_id: &str, cwd: &str) {
        let key = start_key(session_id, turn_id);
        if self.starts.lock().unwrap().contains_key(&key) {
            return;
        }
        self.open
            .lock()
            .unwrap()
            .insert(session_id.into(), turn_id.into());
        #[cfg(test)]
        let pause = self.begin_pause.lock().unwrap().take();
        #[cfg(test)]
        if let Some((entered, release)) = pause {
            let _ = entered.send(());
            let _ = release.await;
        }
        if let Some(start) = snapshot(cwd).await {
            self.starts.lock().unwrap().entry(key).or_insert(start);
        }
    }

    /// Finishes whichever turn the session began last, if it is still open.
    pub(super) async fn finish_open(
        &self,
        data_dir: &Path,
        user_id: &str,
        session_id: &str,
        cwd: &str,
    ) {
        let open = self.open.lock().unwrap().get(session_id).cloned();
        if let Some(turn_id) = open {
            self.finish(data_dir, user_id, session_id, &turn_id, cwd)
                .await;
        }
    }

    /// Records what the turn changed. Turns outside a Git repository or without changes keep no entry.
    pub(super) async fn finish(
        &self,
        data_dir: &Path,
        user_id: &str,
        session_id: &str,
        turn_id: &str,
        cwd: &str,
    ) {
        {
            let mut open = self.open.lock().unwrap();
            if open.get(session_id).map(String::as_str) == Some(turn_id) {
                open.remove(session_id);
            }
        }
        let Some((repo, from)) = self
            .starts
            .lock()
            .unwrap()
            .remove(&start_key(session_id, turn_id))
        else {
            return;
        };
        let Some((end_repo, to)) = snapshot(cwd).await else {
            return;
        };
        if end_repo != repo || from == to {
            return;
        }
        let Ok((files, _)) = workspace_git::tree_changed_files(&repo, &from, &to).await else {
            return;
        };
        if files.is_empty() {
            return;
        }
        let total = |key: &str| files.iter().filter_map(|file| file[key].as_u64()).sum();
        let changes = TurnChanges {
            added: total("added"),
            removed: total("removed"),
            from,
            to,
            files,
        };
        let path = journal_path(data_dir, user_id, session_id);
        let mut journal = read_journal(&path);
        if journal.turns.insert(turn_id.into(), changes).is_none() {
            journal.order.push(turn_id.into());
        }
        while journal.order.len() > KEPT_TURNS {
            let oldest = journal.order.remove(0);
            journal.turns.remove(&oldest);
        }
        let _ = write_journal(&path, &journal);
    }
}

impl StructuredSessionManager {
    pub(crate) async fn turn_changes(
        &self,
        user_id: &str,
        id: &str,
    ) -> Result<Option<BTreeMap<String, TurnChanges>>, String> {
        let Some(_session) = self.owned_session(user_id, id).await? else {
            return Ok(None);
        };
        Ok(Some(
            read_journal(&journal_path(&self.inner.config.data_dir, user_id, id)).turns,
        ))
    }
}

async fn turn_changes_route(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    RoutePath(id): RoutePath<String>,
) -> Result<
    (
        [(axum::http::header::HeaderName, &'static str); 1],
        Json<Value>,
    ),
    ApiError,
> {
    let turns = state
        .structured_session_manager()
        .turn_changes(&user.user_id, &id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(json!({ "turns": turns })),
    ))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/structured/sessions/{id}/turn-changes",
        get(turn_changes_route),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_v4_core::{AppConfig, StructuredSessionEvent};

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap()
            .status;
        assert!(status.success(), "git {args:?}");
    }

    fn accepted(turn_id: &str) -> StructuredSessionEvent {
        StructuredSessionEvent::UserMessageAccepted {
            ts: 1,
            seq: 1,
            request_id: format!("request-{turn_id}"),
            turn_id: turn_id.into(),
            message_id: format!("message-{turn_id}"),
            content: "edit the note".into(),
            attachments: Vec::new(),
        }
    }

    fn completed(turn_id: &str) -> StructuredSessionEvent {
        StructuredSessionEvent::TurnCompleted {
            ts: 2,
            seq: 1,
            turn_id: turn_id.into(),
            status: "completed".into(),
        }
    }

    #[tokio::test]
    async fn claude_turns_run_from_the_user_message_to_the_end_of_the_cli_session() {
        let data = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-b", "main"]);
        git(repo.path(), &["config", "user.name", "Turn tests"]);
        git(repo.path(), &["config", "user.email", "turns@example.test"]);
        std::fs::write(repo.path().join("note.txt"), "one\n").unwrap();
        git(repo.path(), &["add", "note.txt"]);
        git(repo.path(), &["commit", "-m", "initial"]);
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session(
                "owner",
                repo.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let user_message = StructuredSessionEvent::MessageCompleted {
            message_id: Some("message-1".into()),
            turn_id: None,
            ts: 1,
            seq: 1,
            role: "user".into(),
            content: "edit the note".into(),
        };
        manager
            .record_event("owner", &session.id, user_message)
            .await
            .unwrap();
        std::fs::write(repo.path().join("note.txt"), "one\ntwo\n").unwrap();
        let ended = StructuredSessionEvent::SessionEnded {
            ts: 2,
            seq: 1,
            session_id: "cli-session".into(),
            reason: "completed".into(),
        };
        manager
            .record_event("owner", &session.id, ended)
            .await
            .unwrap();

        let turns = manager
            .turn_changes("owner", &session.id)
            .await
            .unwrap()
            .unwrap();
        let summary: Vec<_> = turns
            .iter()
            .map(|(turn, changes)| (turn.as_str(), changes.files.len(), changes.added))
            .collect();
        assert_eq!(summary, [("message-1", 1, 1)]);
    }

    #[tokio::test]
    async fn keeps_the_files_each_turn_changed_for_its_owner() {
        let data = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-b", "main"]);
        git(repo.path(), &["config", "user.name", "Turn tests"]);
        git(repo.path(), &["config", "user.email", "turns@example.test"]);
        std::fs::write(repo.path().join("note.txt"), "one\n").unwrap();
        git(repo.path(), &["add", "note.txt"]);
        git(repo.path(), &["commit", "-m", "initial"]);
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        let session = manager
            .create_session("owner", repo.path().to_str().unwrap(), None, None, None)
            .await
            .unwrap();

        manager
            .record_event("owner", &session.id, accepted("turn-1"))
            .await
            .unwrap();
        std::fs::write(repo.path().join("note.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.path().join("added.txt"), "new\n").unwrap();
        manager
            .record_event("owner", &session.id, completed("turn-1"))
            .await
            .unwrap();
        manager
            .record_event("owner", &session.id, accepted("turn-2"))
            .await
            .unwrap();
        manager
            .record_event("owner", &session.id, completed("turn-2"))
            .await
            .unwrap();

        let turns = manager
            .turn_changes("owner", &session.id)
            .await
            .unwrap()
            .unwrap();
        let summary: Vec<_> = turns
            .iter()
            .map(|(turn, changes)| {
                let paths: Vec<_> = changes
                    .files
                    .iter()
                    .map(|file| file["path"].as_str().unwrap().to_owned())
                    .collect();
                (turn.as_str(), paths, changes.added, changes.removed)
            })
            .collect();
        assert_eq!(
            summary,
            [(
                "turn-1",
                vec!["added.txt".to_owned(), "note.txt".to_owned()],
                3,
                0
            )]
        );
        assert_eq!(
            manager.turn_changes("intruder", &session.id).await.unwrap(),
            None
        );
    }
}
