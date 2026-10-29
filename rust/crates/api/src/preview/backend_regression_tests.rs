use crate::{app, auth::issue_access_token, ApiState};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

fn harness() -> (tempfile::TempDir, ApiState, String, String) {
    let data = tempfile::tempdir().unwrap();
    let state = ApiState::new_with_external_auth(
        AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-preview-repair-secret".into(),
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let token = |owner| issue_access_token(&state.config().jwt_secret, owner, owner);
    let a = token("preview-owner-a");
    let b = token("preview-owner-b");
    (data, state, a, b)
}

async fn api(
    router: Router,
    method: &str,
    path: &str,
    token: &str,
    value: Value,
) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn console_and_external_logs_isolate_ingest_read_clear_and_discovery() {
    let (_data, state, a, b) = harness();
    let router = app(state);
    for path in ["/api/preview/5173/logs", "/api/preview/external/logs"] {
        let entry = json!([{"id":"a","type":"console","level":"log","message":"synthetic-owner-a","timestamp":123}]);
        let (status, _) = api(router.clone(), "POST", path, &a, entry).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(
            api(router.clone(), "GET", path, &b, Value::Null).await.1,
            json!({"logs":[]})
        );
        assert_eq!(
            api(router.clone(), "DELETE", path, &b, Value::Null).await.0,
            StatusCode::NO_CONTENT
        );
        let (_, body) = api(router.clone(), "GET", path, &a, Value::Null).await;
        assert_eq!(body["logs"][0]["message"], "synthetic-owner-a");
        assert_eq!(
            api(router.clone(), "DELETE", path, &a, Value::Null).await.0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            api(router.clone(), "GET", path, &a, Value::Null).await.1,
            json!({"logs":[]})
        );
    }
}

#[tokio::test]
async fn websocket_inspection_collects_real_proxy_frames_and_enforces_owner_actions() {
    let (_data, state, a, b) = harness();
    let upstream = Router::new().route(
        "/hmr",
        get(|ws: axum::extract::WebSocketUpgrade| async {
            ws.on_upgrade(|mut socket| async move {
                while let Some(Ok(message)) = socket.recv().await {
                    if matches!(message, axum::extract::ws::Message::Close(_)) {
                        break;
                    }
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
            })
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let preview_cookie = format!(
        "terminal_preview_token={}",
        crate::auth::issue_preview_token(
            &state.config().jwt_secret,
            "preview-owner-a",
            "preview-owner-a"
        )
    );
    let router = app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_port = listener.local_addr().unwrap().port();
    let router_clone = router.clone();
    let api_task = tokio::spawn(async move { axum::serve(listener, router_clone).await.unwrap() });
    let path = format!("/api/preview/{port}/websockets");
    for prefix in [
        format!("/api/dev-proxy-ws/{port}"),
        format!("/preview/{port}"),
    ] {
        let url =
            format!("ws://127.0.0.1:{api_port}{prefix}/hmr?token={a}&credential=must-not-retain");
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request().unwrap();
        if prefix.starts_with("/preview/") {
            request
                .headers_mut()
                .insert(axum::http::header::COOKIE, preview_cookie.parse().unwrap());
        }
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                "synthetic-frame".into(),
            ))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echoed.into_text().unwrap(), "synthetic-frame");
        let (status, body) = api(router.clone(), "GET", &path, &a, Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["connections"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["connections"][0]["url"],
            format!("ws://localhost:{port}/hmr")
        );
        assert!(!body.to_string().contains("must-not-retain"));
        assert!(!body.to_string().contains(&a));
        assert_eq!(
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| (
                    message["direction"].as_str().unwrap(),
                    message["data"].as_str().unwrap()
                ))
                .collect::<Vec<_>>(),
            vec![("sent", "synthetic-frame"), ("received", "synthetic-frame")]
        );
        assert_eq!(
            api(router.clone(), "GET", &path, &b, Value::Null).await.1,
            json!({"connections":[],"messages":[]})
        );
        assert_eq!(
            api(router.clone(), "DELETE", &path, &b, Value::Null)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let id = body["connections"][0]["id"].as_str().unwrap();
        let filter = format!("{path}?connectionId={id}&direction=sent");
        assert_eq!(
            api(router.clone(), "GET", &filter, &a, Value::Null).await.1["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            api(
                router.clone(),
                "GET",
                &format!("{path}?direction=bad"),
                &a,
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            api(router.clone(), "DELETE", &path, &a, Value::Null)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                "after-clear".into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
            "after-clear"
        );
        let (_, after_clear) = api(router.clone(), "GET", &path, &a, Value::Null).await;
        assert_eq!(
            after_clear["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["data"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["after-clear", "after-clear"]
        );
        let _ = socket.close(None).await;
        for _ in 0..100 {
            let (_, body) = api(router.clone(), "GET", &path, &a, Value::Null).await;
            if body["connections"][0]["status"] == "closed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        assert_eq!(
            api(router.clone(), "DELETE", &path, &a, Value::Null)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            api(router.clone(), "GET", &path, &a, Value::Null).await.1,
            json!({"connections":[],"messages":[]})
        );
    }
    api_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn external_dependency_tickets_keep_owner_expiry_exact_url_and_read_only_scope() {
    let (_data, state, a, _b) = harness();
    let root = super::auth_urls::resource_token_for_root(
        &state,
        &a,
        "/api/proxy-external",
        Some("https://fixture.test/page.html"),
    )
    .unwrap();
    let child =
        super::auth_urls::external_dependency_token(&state, &root, "https://cdn.test/main.js")
            .unwrap();
    let owner =
        super::auth_urls::authenticate_resource_token(&state, &child, "GET", "/api/proxy-external")
            .unwrap();
    assert_eq!(owner.user_id, "preview-owner-a");
    assert_eq!(
        super::auth_urls::expires_at(&state, &child),
        super::auth_urls::expires_at(&state, &root)
    );
    assert!(super::auth_urls::resource_root_allowed(
        &state,
        &child,
        "https://cdn.test/main.js"
    ));
    assert!(!super::auth_urls::resource_root_allowed(
        &state,
        &child,
        "https://cdn.test/other.js"
    ));
    assert!(super::auth_urls::authenticate_resource_token(
        &state,
        &child,
        "POST",
        "/api/proxy-external"
    )
    .is_err());
    assert!(
        super::auth_urls::authenticate_resource_token(&state, &child, "GET", "/api/settings")
            .is_err()
    );
    assert!(super::auth_urls::external_dependency_token(
        &state,
        &child,
        "http://127.0.0.1/private"
    )
    .is_none());
    let path_ticket = super::auth_urls::resource_token(&state, &a, "/preview/5173").unwrap();
    assert!(super::auth_urls::external_dependency_token(
        &state,
        &path_ticket,
        "https://cdn.test/main.js"
    )
    .is_none());
    let router = app(state.clone());
    assert_eq!(
        api(
            router,
            "GET",
            "/api/proxy-external?url=https%3A%2F%2Fcdn.test%2Fother.js",
            &child,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut depth = root;
    for _ in 0..16 {
        depth =
            super::auth_urls::external_dependency_token(&state, &depth, "https://cdn.test/main.js")
                .unwrap();
    }
    assert!(super::auth_urls::external_dependency_token(
        &state,
        &depth,
        "https://cdn.test/main.js"
    )
    .is_none());
}
