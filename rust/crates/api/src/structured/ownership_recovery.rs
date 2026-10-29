//! Owner-authenticated recovery for a previously unconfirmed structured runtime.

use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{
    extract::State,
    http::{header, StatusCode},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    epoch: Uuid,
    operation_id: Uuid,
    acknowledged: bool,
}

pub(crate) fn routes() -> Router<AppState> {
    let routes = Router::new()
        .route("/api/structured/ownership", get(inspect))
        .route("/api/structured/ownership/reconcile", post(reconcile));
    #[cfg(unix)]
    let routes = routes
        .route("/api/structured/owner-cleanup", get(cleanup_status))
        .route("/api/structured/owner-cleanup/retry", post(cleanup_retry))
        .route(
            "/api/structured/owner-cleanup/background-review",
            post(review_background),
        )
        .route(
            "/api/structured/background-review",
            get(background_review_status).post(review_background_standalone),
        )
        .route(
            "/api/structured/owner-cleanup/delegation-children",
            get(delegation_children),
        )
        .route(
            "/api/structured/owner-cleanup/delegation-review",
            post(review_delegation),
        )
        .route(
            "/api/structured/owner-cleanup/delegation-review/{operation}",
            get(delegation_review_receipt),
        );
    routes
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationReview {
    request_id: Uuid,
    operation_id: Uuid,
    child_operation_id: Uuid,
    acknowledged: bool,
}

#[cfg(unix)]
async fn delegation_children(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    let value = app
        .structured_session_manager()
        .pending_delegation_reviews(&user.user_id)
        .await
        .map_err(|_| ApiError {
            status: StatusCode::CONFLICT,
            message: "Delegation cleanup cannot be inspected yet".into(),
        })?
        .ok_or_else(|| ApiError::not_found("Owner cleanup is not enabled"))?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(value)))
}

#[cfg(unix)]
async fn review_delegation(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    Json(review): Json<DelegationReview>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    if !review.acknowledged
        || review.request_id.is_nil()
        || review.operation_id.is_nil()
        || review.child_operation_id.is_nil()
    {
        return Err(ApiError::bad_request(
            "Explicit acknowledgment and valid review identity are required",
        ));
    }
    let authority = authority
        .map(|Extension(value)| value)
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "A direct owner login is required".into(),
        })?;
    let manager = app.structured_session_manager();
    let value = tokio::spawn(async move {
        manager
            .review_delegation_cleanup(
                app,
                user.user_id,
                authority,
                review.request_id,
                review.operation_id,
                review.child_operation_id,
            )
            .await
    })
    .await
    .map_err(|_| ApiError::internal("Delegation review outcome is uncertain"))?
    .map_err(|_| ApiError {
        status: StatusCode::CONFLICT,
        message: "Delegation review could not be confirmed; check the receipt before retrying"
            .into(),
    })?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(value)))
}

#[cfg(unix)]
async fn delegation_review_receipt(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    axum::extract::Path(operation): axum::extract::Path<Uuid>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    let manager = app.structured_session_manager();
    let value = tokio::task::spawn_blocking(move || {
        manager.delegation_review_receipt(&user.user_id, operation)
    })
    .await
    .map_err(|_| ApiError::internal("Cannot inspect delegation review"))?
    .map_err(|_| ApiError::internal("Cannot inspect delegation review"))?
    .ok_or_else(|| ApiError::not_found("Delegation review not found"))?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(value)))
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackgroundReview {
    request_id: Uuid,
    operation_id: Uuid,
    acknowledged: bool,
}

