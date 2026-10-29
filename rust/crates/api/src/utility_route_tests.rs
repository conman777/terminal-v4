use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn state_at(path: &std::path::Path) -> AppState {
    AppState::new(terminal_v4_core::AppConfig {
        data_dir: path.into(),
        ..Default::default()
    })
    .unwrap()
}

async fn request(state: &AppState, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let token =
        auth::issue_access_token(&state.config().jwt_secret, "utility-fixture", "synthetic");
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn utility_routes_preserve_deleted_seed_and_report_corrupt_notes_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let (status, bookmarks) = request(&state, "GET", "/api/bookmarks", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let id = bookmarks["bookmarks"][0]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &state,
            "DELETE",
            &format!("/api/bookmarks/{id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    drop(state);
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/bookmarks", Value::Null).await,
        (StatusCode::OK, json!({"bookmarks":[]}))
    );
    let path = data.path().join("users/utility-fixture/notes.json");
    let original = br#"[{"content":"synthetic recovery marker""#;
    std::fs::write(&path, original).unwrap();
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/notes",
            json!({"title":"fresh", "content":"new", "category":"test"})
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn utility_vault_routes_migrate_previous_ciphertext_without_losing_values_on_restart() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    let previous = vault::encrypt_secret(
        "synthetic prior secret",
        "dev-vault-key-change-in-production",
    )
    .unwrap()
    .replacen("enc:v2:", "enc:v1:", 1);
    state
        .add_vault_key(&user, "previous", "old", &previous, "2020-01-01")
        .unwrap();
    let (status, revealed) =
        request(&state, "GET", "/api/vault/previous/reveal", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{revealed}");
    assert_eq!(revealed["keyValue"], "synthetic prior secret");
    let migrated = state
        .get_vault_key(&user, "previous")
        .unwrap()
        .unwrap()
        .key_value;
    assert!(migrated.starts_with("enc:v2:"));
    assert!(vault::decrypt_secret(&migrated, "dev-vault-key-change-in-production").is_err());
    let (status, created) = request(
        &state,
        "POST",
        "/api/vault",
        json!({"keyName":"new", "keyValue":"synthetic new secret"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    drop(state);
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/vault/previous/reveal", Value::Null)
            .await
            .1["keyValue"],
        "synthetic prior secret"
    );
    assert_eq!(
        request(
            &state,
            "GET",
            &format!("/api/vault/{id}/reveal"),
            Value::Null
        )
        .await
        .1["keyValue"],
        "synthetic new secret"
    );
    let damaged = "enc:v1:00:00";
    state
        .add_vault_key(&user, "damaged", "damaged", damaged, "2020-01-02")
        .unwrap();
    assert_eq!(
        request(&state, "GET", "/api/vault/damaged/reveal", Value::Null)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        state
            .get_vault_key(&user, "damaged")
            .unwrap()
            .unwrap()
            .key_value,
        damaged
    );
    assert_eq!(
        request(&state, "GET", "/api/vault", Value::Null).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[tokio::test]
async fn utility_runtime_services_start_and_stop_stats_collection_in_data_root() {
    let data = tempfile::tempdir().unwrap();
    let state = state_at(data.path());
    start_services(&state);
    start_services(&state);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while state.stats_collector().get_history("1h").await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    shutdown_services(&state).await;
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert!(data.path().join("stats-history.json").is_file());
    drop(state);
    assert_eq!(
        state_at(data.path())
            .stats_collector()
            .get_history("1h")
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn stats_recovery_api_starts_preserves_corrupt_bytes_and_serves_stats_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("stats-history.json");
    let quarantine = data.path().join("stats-history.corrupt.json");
    let original = b"\xff synthetic corrupt monitoring history";
    std::fs::write(&path, original).unwrap();
    let state = state_at(data.path());
    assert_eq!(std::fs::read(&quarantine).unwrap(), original);
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "GET", "/api/system/stats", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["historyPersistenceEnabled"], true);
    assert!(body["historyError"].as_str().unwrap().contains("preserved"));
    state.stats_collector().record_snapshot().await.unwrap();
    drop(state);
    let state = state_at(data.path());
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert!(body.get("historyError").is_none());
    assert_eq!(std::fs::read(quarantine).unwrap(), original);
}

#[tokio::test]
async fn stats_recovery_api_reports_preservation_failure_without_overwriting_or_blocking_routes() {
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("stats-history.json");
    let quarantine = data.path().join("stats-history.corrupt.json");
    let original = b"synthetic currently corrupt history";
    let previous = b"synthetic previous recovery bytes";
    std::fs::write(&path, original).unwrap();
    std::fs::write(&quarantine, previous).unwrap();
    let state = state_at(data.path());
    assert_eq!(
        request(&state, "GET", "/api/notes", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, "GET", "/api/system/stats", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert!(state.stats_collector().record_snapshot().await.is_err());
    let (status, body) = request(&state, "GET", "/api/system/stats/history", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["historyPersistenceEnabled"], false);
    assert!(body["historyError"].as_str().unwrap().contains("disabled"));
    assert_eq!(body["history"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(std::fs::read(quarantine).unwrap(), previous);
}

#[test]
fn stats_recovery_does_not_hide_unrelated_database_startup_errors() {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir(data.path().join("terminal.db")).unwrap();
    let result = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.path().into(),
        ..Default::default()
    });
    assert!(result.is_err());
}
