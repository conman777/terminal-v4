use super::*;
use crate::{
    auth::{AuthenticatedUser, LocalAuthority, PairedInputAuthority},
    state::AppState,
};
use axum::{
    body::Body,
    extract::Extension,
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use tower::ServiceExt;

#[tokio::test]
async fn session_get_rejects_local_logout_while_waiting_for_state() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let snapshot = manager
        .create_session(
            "owner",
            data.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
    let session = manager
        .owned_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    let held = session.state.lock().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}",
            get(crate::get_structured_session),
        )
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(AuthenticatedUser {
            user_id: "owner".into(),
            username: "fixture".into(),
        }))
        .with_state(state.clone());
    let request = Request::builder()
        .uri(format!("/api/structured/sessions/{}", snapshot.id))
        .body(Body::empty())
        .unwrap();
    let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
    wait.await.unwrap();
    state.logout_user("owner").unwrap();
    drop(held);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_lists_reject_logout_while_waiting_for_state() {
    for (method, query) in [("GET", ""), ("HEAD", "?view=inventory")] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let manager = StructuredSessionManager::new(config.clone());
        let snapshot = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
        let session = manager
            .owned_session("owner", &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let held = session.state.lock().await;
        let (entered, wait) = tokio::sync::oneshot::channel();
        *manager.inner.read_session_entered.lock().unwrap() = Some(entered);
        let app = Router::new()
            .route(
                "/api/structured/sessions",
                get(crate::list_structured_sessions),
            )
            .layer(Extension(LocalAuthority::for_test(
                "owner",
                0,
                crate::v4_agent::interaction::now_ms() + 60_000,
            )))
            .layer(Extension(AuthenticatedUser {
                user_id: "owner".into(),
                username: "fixture".into(),
            }))
            .with_state(state.clone());
        let request = Request::builder()
            .method(method)
            .uri(format!("/api/structured/sessions{query}"))
            .body(Body::empty())
            .unwrap();
        let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
        wait.await.unwrap();
        state.logout_user("owner").unwrap();
        drop(held);
        assert_eq!(
            pending.await.unwrap().status(),
            StatusCode::UNAUTHORIZED,
            "{method} {query}"
        );
    }
}