#[cfg(unix)]
async fn review_background(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    Json(review): Json<BackgroundReview>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    if !review.acknowledged || review.request_id.is_nil() || review.operation_id.is_nil() {
        return Err(ApiError::bad_request(
            "Explicit acknowledgment and valid review identity are required",
        ));
    }
    let authority = authority
        .map(|Extension(value)| value)
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "A direct owner login is required".into(),
        })?;
    let manager = app.structured_session_manager();
    let request = review.request_id;
    let operation = review.operation_id;
    let result = tokio::spawn(async move {
        manager
            .review_background_cleanup(app, user.user_id, authority, request, operation)
            .await
    })
    .await
    .map_err(|_| ApiError::internal("Background review outcome is uncertain"))?
    .map_err(|_| ApiError {
        status: StatusCode::CONFLICT,
        message: "Background review could not be confirmed; check status before retrying".into(),
    })?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(
            serde_json::json!({"status":"reviewed","requestId":request,"operationId":operation,"reviewedCount":result}),
        ),
    ))
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandaloneBackgroundReview {
    operation_id: Uuid,
    acknowledged: bool,
}

#[cfg(unix)]
fn bound_background(
    app: &AppState,
) -> Result<std::sync::Arc<crate::v4_agent::background_process::BackgroundProcesses>, ApiError> {
    app.structured_session_manager()
        .inner
        .background_processes
        .get()
        .cloned()
        .ok_or_else(|| ApiError::not_found("Background commands are not enabled"))
}

#[cfg(unix)]
async fn background_review_status(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    let background = bound_background(&app)?;
    let unknown =
        tokio::task::spawn_blocking(move || background.owner_cleanup_unconfirmed(&user.user_id))
            .await
            .map_err(|_| ApiError::internal("Cannot inspect background commands"))?
            .map_err(|_| ApiError::internal("Cannot inspect background commands"))?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(serde_json::json!({"unknown":unknown})),
    ))
}

#[cfg(unix)]
async fn review_background_standalone(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    Json(review): Json<StandaloneBackgroundReview>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    if !review.acknowledged || review.operation_id.is_nil() {
        return Err(ApiError::bad_request(
            "Explicit acknowledgment and valid review identity are required",
        ));
    }
    let authority = authority
        .map(|Extension(value)| value)
        .ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "A direct owner login is required".into(),
        })?;
    let background = bound_background(&app)?;
    let operation = review.operation_id;
    let count = tokio::task::spawn_blocking(move || {
        background.review_unknown_owner_standalone(&app, &user.user_id, &authority, operation, true)
    })
    .await
    .map_err(|_| ApiError::internal("Background review outcome is uncertain"))?
    .map_err(|_| ApiError {
        status: StatusCode::CONFLICT,
        message: "Background review could not be confirmed; check status before retrying".into(),
    })?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(
            serde_json::json!({"status":"reviewed","operationId":operation,"reviewedCount":count}),
        ),
    ))
}

#[cfg(unix)]
async fn cleanup_retry(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    let manager = app.structured_session_manager();
    let status = tokio::task::spawn_blocking(move || manager.wake_owner_cleanup(&user.user_id))
        .await
        .map_err(|_| ApiError::internal("Cannot retry owner cleanup"))?
        .map_err(|_| ApiError::internal("Cannot retry owner cleanup"))?
        .ok_or_else(|| ApiError::not_found("Owner cleanup is not enabled"))?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(status)))
}

#[cfg(unix)]
async fn cleanup_status(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<serde_json::Value>,
    ),
    ApiError,
> {
    let manager = app.structured_session_manager();
    let background = manager.inner.background_processes.get().cloned();
    let status = tokio::task::spawn_blocking(move || {
        let Some(mut status) = manager.owner_cleanup_status(&user.user_id)? else {
            return Ok(None);
        };
        if let Some(unknown) = background
            .and_then(|background| background.owner_cleanup_unconfirmed(&user.user_id).ok())
        {
            status["backgroundUnknown"] = serde_json::Value::Bool(unknown);
        }
        Ok::<_, String>(Some(status))
    })
    .await
    .map_err(|_| ApiError::internal("Cannot inspect owner cleanup"))?
    .map_err(|_| ApiError::internal("Cannot inspect owner cleanup"))?
    .ok_or_else(|| ApiError::not_found("Owner cleanup is not enabled"))?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(status)))
}

