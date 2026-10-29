#[cfg(unix)]
#[test]
fn rebuild_route_honors_script_configuration_without_restarting_a_service() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("configured build.sh");
    std::fs::write(
        &script,
        "printf '%s' \"$REBUILD_PROJECT_ROOT\"; printf 'synthetic build failure' >&2; exit 7",
    )
    .unwrap();
    for allowed in [true, false] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "rebuild_route_tests::configured_rebuild_route_helper",
                "--ignored",
                "--nocapture",
            ])
            .env("REBUILD_PROJECT_ROOT", root.path())
            .env("REBUILD_SCRIPT_PATH", &script)
            .env("TERMINAL_V4_REBUILD_TEST_CHILD", "1")
            .env_remove("TERMINAL_V4_ALLOW_REBUILD");
        if allowed {
            child.env("TERMINAL_V4_ALLOW_REBUILD", "1");
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "allowed={allowed}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "isolated configuration helper invoked by the parent regression"]
async fn configured_rebuild_route_helper() {
    if std::env::var("TERMINAL_V4_REBUILD_TEST_CHILD").as_deref() != Ok("1") {
        return;
    }
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let data = tempfile::tempdir().unwrap();
    let state = crate::ApiState::new_with_external_auth(
        terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-rebuild-route-secret".into(),
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let token = crate::auth::issue_access_token(
        &state.config().jwt_secret,
        "rebuild-synthetic-owner",
        "owner",
    );
    let router = crate::app(state);
    let denied = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/system/rebuild")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let allowed = std::env::var("TERMINAL_V4_ALLOW_REBUILD").as_deref() == Ok("1");
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/system/rebuild")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    if !allowed {
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        return;
    }
    assert_eq!(response.status(), StatusCode::OK);
    let result: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let expected_root = std::path::PathBuf::from(std::env::var_os("REBUILD_PROJECT_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(
        result,
        serde_json::json!({ "success": false, "stdout": expected_root.to_str().unwrap(), "stderr": "synthetic build failure" })
    );
}