#[tokio::test]
async fn revoked_request_does_not_rewrite_lazy_recovery_checkpoint() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let writer = StructuredSessionManager::new(config.clone());
    let snapshot = writer
        .create_session(
            "owner",
            data.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let path = structured_session_path(&config, "owner", &snapshot.id);
    let original = std::fs::read(&path).unwrap();
    let manager = StructuredSessionManager::new(config.clone());
    let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
    let held = manager.inner.loaded_owners.lock().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    *manager.inner.read_load_entered.lock().unwrap() = Some(entered);
    let app = Router::new()
        .route(
            "/api/structured/sessions",
            get(crate::list_structured_sessions),
        )
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(AuthenticatedUser {
            user_id: "owner".into(),
            username: "fixture".into(),
        }))
        .with_state(state.clone());
    let pending = tokio::spawn(async move {
        app.oneshot(
            Request::builder()
                .uri("/api/structured/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    });
    wait.await.unwrap();
    state.logout_user("owner").unwrap();
    drop(held);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!manager.inner.loaded_owners.lock().await.contains("owner"));
}

#[tokio::test]
async fn paired_get_rejects_revocation_and_wrong_route_scope() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let snapshot = manager
        .create_session(
            "owner",
            data.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let session = manager
        .owned_session("owner", &snapshot.id)
        .await
        .unwrap()
        .unwrap();
    let held = session.state.lock().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
    let path = format!("/api/structured/sessions/{}", snapshot.id);
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}",
            get(crate::get_structured_session),
        )
        .layer(Extension(PairedInputAuthority {
            token,
            path: path.clone(),
            method: "GET".into(),
        }))
        .layer(Extension(AuthenticatedUser {
            user_id: "owner".into(),
            username: "fixture".into(),
        }))
        .with_state(state.clone());
    let wrong_method = Request::builder()
        .method("HEAD")
        .uri(&path)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(wrong_method).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let request = Request::builder().uri(&path).body(Body::empty()).unwrap();
    let pending = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
    wait.await.unwrap();
    let guard = state.acquire_input_guard("owner").unwrap();
    state
        .lock_db()
        .unwrap()
        .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
        .unwrap();
    drop(guard);
    drop(held);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

const OWNER: &str = "owner";

async fn interrupted_codex_session(
    manager: &StructuredSessionManager,
    owner: &str,
    cwd: &str,
    label: &str,
) -> String {
    let snapshot = manager
        .create_session(owner, cwd, Some("codex"), None, None)
        .await
        .unwrap();
    let seq = {
        let session = manager
            .owned_session(owner, &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let state = session.state.lock().await;
        next_session_seq(&state.events).unwrap()
    };
    manager
        .record_event(
            owner,
            &snapshot.id,
            StructuredSessionEvent::UserMessageAccepted {
                ts: now_ts(),
                seq,
                request_id: format!("request-{label}"),
                turn_id: format!("turn-{label}"),
                message_id: format!("message-{label}"),
                content: format!("interrupted {label}"),
                attachments: vec![],
            },
        )
        .await
        .unwrap();
    snapshot.id
}

fn local_read_app(state: &AppState, owner: &str) -> Router {
    Router::new()
        .route(
            "/api/structured/sessions",
            get(crate::list_structured_sessions),
        )
        .route(
            "/api/structured/sessions/{id}",
            get(crate::get_structured_session),
        )
        .layer(Extension(LocalAuthority::for_test(
            owner,
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(AuthenticatedUser {
            user_id: owner.into(),
            username: "fixture".into(),
        }))
        .with_state(state.clone())
}

fn checkpoint_files(config: &AppConfig, owner: &str) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(structured_user_dir(config, owner))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    files.sort();
    files
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn authorized_read_recovers_interrupted_turn_on_disk() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let writer = StructuredSessionManager::new(config.clone());
    let id = interrupted_codex_session(&writer, OWNER, data.path().to_str().unwrap(), "a").await;
    let before = checkpoint_files(&config, OWNER);
    let manager = StructuredSessionManager::new(config.clone());
    let state = AppState::new_with_services(config.clone(), None, manager).unwrap();
    let response = local_read_app(&state, OWNER)
        .oneshot(
            Request::builder()
                .uri(format!("/api/structured/sessions/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert!(
        body["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "turn_completed" && event["status"] == "interrupted"),
        "{body}"
    );
    assert_ne!(checkpoint_files(&config, OWNER), before);
}

#[tokio::test]
async fn revoked_read_leaves_recovery_files_and_manager_untouched_while_waiting_to_load() {
    for paired in [false, true] {
        for target in ["list", "inventory", "get"] {
            let data = tempfile::tempdir().unwrap();
            let config = AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            };
            let writer = StructuredSessionManager::new(config.clone());
            let id =
                interrupted_codex_session(&writer, OWNER, data.path().to_str().unwrap(), "a").await;
            let before = checkpoint_files(&config, OWNER);
            let manager = StructuredSessionManager::new(config.clone());
            let state = AppState::new_with_services(config.clone(), None, manager.clone()).unwrap();
            let (uri, path) = match target {
                "list" => (
                    "/api/structured/sessions".to_string(),
                    "/api/structured/sessions".to_string(),
                ),
                "inventory" => (
                    "/api/structured/sessions?view=inventory".to_string(),
                    "/api/structured/sessions".to_string(),
                ),
                _ => {
                    let path = format!("/api/structured/sessions/{id}");
                    (path.clone(), path)
                }
            };
            let held = manager.inner.loaded_owners.lock().await;
            let (entered, wait) = tokio::sync::oneshot::channel();
            *manager.inner.read_load_entered.lock().unwrap() = Some(entered);
            let mut router = Router::new()
                .route(
                    "/api/structured/sessions",
                    get(crate::list_structured_sessions),
                )
                .route(
                    "/api/structured/sessions/{id}",
                    get(crate::get_structured_session),
                )
                .layer(Extension(AuthenticatedUser {
                    user_id: OWNER.into(),
                    username: "fixture".into(),
                }));
            let mut grant = None;
            router = if paired {
                let (id, token) = crate::paired_environments::synthetic_input_grant(&state, OWNER);
                grant = Some(id);
                router.layer(Extension(PairedInputAuthority {
                    token,
                    path,
                    method: "GET".into(),
                }))
            } else {
                router.layer(Extension(LocalAuthority::for_test(
                    OWNER,
                    0,
                    crate::v4_agent::interaction::now_ms() + 60_000,
                )))
            };
            let app = router.with_state(state.clone());
            let pending = tokio::spawn(async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            });
            wait.await.unwrap();
            if let Some(grant) = grant {
                let guard = state.acquire_input_guard(OWNER).unwrap();
                state
                    .lock_db()
                    .unwrap()
                    .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
                    .unwrap();
                drop(guard);
            } else {
                state.logout_user(OWNER).unwrap();
            }
            drop(held);
            let label = format!("paired={paired} target={target}");
            assert_eq!(
                pending.await.unwrap().status(),
                StatusCode::UNAUTHORIZED,
                "{label}"
            );
            assert_eq!(checkpoint_files(&config, OWNER), before, "{label}");
            assert!(
                !manager.inner.loaded_owners.lock().await.contains(OWNER),
                "{label}"
            );
            assert!(manager.inner.sessions.lock().await.is_empty(), "{label}");
        }
    }
}

#[tokio::test]
async fn revocation_between_recovery_checkpoints_stops_later_writes_and_publication() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let writer = StructuredSessionManager::new(config.clone());
    for label in ["a", "b"] {
        interrupted_codex_session(&writer, OWNER, data.path().to_str().unwrap(), label).await;
    }
    let before = checkpoint_files(&config, OWNER);
    let manager = StructuredSessionManager::new(config.clone());
    let state = AppState::new_with_services(config.clone(), None, manager.clone()).unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    *manager.inner.read_recovery_hook.lock().unwrap() = Some(Box::new({
        let state = state.clone();
        move || {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                state.logout_user(OWNER).unwrap();
            }
        }
    }));
    let response = local_read_app(&state, OWNER)
        .oneshot(
            Request::builder()
                .uri("/api/structured/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let after = checkpoint_files(&config, OWNER);
    assert_eq!(
        after
            .iter()
            .zip(&before)
            .filter(|(after, before)| after != before)
            .count(),
        1
    );
    assert_eq!(after.len(), before.len());
    assert!(!manager.inner.loaded_owners.lock().await.contains(OWNER));
    assert!(manager.inner.sessions.lock().await.is_empty());
}

#[tokio::test]
async fn session_deleted_while_waiting_is_not_returned() {
    for target in ["list", "inventory", "get"] {
        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let manager = StructuredSessionManager::new(config.clone());
        let snapshot = manager
            .create_session(
                OWNER,
                data.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
        let session = manager
            .owned_session(OWNER, &snapshot.id)
            .await
            .unwrap()
            .unwrap();
        let held = session.state.lock().await;
        let (entered, wait) = tokio::sync::oneshot::channel();
        let uri = match target {
            "list" => {
                *manager.inner.read_session_entered.lock().unwrap() = Some(entered);
                "/api/structured/sessions".to_string()
            }
            "inventory" => {
                *manager.inner.read_session_entered.lock().unwrap() = Some(entered);
                "/api/structured/sessions?view=inventory".to_string()
            }
            _ => {
                *manager.inner.get_session_entered.lock().unwrap() = Some(entered);
                format!("/api/structured/sessions/{}", snapshot.id)
            }
        };
        let app = local_read_app(&state, OWNER);
        let pending = tokio::spawn(async move {
            app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap()
        });
        wait.await.unwrap();
        manager.inner.sessions.lock().await.remove(&snapshot.id);
        drop(held);
        let response = pending.await.unwrap();
        if target == "get" {
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{target}");
        } else {
            assert_eq!(response.status(), StatusCode::OK, "{target}");
            assert_eq!(body_json(response).await, serde_json::json!([]), "{target}");
        }
    }
}

#[tokio::test]
async fn reads_never_return_another_owners_session() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let own = manager
        .create_session(
            OWNER,
            data.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let foreign = manager
        .create_session(
            "other",
            data.path().to_str().unwrap(),
            Some("claude"),
            None,
            None,
        )
        .await
        .unwrap();
    let state = AppState::new_with_services(config, None, manager).unwrap();
    let app = local_read_app(&state, OWNER);
    for uri in [
        "/api/structured/sessions",
        "/api/structured/sessions?view=inventory",
    ] {
        let body = body_json(
            app.clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        let ids: Vec<_> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec![own.id.clone()], "{uri}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/structured/sessions/{}", foreign.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
