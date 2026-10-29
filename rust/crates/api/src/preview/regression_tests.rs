use crate::{app, auth::issue_access_token, ApiState};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use serde_json::{json, Value};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

fn harness() -> (tempfile::TempDir, ApiState, String) {
    let data = tempfile::tempdir().unwrap();
    let state = ApiState::new_with_external_auth(
        AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "preview-regression-secret".into(),
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let token = issue_access_token(
        &state.config().jwt_secret,
        "preview-regression-owner",
        "owner",
    );
    (data, state, token)
}

async fn response_text(response: axum::response::Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn fetched_javascript_rewrites_static_dynamic_and_export_imports() {
    let (_data, state, token) = harness();
    let upstream = Router::new().route("/src/main.js", get(|| async { ([("content-type", "text/javascript")], "import { value } from '/node_modules/dep.js'; import '/src/side.js'; export { value } from '/src/other.js'; import('/src/lazy.js');") }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let response = app(state)
        .oneshot(
            Request::builder()
                .uri(format!("/preview/{port}/src/main.js"))
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let script = response_text(response).await;
    server.abort();
    assert_eq!(
        script,
        format!(
            "import {{ value }} from '/preview/{port}/node_modules/dep.js'; import '/preview/{port}/src/side.js'; export {{ value }} from '/preview/{port}/src/other.js'; import('/preview/{port}/src/lazy.js');"
        )
    );
}

#[tokio::test]
async fn static_query_preview_rewrites_nested_assets_with_auth_and_keeps_scope() {
    let (_data, state, token) = harness();
    let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let fixture = tempfile::Builder::new()
        .prefix("preview-regression-")
        .tempdir_in(project_root)
        .unwrap();
    std::fs::create_dir_all(fixture.path().join("pages/css")).unwrap();
    std::fs::create_dir_all(fixture.path().join("images")).unwrap();
    std::fs::write(fixture.path().join("pages/index.html"), "<link href='css/site.css'><script type='module' src='../main.js'></script><img src='../images/logo.svg'><a href='https://example.test'>external</a><img src='../images/logo%20+%C3%A9.svg'><img src='../images/a&amp;b.svg'><img src=../images/unquoted.svg><img srcset='../images/one.svg 1x, ../images/two.svg 2x'><div style=\"background:url('../images/inline.svg')\"></div>").unwrap();
    std::fs::write(
        fixture.path().join("pages/css/site.css"),
        "@import './theme.css'; body { background: url('../../images/logo.svg'); }",
    )
    .unwrap();
    std::fs::write(fixture.path().join("main.js"), "import './dep.js';").unwrap();
    for file in [
        "images/a&b.svg",
        "images/logo +é.svg",
        "images/unquoted.svg",
        "images/one.svg",
        "images/two.svg",
        "images/inline.svg",
    ] {
        std::fs::write(fixture.path().join(file), "<svg/>").unwrap();
    }
    let router = app(state);
    let uri = |file: &str| {
        format!(
            "/api/preview?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("path", fixture.path().to_str().unwrap())
                .append_pair("file", file)
                .append_pair("token", &token)
                .finish()
        )
    };
    let html_response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri("pages/index.html"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(html_response.status(), StatusCode::OK);
    let html = response_text(html_response).await;
    assert!(
        !html.contains(&token),
        "access token must not be copied into static assets"
    );
    let emitted = html
        .split("href='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap()
        .replace("&amp;", "&");
    let parsed = url::Url::parse("http://localhost")
        .unwrap()
        .join(&emitted)
        .unwrap();
    let resource = parsed
        .query_pairs()
        .find(|(key, _)| key == "previewToken")
        .unwrap()
        .1
        .into_owned();
    let uri = |file: &str| {
        format!(
            "/api/preview?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("path", fixture.path().to_str().unwrap())
                .append_pair("file", file)
                .append_pair("previewToken", &resource)
                .finish()
        )
    };

    assert!(
        html.contains(&uri("pages/css/site.css").replace('&', "&amp;")),
        "{html}"
    );
    assert!(html.contains(&uri("main.js").replace('&', "&amp;")));
    assert!(html.contains("href='https://example.test'"));
    for file in [
        "images/a&b.svg",
        "images/logo +é.svg",
        "images/unquoted.svg",
        "images/one.svg",
        "images/two.svg",
        "images/inline.svg",
    ] {
        assert!(
            html.contains(&uri(file).replace('&', "&amp;")),
            "missing {file}: {html}"
        );
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri(file))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_text(response).await, "<svg/>");
    }
    let css = response_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri("pages/css/site.css"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(css.contains(&uri("images/logo.svg")), "{css}");
    assert!(css.contains(&uri("pages/css/theme.css")));
    let script = response_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri("main.js"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(script.contains(&uri("dep.js")), "{script}");
    let rejected = router
        .oneshot(
            Request::builder()
                .uri(uri("../outside.txt"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cookie_storage_operations_update_only_the_owner_port_jar() {
    let (_data, state, token) = harness();
    state
        .cookie_store()
        .store_from_set_cookie("other-owner", 5173, "session=other")
        .await;
    state
        .cookie_store()
        .store_from_set_cookie("preview-regression-owner", 5174, "session=other-port")
        .await;
    let router = app(state.clone());
    for body in [
        json!({"type":"cookies","operation":"set","key":"session","value":"new"}),
        json!({"type":"cookies","operation":"import","entries":{"theme":"dark"}}),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/5173/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let cookies = state
        .cookie_store()
        .list_cookies("preview-regression-owner", 5173)
        .await;
    assert_eq!(
        cookies
            .iter()
            .map(|cookie| (&*cookie.name, &*cookie.value))
            .collect::<Vec<_>>(),
        vec![("session", "new"), ("theme", "dark")]
    );
    for body in [
        json!({"type":"cookies","operation":"remove","key":"session"}),
        json!({"type":"cookies","operation":"clear"}),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/preview/5173/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(payload["success"], true);
    }
    assert!(state
        .cookie_store()
        .list_cookies("preview-regression-owner", 5173)
        .await
        .is_empty());
    assert_eq!(
        state
            .cookie_store()
            .get_cookie_header("other-owner", 5173)
            .await
            .as_deref(),
        Some("session=other")
    );
    assert_eq!(
        state
            .cookie_store()
            .get_cookie_header("preview-regression-owner", 5174)
            .await
            .as_deref(),
        Some("session=other-port")
    );
}

#[tokio::test]
async fn static_preview_paths_preserve_literal_url_characters_and_directory_index() {
    let (_data, state, token) = harness();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let fixture = tempfile::Builder::new()
        .prefix("preview-path-")
        .tempdir_in(root)
        .unwrap();
    std::fs::create_dir_all(fixture.path().join("pages#1%20+é")).unwrap();
    std::fs::write(
        fixture.path().join("pages#1%20+é/index.html"),
        "<img src='logo.svg'>",
    )
    .unwrap();
    std::fs::write(fixture.path().join("pages#1%20+é/logo.svg"), "<svg/>").unwrap();
    let router = app(state);
    let uri = |file: &str| {
        format!(
            "/api/preview?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("path", fixture.path().to_str().unwrap())
                .append_pair("file", file)
                .append_pair("token", &token)
                .finish()
        )
    };
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri("pages#1%20+é"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let html = response_text(response).await;
    let asset = html
        .split("src='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap()
        .replace("&amp;", "&");
    let parsed = url::Url::parse("http://localhost")
        .unwrap()
        .join(&asset)
        .unwrap();
    let resource = parsed
        .query_pairs()
        .find(|(key, _)| key == "previewToken")
        .unwrap()
        .1
        .into_owned();
    let expected = format!(
        "/api/preview?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", fixture.path().to_str().unwrap())
            .append_pair("file", "pages#1%20+é/logo.svg")
            .append_pair("previewToken", &resource)
            .finish()
    );
    assert_eq!(asset, expected);
    let response = router
        .oneshot(Request::builder().uri(asset).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_text(response).await, "<svg/>");
}

#[tokio::test]
async fn invalid_cookie_import_is_rejected_before_any_jar_mutation() {
    let (_data, state, token) = harness();
    let response = app(state.clone()).oneshot(Request::builder().method("POST").uri("/api/preview/5173/storage").header("Authorization", format!("Bearer {token}")).header("content-type", "application/json").body(Body::from(json!({"type":"cookies", "operation":"import", "entries":{"theme":"dark", "injected":"safe;other=bad"}}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(state
        .cookie_store()
        .list_cookies("preview-regression-owner", 5173)
        .await
        .is_empty());
}

#[tokio::test]
#[ignore = "requires a Playwright Chromium installation and SCREENSHOT_DIR set to a scratch directory"]
async fn element_screenshot_api_captures_the_selected_local_fixture() {
    let output_dir = std::env::var("SCREENSHOT_DIR")
        .expect("Set SCREENSHOT_DIR to a scratch directory before running this test");
    assert!(
        std::path::Path::new(&output_dir).starts_with(std::env::temp_dir())
            || std::path::Path::new(&output_dir).starts_with("/private/tmp")
    );
    let (_data, state, token) = harness();
    let upstream = Router::new().route("/", get(|| async { axum::response::Html("<style>body{margin:0}#target{width:200px;height:80px;background:red}</style><div id='target'></div>") }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let response = app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/preview/{port}/screenshot/element"))
                .header("Authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"selector":"#target", "width":640, "height":480}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response_text(response).await;
    server.abort();
    assert_eq!(status, StatusCode::OK, "{body}");
    let payload: Value = serde_json::from_str(&body).unwrap();
    let screenshot = std::path::Path::new(payload["path"].as_str().unwrap());
    assert!(screenshot.starts_with(output_dir));
    let png = std::fs::read(screenshot).unwrap();
    std::fs::remove_file(screenshot).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        (
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            u32::from_be_bytes(png[20..24].try_into().unwrap())
        ),
        (200, 80)
    );
}

#[tokio::test]
async fn cookie_forwarding_uses_request_path_and_preserves_duplicate_names() {
    let (_data, state, token) = harness();
    let upstream = Router::new().fallback(
        |uri: axum::http::Uri, headers: axum::http::HeaderMap| async move {
            let mut response = axum::http::Response::new(Body::from(
                headers
                    .get("cookie")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_owned(),
            ));
            let cookies: &[&str] = match uri.path() {
                "/set" => &[
                    "session=root; Path=/",
                    "session=admin; Path=/admin",
                    "admin=restricted; Path=/admin",
                ],
                "/admin/login" => &["default=scoped"],
                "/delete" => &["session=gone; Path=/admin; Max-Age=0"],
                _ => &[],
            };
            for cookie in cookies {
                response
                    .headers_mut()
                    .append("set-cookie", cookie.parse().unwrap());
            }
            response
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let router = app(state);
    for (path, expected) in [
        ("/set", ""),
        (
            "/admin/login",
            "session=admin; admin=restricted; session=root",
        ),
        ("/public", "session=root"),
        ("/administrator", "session=root"),
        (
            "/admin/child",
            "session=admin; admin=restricted; default=scoped; session=root",
        ),
        ("/delete", "session=root"),
        (
            "/admin/child",
            "admin=restricted; default=scoped; session=root",
        ),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/preview/{port}{path}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Cookie", "other-owner=must-not-forward")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("set-cookie").is_none());
        assert_eq!(response_text(response).await, expected, "{path}");
    }
    server.abort();
}

#[tokio::test]
async fn both_websocket_routes_negotiate_upstream_selection_before_upgrade() {
    use axum::extract::ws::WebSocketUpgrade;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, Message},
    };
    let (_data, state, token) = harness();
    let upstream = Router::new()
        .route(
            "/hmr",
            get(
                |ws: WebSocketUpgrade, headers: axum::http::HeaderMap| async move {
                    assert!(headers.get("authorization").is_none());
                    assert_eq!(headers["cookie"], "session=root");
                    ws.protocols(["fixture.v1"])
                        .on_upgrade(|mut socket| async move {
                            while let Some(Ok(message)) = socket.recv().await {
                                if matches!(message, axum::extract::ws::Message::Close(_)) {
                                    break;
                                }
                                if socket.send(message).await.is_err() {
                                    break;
                                }
                            }
                        })
                },
            ),
        )
        .route("/reject", get(|| async { StatusCode::BAD_REQUEST }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    state
        .cookie_store()
        .store_from_set_cookie("preview-regression-owner", port, "session=root; Path=/")
        .await;
    state
        .cookie_store()
        .store_from_set_cookie(
            "preview-regression-owner",
            port,
            "session=admin; Path=/admin",
        )
        .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app(state);
    let api_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    for route in [
        format!("/preview/{port}"),
        format!("/api/dev-proxy-ws/{port}"),
    ] {
        for offered in [None, Some("fixture.other, fixture.v1")] {
            let mut request = format!("ws://{address}{route}/hmr?fixture=preserved")
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
            request
                .headers_mut()
                .insert("cookie", "other-owner=must-not-forward".parse().unwrap());
            if let Some(offered) = offered {
                request
                    .headers_mut()
                    .insert("sec-websocket-protocol", offered.parse().unwrap());
            }
            let (mut socket, response) =
                tokio::time::timeout(std::time::Duration::from_secs(3), connect_async(request))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(
                response
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok()),
                offered.map(|_| "fixture.v1")
            );
            socket.send(Message::Text("echo".into())).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Text("echo".into())
            );
            let _ = socket.close(None).await;
        }
        let mut request = format!("ws://{address}{route}/reject")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        match connect_async(request).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::BAD_GATEWAY)
            }
            _ => panic!("failed upstream must reject before client101"),
        }
    }
    api_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn proxy_sse_retains_completion_order_for_late_requests() {
    use futures_util::StreamExt;
    let (_data, state, token) = harness();
    let port = 5173;
    let input = |timestamp, url: &str| super::request_logs::ProxyLogInput {
        timestamp,
        method: "GET".into(),
        url: url.into(),
        status: Some(200),
        status_text: None,
        duration: 10,
        request_size: None,
        response_size: None,
        content_type: None,
        error: None,
    };
    state
        .request_log_store()
        .add_log("preview-regression-owner", port, input(20, "fast"))
        .await;
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/api/preview/{port}/log-stream?types=proxy"))
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let first = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let parse = |bytes: &[u8]| -> Value {
        let text = std::str::from_utf8(bytes).unwrap();
        serde_json::from_str(
            text.lines()
                .find_map(|line| {
                    line.strip_prefix("data: ")
                        .or_else(|| line.strip_prefix("data:"))
                })
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(parse(&first)["url"], "fast");
    state
        .request_log_store()
        .add_log("preview-regression-owner", port, input(10, "slow"))
        .await;
    state
        .request_log_store()
        .add_log(
            "preview-regression-owner",
            port,
            input(5, "even-earlier-start"),
        )
        .await;
    let mut delivered = Vec::new();
    for _ in 0..2 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let entry = parse(&frame);
        delivered.push((
            entry["url"].as_str().unwrap().to_owned(),
            entry["timestamp"].as_i64().unwrap(),
        ));
    }
    assert_eq!(
        delivered,
        vec![("slow".into(), 10), ("even-earlier-start".into(), 5)]
    );
}

#[tokio::test]
async fn proxy_sse_resumes_late_completion_over_real_http_after_disconnect() {
    let (_data, state, token) = harness();
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let upstream = Router::new()
        .route(
            "/slow",
            get({
                let started = started.clone();
                let release = release.clone();
                move || {
                    let started = started.clone();
                    let release = release.clone();
                    async move {
                        started.notify_one();
                        release.notified().await;
                        "slow"
                    }
                }
            }),
        )
        .route("/fast", get(|| async { "fast" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let api_task = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap();
    let origin = format!("http://{address}");
    let slow = {
        let client = client.clone();
        let origin = origin.clone();
        let token = token.clone();
        tokio::spawn(async move {
            client
                .get(format!("{origin}/preview/{port}/slow"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    assert_eq!(
        client
            .get(format!("{origin}/preview/{port}/fast"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "fast"
    );
    let stream_url = format!("{origin}/api/preview/{port}/log-stream?types=proxy");
    let response = client
        .get(&stream_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    async fn next_event(response: &mut reqwest::Response) -> (String, Value) {
        let mut frame = String::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .unwrap()
                .expect("SSE closed before event");
            frame.push_str(std::str::from_utf8(&chunk).unwrap());
            assert!(frame.len() <= 8192);
            if frame.contains("\n\n") {
                break;
            }
        }
        let id = frame
            .lines()
            .find_map(|line| {
                line.strip_prefix("id: ")
                    .or_else(|| line.strip_prefix("id:"))
            })
            .unwrap()
            .to_owned();
        let data = frame
            .lines()
            .find_map(|line| {
                line.strip_prefix("data: ")
                    .or_else(|| line.strip_prefix("data:"))
            })
            .unwrap();
        (id, serde_json::from_str(data).unwrap())
    }
    let mut response = response;
    let (cursor, fast) =
        tokio::time::timeout(std::time::Duration::from_secs(3), next_event(&mut response))
            .await
            .unwrap();
    assert_eq!(fast["url"], format!("http://localhost:{port}/fast"));
    assert_eq!(fast["id"], cursor);
    drop(response);
    let resumed = {
        let client = client.clone();
        let token = token.clone();
        let url = format!(
            "{stream_url}&since={}&proxyAfter={cursor}",
            fast["timestamp"]
        );
        tokio::spawn(async move { client.get(url).bearer_auth(token).send().await.unwrap() })
    };
    release.notify_one();
    assert_eq!(slow.await.unwrap(), "slow");
    let response = resumed.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut response = response;
    let (next, late) =
        tokio::time::timeout(std::time::Duration::from_secs(3), next_event(&mut response))
            .await
            .unwrap();
    assert_eq!(late["url"], format!("http://localhost:{port}/slow"));
    assert_ne!(next, cursor);
    assert!(late["timestamp"].as_i64().unwrap() < fast["timestamp"].as_i64().unwrap());
    drop(response);
    let response = client
        .get(&stream_url)
        .header("last-event-id", cursor)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    let mut response = response;
    let (_, replayed) =
        tokio::time::timeout(std::time::Duration::from_secs(3), next_event(&mut response))
            .await
            .unwrap();
    assert_eq!(replayed["url"], format!("http://localhost:{port}/slow"));
    drop(response);
    assert_eq!(
        client
            .get(format!("{stream_url}&proxyAfter=malformed"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    api_task.abort();
    upstream_task.abort();
}
