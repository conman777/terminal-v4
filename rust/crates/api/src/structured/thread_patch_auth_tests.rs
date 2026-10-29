use super::*;
use crate::{
    auth::{AuthenticatedUser, LocalAuthority, PairedInputAuthority},
    state::AppState,
};
use axum::{
    body::Body,
    extract::Extension,
    http::{Request, StatusCode},
    routing::patch,
    Router,
};
use tower::ServiceExt;

type Pause = (
    String,
    std::sync::mpsc::Sender<()>,
    std::sync::mpsc::Receiver<()>,
);
static BEFORE_PUBLICATION: std::sync::Mutex<Vec<Pause>> = std::sync::Mutex::new(Vec::new());
static UNCONFIRMED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub(super) fn take_unconfirmed(id: &str) -> bool {
    let mut pending = UNCONFIRMED.lock().unwrap();
    pending
        .iter()
        .position(|candidate| candidate == id)
        .is_some_and(|index| {
            pending.remove(index);
            true
        })
}

pub(super) fn pause_at_publication(id: &str) {
    let pause = {
        let mut pauses = BEFORE_PUBLICATION.lock().unwrap();
        pauses
            .iter()
            .position(|(candidate, _, _)| candidate == id)
            .map(|index| pauses.remove(index))
    };
    if let Some((_, entered, release)) = pause {
        let _ = entered.send(());
        let _ = release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

async fn fixture() -> (
    tempfile::TempDir,
    StructuredSessionManager,
    AppState,
    String,
) {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    };
    let manager = StructuredSessionManager::new(config.clone());
    let session = manager
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
    (data, manager, state, session.id)
}

fn request(id: &str) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(format!("/api/structured/sessions/{id}/thread"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"pinned":true}"#))
        .unwrap()
}

fn user() -> AuthenticatedUser {
    AuthenticatedUser {
        user_id: "owner".into(),
        username: "fixture".into(),
    }
}

#[tokio::test]
async fn local_thread_patch_rejects_logout_while_waiting_for_lifecycle() {
    let (_data, manager, state, id) = fixture().await;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let guard = session.lifecycle.lock().await;
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}/thread",
            patch(crate::update_structured_thread),
        )
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(user()))
        .with_state(state.clone());
    let req = request(&id);
    let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap() });
    tokio::task::yield_now().await;
    state.logout_user("owner").unwrap();
    drop(guard);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert!(
        !manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[tokio::test]
async fn local_thread_patch_rejects_expiry_while_waiting_for_lifecycle() {
    let (_data, manager, state, id) = fixture().await;
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let guard = session.lifecycle.lock().await;
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}/thread",
            patch(crate::update_structured_thread),
        )
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 40,
        )))
        .layer(Extension(user()))
        .with_state(state);
    let req = request(&id);
    let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    drop(guard);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert!(
        !manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[tokio::test]
async fn paired_thread_patch_rejects_revocation_before_owner_guard() {
    let (_data, manager, state, id) = fixture().await;
    let (grant, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let session = manager.owned_session("owner", &id).await.unwrap().unwrap();
    let lifecycle = session.lifecycle.lock().await;
    let guard = state.acquire_input_guard("owner").unwrap();
    let path = format!("/api/structured/sessions/{id}/thread");
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}/thread",
            patch(crate::update_structured_thread),
        )
        .layer(Extension(PairedInputAuthority {
            token,
            path,
            method: "PATCH".into(),
        }))
        .layer(Extension(user()))
        .with_state(state.clone());
    let req = request(&id);
    let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap() });
    tokio::task::yield_now().await;
    state
        .lock_db()
        .unwrap()
        .execute("DELETE FROM paired_grants WHERE id=?1", [&grant])
        .unwrap();
    drop(guard);
    drop(lifecycle);
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert!(
        !manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_thread_patch_rechecks_expiry_at_snapshot_publication() {
    let (_data, manager, state, id) = fixture().await;
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    BEFORE_PUBLICATION
        .lock()
        .unwrap()
        .push((id.clone(), entered_tx, release_rx));
    let expires = crate::v4_agent::interaction::now_ms() + 1_500;
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}/thread",
            patch(crate::update_structured_thread),
        )
        .layer(Extension(LocalAuthority::for_test("owner", 0, expires)))
        .layer(Extension(user()))
        .with_state(state);
    let req = request(&id);
    let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap() });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
    })
    .await
    .unwrap();
    let delay = expires
        .saturating_sub(crate::v4_agent::interaction::now_ms())
        .max(0) as u64
        + 20;
    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    release_tx.send(()).unwrap();
    assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert!(
        !manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[tokio::test]
async fn thread_patch_accepts_valid_local_and_paired_credentials_and_rejects_missing_or_wrong_scope(
) {
    let (_data, manager, state, id) = fixture().await;
    let router = Router::new().route(
        "/api/structured/sessions/{id}/thread",
        patch(crate::update_structured_thread),
    );
    let local = router
        .clone()
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(user()))
        .with_state(state.clone());
    assert_eq!(
        local.oneshot(request(&id)).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(
        manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
    let (_, token) = crate::paired_environments::synthetic_input_grant(&state, "owner");
    let paired = router
        .clone()
        .layer(Extension(PairedInputAuthority {
            token: token.clone(),
            path: format!("/api/structured/sessions/{id}/thread"),
            method: "PATCH".into(),
        }))
        .layer(Extension(user()))
        .with_state(state.clone());
    assert_eq!(
        paired.oneshot(request(&id)).await.unwrap().status(),
        StatusCode::OK
    );
    let wrong = router
        .clone()
        .layer(Extension(PairedInputAuthority {
            token,
            path: "/api/structured/sessions/another/thread".into(),
            method: "PATCH".into(),
        }))
        .layer(Extension(user()))
        .with_state(state.clone());
    assert_eq!(
        wrong.oneshot(request(&id)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let missing = router.layer(Extension(user())).with_state(state);
    assert_eq!(
        missing.oneshot(request(&id)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn unconfirmed_auth_commit_reports_uncertainty_and_keeps_published_state() {
    let (_data, manager, state, id) = fixture().await;
    UNCONFIRMED.lock().unwrap().push(id.clone());
    let app = Router::new()
        .route(
            "/api/structured/sessions/{id}/thread",
            patch(crate::update_structured_thread),
        )
        .layer(Extension(LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        )))
        .layer(Extension(user()))
        .with_state(state);
    let response = app.oneshot(request(&id)).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        manager
            .get_thread("owner", &id)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
}