async fn inspect(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Status>), ApiError> {
    let manager = app.structured_session_manager();
    if !manager.live_ownership_enabled() {
        return Err(ApiError::not_found("Session ownership is not enabled"));
    }
    let owner = user.user_id;
    let state = tokio::task::spawn_blocking(move || manager.live_owner_status(&owner))
        .await
        .map_err(|_| ApiError::internal("Cannot inspect session ownership"))?
        .map_err(|_| ApiError::internal("Cannot inspect session ownership"))?;
    let status = match state {
        super::live_ownership::OwnerState::Owned => Status {
            state: "owned",
            epoch: None,
        },
        super::live_ownership::OwnerState::NotProvisioned => Status {
            state: "notProvisioned",
            epoch: None,
        },
        super::live_ownership::OwnerState::Busy => Status {
            state: "busy",
            epoch: None,
        },
        super::live_ownership::OwnerState::Clean => Status {
            state: "clean",
            epoch: None,
        },
        super::live_ownership::OwnerState::Unconfirmed { epoch } => Status {
            state: "unconfirmed",
            epoch: Some(epoch),
        },
    };
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(status)))
}

async fn reconcile(
    State(app): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(review): Json<Review>,
) -> Result<([(header::HeaderName, &'static str); 1], StatusCode), ApiError> {
    if !app.structured_session_manager().live_ownership_enabled() {
        return Err(ApiError::not_found("Session ownership is not enabled"));
    }
    if !review.acknowledged || review.epoch.is_nil() || review.operation_id.is_nil() {
        return Err(ApiError::bad_request(
            "Explicit acknowledgment and valid review identity are required",
        ));
    }
    let data = app.config().data_dir.clone();
    let owner = user.user_id;
    tokio::task::spawn_blocking(move || {
        super::live_ownership::ManagerLeases::new(&data)?.reconcile_unknown(
            &owner,
            review.epoch,
            review.operation_id,
            review.acknowledged,
        )
    })
    .await
    .map_err(|_| ApiError::internal("Ownership review outcome could not be confirmed"))?
    .map_err(|_| ApiError {
        status: StatusCode::CONFLICT,
        message: "Ownership state changed or could not be confirmed; check it again".into(),
    })?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        StatusCode::NO_CONTENT,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_status_is_owner_scoped_and_read_only_while_held() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let manager = state.structured_session_manager();
        manager.bind_live_ownership().unwrap();
        manager
            .bind_owner_cleanup(state.provision_owner_cleanup().unwrap())
            .unwrap();
        state.logout_user("alice").unwrap();
        let get = |owner: &str| {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: owner.into(),
                    username: owner.into(),
                }))
                .with_state(state.clone())
        };
        let request = || {
            Request::builder()
                .uri("/api/structured/owner-cleanup")
                .body(Body::empty())
                .unwrap()
        };
        let response = get("alice").oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let status: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(status["state"], "pending");
        assert!(status["requestId"].as_str().is_some());
        assert_eq!(
            status["resources"],
            serde_json::json!({"structured":"pending", "delegation":"pending", "background":"not_installed"})
        );
        let other = get("bob").oneshot(request()).await.unwrap();
        let other: serde_json::Value =
            serde_json::from_slice(&other.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(other["state"], "complete");
        assert!(other["requestId"].is_null());
        assert!(manager
            .owner_cleanup_for_test()
            .unwrap()
            .is_held("alice")
            .unwrap());
        let retry = || {
            Request::builder()
                .method("POST")
                .uri("/api/structured/owner-cleanup/retry")
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            get("bob").oneshot(retry()).await.unwrap().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        manager.start_owner_cleanup_workers().unwrap();
        let response = get("bob").oneshot(retry()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let other: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(other["state"], "complete");
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn runtime_state_exclusively_owns_sessions_until_clean_shutdown() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let first = AppState::new_runtime(config.clone()).unwrap();
        let second = AppState::new_runtime(config.clone()).unwrap();
        let first_manager = first.structured_session_manager();
        let second_manager = second.structured_session_manager();
        assert!(first_manager.live_ownership_enabled());
        assert!(second_manager.live_ownership_enabled());
        assert!(first_manager.inner.delegation_supervisor.get().is_some());
        assert!(second_manager.inner.delegation_supervisor.get().is_none());
        let session = first_manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        assert!(second_manager
            .get_session("owner", &session.id)
            .await
            .is_err());
        first_manager.shutdown().await.unwrap();
        drop(first_manager);
        drop(first);
        assert!(second_manager
            .get_session("owner", &session.id)
            .await
            .unwrap()
            .is_some());
        drop(second_manager);
        drop(second);
        let third = AppState::new_runtime(config).unwrap();
        let third_manager = third.structured_session_manager();
        assert!(third_manager.inner.delegation_supervisor.get().is_some());
        assert!(third_manager
            .get_session("owner", &session.id)
            .await
            .is_err());
        let super::super::live_ownership::OwnerState::Unconfirmed { epoch } =
            third_manager.live_owner_status("owner").unwrap()
        else {
            panic!("unclean shutdown must require review");
        };
        super::super::live_ownership::ManagerLeases::new(data.path())
            .unwrap()
            .reconcile_unknown("owner", epoch, Uuid::new_v4(), true)
            .unwrap();
        assert!(third_manager
            .get_session("owner", &session.id)
            .await
            .unwrap()
            .is_some());
        third_manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn missing_delegation_ledger_does_not_block_sessions_or_recreate_it() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let first = AppState::new_runtime(config.clone()).unwrap();
        first.structured_session_manager().shutdown().await.unwrap();
        drop(first);
        let database = data.path().join("delegation-outbox/outbox.sqlite3");
        std::fs::remove_file(&database).unwrap();
        let reopened = AppState::new_runtime(config).unwrap();
        let manager = reopened.structured_session_manager();
        assert!(manager.inner.delegation_supervisor.get().is_none());
        assert!(!database.exists());
        assert!(manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None
            )
            .await
            .is_ok());
        manager.shutdown().await.unwrap();
        assert!(!database.exists());
    }

    #[tokio::test]
    async fn unbound_manager_cannot_inspect_or_clear_an_ownership_hold() {
        let data = tempfile::tempdir().unwrap();
        let secret = "unbound-ownership-fixture";
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: secret.into(),
            ..Default::default()
        })
        .unwrap();
        let leases = super::super::live_ownership::ManagerLeases::new(data.path()).unwrap();
        drop(leases.acquire("alice").unwrap());
        let super::super::live_ownership::OwnerState::Unconfirmed { epoch } =
            leases.inspect("alice").unwrap()
        else {
            panic!("expected unconfirmed state");
        };
        let router = crate::app(state);
        let token = crate::auth::issue_access_token(secret, "alice", "alice");
        let inspect = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/ownership")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(inspect.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            inspect.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let review = router.oneshot(Request::builder().method("POST")
            .uri("/api/structured/ownership/reconcile").header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({"epoch":epoch,"operationId":Uuid::new_v4(),"acknowledged":true}).to_string())).unwrap()).await.unwrap();
        assert_eq!(review.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            review.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert_eq!(
            leases.inspect("alice").unwrap(),
            super::super::live_ownership::OwnerState::Unconfirmed { epoch }
        );
    }

    #[tokio::test]
    async fn ownership_review_is_owner_and_epoch_bound_and_needs_acknowledgment() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        state
            .structured_session_manager()
            .bind_live_ownership()
            .unwrap();
        let leases = super::super::live_ownership::ManagerLeases::new(data.path()).unwrap();
        let alice = leases.acquire("alice").unwrap();
        let app = |id: &str| {
            routes()
                .layer(Extension(AuthenticatedUser {
                    user_id: id.into(),
                    username: id.into(),
                }))
                .with_state(state.clone())
        };
        let get = || {
            Request::builder()
                .uri("/api/structured/ownership")
                .body(Body::empty())
                .unwrap()
        };
        let anonymous = routes()
            .with_state(state.clone())
            .oneshot(get())
            .await
            .unwrap();
        assert_ne!(anonymous.status(), StatusCode::OK);
        let busy = app("alice").oneshot(get()).await.unwrap();
        assert_eq!(
            busy.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&busy.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(value, serde_json::json!({"state":"busy"}));
        drop(alice);
        let unknown = app("alice").oneshot(get()).await.unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&unknown.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["state"], "unconfirmed");
        let epoch = value["epoch"].as_str().unwrap();
        let operation = Uuid::new_v4();
        let post = |id: &str, ack| {
            Request::builder()
                .method("POST")
                .uri("/api/structured/ownership/reconcile")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"epoch":id,"operationId":operation,"acknowledged":ack})
                        .to_string(),
                ))
                .unwrap()
        };
        assert_eq!(
            app("alice")
                .oneshot(post(epoch, false))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            app("alice")
                .oneshot(post(&Uuid::new_v4().to_string(), true))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_ne!(
            app("bob")
                .oneshot(post(epoch, true))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app("alice")
                .oneshot(post(epoch, true))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app("alice")
                .oneshot(post(epoch, true))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let clean = app("alice").oneshot(get()).await.unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&clean.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(value, serde_json::json!({"state":"clean"}));
    }

    #[tokio::test]
    async fn the_current_manager_does_not_report_its_own_lease_as_busy() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let manager = state.structured_session_manager();
        if let Err(error) = manager.bind_live_ownership() {
            assert_eq!(error, "Session ownership is already bound");
        }
        manager.list_sessions("alice").await.unwrap();
        let app = routes()
            .layer(Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }))
            .with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/structured/ownership")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value, serde_json::json!({"state":"owned"}));
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn app_routes_require_auth_and_never_allow_a_foreign_owner_review() {
        let data = tempfile::tempdir().unwrap();
        let secret = "ownership-review-fixture-secret";
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: secret.into(),
            ..Default::default()
        })
        .unwrap();
        state
            .structured_session_manager()
            .bind_live_ownership()
            .unwrap();
        let leases = super::super::live_ownership::ManagerLeases::new(data.path()).unwrap();
        drop(leases.acquire("alice").unwrap());
        let app = crate::app(state);
        let token = crate::auth::issue_access_token(secret, "alice", "alice");
        let other = crate::auth::issue_access_token(secret, "bob", "bob");
        let get = |auth: Option<&str>| {
            let mut builder = Request::builder().uri("/api/structured/ownership");
            if let Some(token) = auth {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            builder.body(Body::empty()).unwrap()
        };
        let no_auth = app.clone().oneshot(get(None)).await.unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            no_auth.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let inspected = app.clone().oneshot(get(Some(&token))).await.unwrap();
        assert_eq!(inspected.status(), StatusCode::OK);
        let value: serde_json::Value =
            serde_json::from_slice(&inspected.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let epoch = value["epoch"].as_str().unwrap();
        let operation = Uuid::new_v4();
        let post = |auth: &str, epoch: &str| {
            Request::builder()
                .method("POST")
                .uri("/api/structured/ownership/reconcile")
                .header("authorization", format!("Bearer {auth}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"epoch":epoch,"operationId":operation,"acknowledged":true})
                        .to_string(),
                ))
                .unwrap()
        };
        let foreign = app.clone().oneshot(post(&other, epoch)).await.unwrap();
        assert_eq!(foreign.status(), StatusCode::CONFLICT);
        assert_eq!(
            foreign.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let reviewed = app.oneshot(post(&token, epoch)).await.unwrap();
        assert_eq!(reviewed.status(), StatusCode::NO_CONTENT);
    }
}
