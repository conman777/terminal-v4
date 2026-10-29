use axum::{
    extract::OriginalUri, http::HeaderMap, response::IntoResponse, routing::get, Extension, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use terminal_v4_core::AppConfig;

struct Host {
    state: crate::ApiState,
    _directory: tempfile::TempDir,
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn host() -> Host {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::ApiState::new_with_external_auth(
        AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = crate::app(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Host {
        state,
        _directory: directory,
        url,
        task,
    }
}
fn access(host: &Host, owner: &str) -> String {
    crate::auth::issue_access_token(&host.state.config().jwt_secret, owner, owner)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
async fn json_ok(response: reqwest::Response) -> Value {
    let status = response.status();
    let body = response.text().await.unwrap();
    assert!(status.is_success(), "{status}: {body}");
    serde_json::from_str(&body).unwrap()
}
async fn preview_cookie(client: &reqwest::Client, host: &Host, owner: &str) -> String {
    let response = client
        .post(format!("{}/api/preview/session", host.url))
        .bearer_auth(access(host, owner))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}
type Requests = Arc<Mutex<Vec<(String, HeaderMap)>>>;
struct Upstream {
    port: u16,
    requests: Requests,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn upstream() -> Upstream {
    async fn serve(
        OriginalUri(uri): OriginalUri,
        headers: HeaderMap,
        Extension(requests): Extension<Requests>,
    ) -> impl IntoResponse {
        requests.lock().unwrap().push((uri.to_string(), headers));
        if uri.path().ends_with(".js") {
            (
                [("content-type", "text/javascript")],
                "export const answer = 42;",
            )
        } else {
            ([("content-type", "text/html")], "<html><head><script type='module' src='/main.js?application=kept'></script></head><body></body></html>")
        }
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let router = Router::new()
        .fallback(get(serve))
        .layer(Extension(requests.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Upstream {
        port,
        requests,
        task,
    }
}
fn module_url(html: &str, host: &Host) -> url::Url {
    let pattern = regex_lite::Regex::new(r#"src=['\"]([^'\"]*main\.js[^'\"]*)['\"]"#).unwrap();
    let path = pattern
        .captures(html)
        .expect("fixture module must remain in returned HTML")[1]
        .replace("&amp;", "&");
    url::Url::parse(&host.url).unwrap().join(&path).unwrap()
}
fn resource_token(url: &url::Url) -> String {
    url.query_pairs()
        .find(|(key, _)| key == "previewToken")
        .expect("sandboxed module requires resource authorization")
        .1
        .into_owned()
}
fn assert_document_sandbox(response: &reqwest::Response) {
    let policy = response
        .headers()
        .get("content-security-policy")
        .and_then(|value| value.to_str().ok())
        .expect("untrusted preview documents require a response sandbox in new tabs");
    assert!(
        policy.split(';').any(|directive| {
            let mut parts = directive.split_whitespace();
            parts.next() == Some("sandbox") && !parts.any(|part| part == "allow-same-origin")
        }),
        "preview document retains app-origin storage authority: {policy}"
    );
}
fn expired_token(host: &Host, token: &str) -> String {
    let mut validation = jsonwebtoken::Validation::default();
    validation.validate_exp = false;
    let mut claims = jsonwebtoken::decode::<Value>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(host.state.config().jwt_secret.as_bytes()),
        &validation,
    )
    .unwrap()
    .claims;
    claims["exp"] = json!(time::OffsetDateTime::now_utc().unix_timestamp() - 600);
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(host.state.config().jwt_secret.as_bytes()),
    )
    .unwrap()
}

#[tokio::test]
async fn actual_http_gateway_grant_and_receiver_enforce_controller_origin_and_eval_opt_in() {
    const TEST: &str = "preview::resource_auth_tests::actual_http_gateway_grant_and_receiver_enforce_controller_origin_and_eval_opt_in";
    const MARKER: &str = "TERMINAL_V4_CONTROLLER_GATEWAY_CHILD";
    if std::env::var_os(MARKER).is_none() {
        for enabled in ["false", "true"] {
            let directory = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(MARKER, "1")
                .env("PREVIEW_EVAL_ENABLED", enabled)
                .env("HOME", directory.path())
                .env("USERPROFILE", directory.path())
                .output()
                .unwrap();
            println!(
                "eval={enabled}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    }
    let host = host().await;
    let upstream = upstream().await;
    let project = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = project.join(".runtime/browser/node/bin/node");
    let output = tokio::process::Command::new(node)
        .args([
            "--test",
            "--test-name-pattern=actual HTTP Tailscale gateway",
        ])
        .arg(project.join("rust/crates/api/src/preview/script_inject.test.cjs"))
        .env("PREVIEW_CONTROLLER_FIXTURE_API", &host.url)
        .env("PREVIEW_CONTROLLER_FIXTURE_PORT", upstream.port.to_string())
        .env(
            "PREVIEW_CONTROLLER_FIXTURE_TOKEN",
            access(&host, "synthetic-controller"),
        )
        .env(
            "PREVIEW_CONTROLLER_FIXTURE_EVAL",
            crate::preview_eval_enabled().to_string(),
        )
        .output()
        .await
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn controller_grants_bind_authenticated_origin_signature_port_and_expiry() {
    let host = host().await;
    let upstream = upstream().await;
    let client = client();
    let owner = access(&host, "synthetic-controller-owner");
    let prefix = format!("/preview/{}", upstream.port);
    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:3020",
        "https://synthetic-device.synthetic-tail.ts.net",
        "http://synthetic-device.synthetic-tail.ts.net:8080",
    ] {
        let minted = json_ok(
            client
                .post(format!("{}/api/preview/resource-auth", host.url))
                .bearer_auth(&owner)
                .header("origin", origin)
                .json(&json!({"targetPath":format!("{prefix}/")}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let ticket = minted["previewToken"].as_str().unwrap();
        let controller =
            super::auth_urls::resource_controller(&host.state, ticket, &prefix).unwrap();
        assert_eq!(controller.origin, origin);
        assert!(super::auth_urls::resource_controller(&host.state, ticket, "/preview/1").is_none());
        assert!(super::auth_urls::resource_controller(
            &host.state,
            &expired_token(&host, ticket),
            &prefix
        )
        .is_none());
        assert!(super::auth_urls::controller_resource_token(
            &host.state,
            ticket,
            &prefix,
            "http://127.0.0.1:9"
        )
        .is_none());
        let response = client
            .get(format!("{}{prefix}/", host.url))
            .query(&[("previewToken", ticket)])
            .send()
            .await
            .unwrap();
        assert_document_sandbox(&response);
        let html = response.text().await.unwrap();
        assert!(
            html.contains(&format!(
                "var previewController = {}",
                serde_json::to_string(&controller).unwrap()
            )),
            "{html}"
        );
        assert!(html.contains(&format!(
            "var previewEvaluationEnabled = {};",
            crate::preview_eval_enabled()
        )));
        let forged = jsonwebtoken::encode(&jsonwebtoken::Header::default(),
            &json!({"sub":"synthetic-controller-owner","username":"synthetic-controller-owner","exp":controller.expires_at,
                "token_kind":"preview-resource","prefix":prefix,"root":null,"controller_origin":"http://127.0.0.1:9"}),
            &jsonwebtoken::EncodingKey::from_secret(b"synthetic-wrong-signing-key")).unwrap();
        assert!(super::auth_urls::resource_controller(&host.state, &forged, &prefix).is_none());
        assert_eq!(
            client
                .get(format!("{}{prefix}/", host.url))
                .query(&[("previewToken", forged)])
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn absent_opaque_duplicate_or_invalid_controller_origins_keep_preview_read_only() {
    let host = host().await;
    let upstream = upstream().await;
    let client = client();
    let owner = access(&host, "synthetic-controller-owner");
    let prefix = format!("/preview/{}", upstream.port);
    for origin in [
        None,
        Some("null"),
        Some("https://synthetic.example/path"),
        Some("https://synthetic.example/"),
    ] {
        let mut request = client
            .post(format!("{}/api/preview/resource-auth", host.url))
            .bearer_auth(&owner);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let minted = json_ok(
            request
                .json(&json!({"targetPath":format!("{prefix}/")}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let ticket = minted["previewToken"].as_str().unwrap();
        assert!(super::auth_urls::resource_controller(&host.state, ticket, &prefix).is_none());
        let response = client
            .get(format!("{}{prefix}/", host.url))
            .query(&[("previewToken", ticket)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert!(response
            .text()
            .await
            .unwrap()
            .contains("var previewController = null;"));
    }
    for headers in [
        vec![
            ("origin", "http://localhost:5173"),
            ("origin", "http://localhost:5173"),
        ],
        vec![(
            "x-terminal-preview-controller-origin",
            "http://localhost:5173",
        )],
        vec![
            ("origin", "null"),
            (
                "x-terminal-preview-controller-origin",
                "http://localhost:5173",
            ),
        ],
        vec![
            ("origin", "http://localhost:5173"),
            ("x-terminal-preview-controller-origin", "null"),
        ],
    ] {
        let mut request = client
            .post(format!("{}/api/preview/resource-auth", host.url))
            .bearer_auth(&owner);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let minted = json_ok(
            request
                .json(&json!({"targetPath":format!("{prefix}/")}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert!(super::auth_urls::resource_controller(
            &host.state,
            minted["previewToken"].as_str().unwrap(),
            &prefix
        )
        .is_none());
    }
    let minted = json_ok(
        client
            .post(format!("{}/api/preview/resource-auth", host.url))
            .bearer_auth(&owner)
            .header("origin", "http://127.0.0.1:3030")
            .header(
                "x-terminal-preview-controller-origin",
                "http://synthetic-device.synthetic-tail.ts.net:8080",
            )
            .json(&json!({"targetPath":format!("{prefix}/")}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        super::auth_urls::resource_controller(
            &host.state,
            minted["previewToken"].as_str().unwrap(),
            &prefix
        )
        .unwrap()
        .origin,
        "http://synthetic-device.synthetic-tail.ts.net:8080"
    );
}

#[tokio::test]
async fn paired_controller_grants_require_agent_execute_and_home_verifies_its_own_origin() {
    let home = host().await;
    let target = host().await;
    let upstream = upstream().await;
    let client = client();
    let origin = "http://synthetic-device.synthetic-tail.ts.net:8080";
    for profile in ["observer", "operator"] {
        let environment = pair_profile(&client, &home, &target, "home-controller", profile).await;
        let prefix = format!(
            "/api/environments/{environment}/proxy/preview/{}",
            upstream.port
        );
        let minted = json_ok(
            client
                .post(format!("{}/api/preview/resource-auth", home.url))
                .bearer_auth(access(&home, "home-controller"))
                .header("origin", origin)
                .json(&json!({"targetPath":format!("{prefix}/")}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let ticket = minted["previewToken"].as_str().unwrap();
        let controller = super::auth_urls::resource_controller(&home.state, ticket, &prefix);
        assert_eq!(
            controller.as_ref().map(|binding| binding.origin.as_str()),
            (profile == "operator").then_some(origin)
        );
        assert!(super::auth_urls::resource_controller(&target.state, ticket, &prefix).is_none());
        let response = client
            .get(format!("{}{prefix}/", home.url))
            .query(&[("previewToken", ticket)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let html = response.text().await.unwrap();
        assert!(html.contains(&format!(
            "var previewController = {};",
            serde_json::to_string(&controller).unwrap()
        )));
        if profile == "operator" {
            home.state
                .lock_db()
                .unwrap()
                .execute(
                    "UPDATE paired_environments SET capabilities=?1 WHERE id=?2",
                    [
                        serde_json::to_string(&crate::remote_permissions::Capabilities::observer())
                            .unwrap(),
                        environment.clone(),
                    ],
                )
                .unwrap();
            let response = client
                .get(format!("{}{prefix}/", home.url))
                .query(&[("previewToken", ticket)])
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert!(response
                .text()
                .await
                .unwrap()
                .contains("var previewController = null;"));
        }
    }
}

#[tokio::test]
async fn local_resource_ticket_is_port_bound_read_only_and_never_reaches_upstream() {
    let host = host().await;
    let upstream = upstream().await;
    let client = client();
    let cookie = preview_cookie(&client, &host, "resource-owner").await;
    let response = client
        .get(format!("{}/preview/{}/", host.url, upstream.port))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_document_sandbox(&response);
    let html = response.text().await.unwrap();
    let asset = module_url(&html, &host);
    let ticket = resource_token(&asset);
    assert!(
        !html.contains(cookie.split_once('=').unwrap().1),
        "ordinary preview credential must remain HttpOnly"
    );
    let response = client
        .get(asset.clone())
        .header("referer", asset.as_str())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(response.text().await.unwrap().contains("answer = 42"));
    let recorded = upstream.requests.lock().unwrap().clone();
    assert_eq!(recorded.last().unwrap().0, "/main.js?application=kept");
    for credential in [&ticket, cookie.split_once('=').unwrap().1] {
        assert!(recorded
            .iter()
            .all(|(uri, headers)| !uri.contains(credential)
                && headers
                    .values()
                    .all(|value| !value.to_str().unwrap_or("").contains(credential))));
    }
    let mut websocket = asset.clone();
    websocket.set_scheme("ws").unwrap();
    let upgraded = tokio_tungstenite::connect_async(websocket.as_str()).await;
    assert!(
        matches!(upgraded, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == reqwest::StatusCode::UNAUTHORIZED),
        "read-only resource credentials must not authorize WebSocket control"
    );
    for route in [
        "/api/terminal",
        "/api/settings",
        "/api/environments",
        "/api/preview/5173/storage",
    ] {
        let response = client
            .get(format!("{}{route}", host.url))
            .query(&[("previewToken", &ticket)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "resource ticket authorized {route}"
        );
    }
    let response = client.post(asset.clone()).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    let wrong_port = if upstream.port == 65535 {
        upstream.port - 1
    } else {
        upstream.port + 1
    };
    let response = client
        .get(format!("{}/preview/{wrong_port}/main.js", host.url))
        .query(&[("previewToken", &ticket)])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    let expired = expired_token(&host, &ticket);
    let response = client
        .get(format!("{}/preview/{}/main.js", host.url, upstream.port))
        .query(&[("previewToken", &expired)])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

async fn pair(client: &reqwest::Client, home: &Host, target: &Host, owner: &str) -> String {
    pair_profile(client, home, target, owner, "observer").await
}

async fn pair_profile(
    client: &reqwest::Client,
    home: &Host,
    target: &Host,
    owner: &str,
    profile: &str,
) -> String {
    let issued = json_ok(
        client
            .post(format!("{}/api/environments/pairing-code", target.url))
            .bearer_auth(access(target, "target-owner"))
            .json(&json!({"label":"Synthetic preview", "profile":profile}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let environment = json_ok(
        client
            .post(format!("{}/api/environments/connect", home.url))
            .bearer_auth(access(home, owner))
            .json(&json!({"url":target.url,"code":issued["code"],"label":"Synthetic target"}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    environment["id"].as_str().unwrap().into()
}
async fn paired_asset(
    client: &reqwest::Client,
    home: &Host,
    environment: &str,
    port: u16,
) -> url::Url {
    let cookie = preview_cookie(client, home, "home-owner").await;
    let response = client
        .get(format!(
            "{}/api/environments/{environment}/proxy/preview/{port}/",
            home.url
        ))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_document_sandbox(&response);
    let html = response.text().await.unwrap();
    assert!(!html.contains(cookie.split_once('=').unwrap().1));
    assert!(!html.contains("tv4pair."));
    module_url(&html, home)
}

#[tokio::test]
async fn paired_resource_ticket_preserves_owner_environment_port_and_observer_boundaries() {
    let home = host().await;
    let target = host().await;
    let upstream = upstream().await;
    let client = client();
    let environment = pair(&client, &home, &target, "home-owner").await;
    let wrong_owner_cookie = preview_cookie(&client, &home, "other-owner").await;
    let denied_owner = client
        .get(format!(
            "{}/api/environments/{environment}/proxy/preview/{}/",
            home.url, upstream.port
        ))
        .header("cookie", wrong_owner_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(denied_owner.status(), reqwest::StatusCode::NOT_FOUND);
    let asset = paired_asset(&client, &home, &environment, upstream.port).await;
    let ticket = resource_token(&asset);
    let response = client.get(asset.clone()).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(!response.text().await.unwrap().contains("tv4pair."));
    let mut websocket = asset.clone();
    websocket.set_scheme("ws").unwrap();
    let upgraded = tokio_tungstenite::connect_async(websocket.as_str()).await;
    assert!(
        matches!(upgraded, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == reqwest::StatusCode::UNAUTHORIZED),
        "paired resource credentials must not authorize WebSocket control"
    );
    let other_environment = pair(&client, &home, &target, "other-owner").await;
    let wrong_environment = asset.as_str().replace(&environment, &other_environment);
    assert_eq!(
        client.get(wrong_environment).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let wrong_port = if upstream.port == 65535 {
        upstream.port - 1
    } else {
        upstream.port + 1
    };
    let wrong_port = asset.as_str().replace(
        &format!("/preview/{}/", upstream.port),
        &format!("/preview/{wrong_port}/"),
    );
    assert_eq!(
        client.get(wrong_port).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    for (method, suffix) in [
        (reqwest::Method::GET, "/api/terminal"),
        (reqwest::Method::POST, "/api/preview/5173/storage"),
        (reqwest::Method::POST, "/preview/5173/"),
    ] {
        let response = client
            .request(
                method,
                format!("{}/api/environments/{environment}/proxy{suffix}", home.url),
            )
            .query(&[("previewToken", &ticket)])
            .json(&json!({"type":"cookies","operation":"set","key":"session","value":"forbidden"}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "resource ticket authorized {suffix}"
        );
    }
    assert!(target
        .state
        .cookie_store()
        .list_cookies("target-owner", 5173)
        .await
        .is_empty());
    let expired = expired_token(&home, &ticket);
    let mut expired_url = asset.clone();
    expired_url
        .query_pairs_mut()
        .clear()
        .append_pair("previewToken", &expired);
    assert_eq!(
        client.get(expired_url).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let previous_expiry: i64 = home
        .state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT expires FROM paired_environments WHERE id=?1",
            [&environment],
            |row| row.get(0),
        )
        .unwrap();
    home.state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_environments SET expires=1 WHERE id=?1",
            [&environment],
        )
        .unwrap();
    assert_eq!(
        client.get(asset.clone()).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    home.state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_environments SET expires=?1 WHERE id=?2",
            rusqlite::params![previous_expiry, environment],
        )
        .unwrap();
    assert_eq!(
        client.get(asset.clone()).send().await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    let grant_id: String = home
        .state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT grant_id FROM paired_environments WHERE id=?1",
            [&environment],
            |row| row.get(0),
        )
        .unwrap();
    let revoked = client
        .delete(format!("{}/api/environments/grants/{grant_id}", target.url))
        .bearer_auth(access(&target, "target-owner"))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::NO_CONTENT);
    assert_eq!(
        client.get(asset).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn delegated_preview_cannot_mint_an_independent_resource_or_preview_credential() {
    let target = host().await;
    let upstream = upstream().await;
    let client = client();
    let issued = json_ok(
        client
            .post(format!("{}/api/environments/pairing-code", target.url))
            .bearer_auth(access(&target, "target-owner"))
            .json(&json!({"label":"Synthetic observer","profile":"observer"}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let exchange = json_ok(
        client
            .post(format!("{}/api/environments/exchange", target.url))
            .json(&json!({"code":issued["code"]}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let delegated = exchange["credential"].as_str().unwrap();
    let response = client
        .get(format!("{}/preview/{}/", target.url, upstream.port))
        .bearer_auth(delegated)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(!body.contains("previewToken=") && !body.contains(delegated));
    assert!(upstream
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|(uri, headers)| !uri.contains(delegated)
            && headers
                .values()
                .all(|value| !value.to_str().unwrap_or("").contains(delegated))));
    let response = client
        .post(format!("{}/api/preview/session", target.url))
        .bearer_auth(delegated)
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    let response = client
        .post(format!("{}/api/preview/resource-auth", target.url))
        .bearer_auth(delegated)
        .json(&json!({"targetPath":format!("/preview/{}/main.js", upstream.port)}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    let response = client
        .post(format!("{}/preview/{}/", target.url, upstream.port))
        .bearer_auth(delegated)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn static_resource_ticket_is_bound_to_its_root_and_exact_file_endpoint() {
    let host = host().await;
    let client = client();
    let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let project = tempfile::Builder::new()
        .prefix("resource-root-")
        .tempdir_in(&project_root)
        .unwrap();
    let other = tempfile::Builder::new()
        .prefix("resource-other-")
        .tempdir_in(project_root)
        .unwrap();
    std::fs::write(
        project.path().join("index.html"),
        "<script type='module' src='main.js'></script>",
    )
    .unwrap();
    std::fs::write(project.path().join("main.js"), "export const answer = 42;").unwrap();
    std::fs::write(
        other.path().join("main.js"),
        "export const secret = 'other';",
    )
    .unwrap();
    let response = client
        .get(format!("{}/api/preview", host.url))
        .query(&[("path", project.path().to_str().unwrap())])
        .header(
            "cookie",
            preview_cookie(&client, &host, "resource-owner").await,
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_document_sandbox(&response);
    let html = response.text().await.unwrap();
    let asset = module_url(&html, &host);
    let ticket = resource_token(&asset);
    let response = client.get(asset.clone()).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "export const answer = 42;");
    for (filename, content) in [
        (
            "document.svg",
            "<svg xmlns='http://www.w3.org/2000/svg'><script>void 0</script></svg>",
        ),
        ("document.xml", "<?xml version='1.0'?><document/>"),
    ] {
        std::fs::write(project.path().join(filename), content).unwrap();
        let response = client
            .get(format!("{}/api/preview", host.url))
            .query(&[
                ("path", project.path().to_str().unwrap()),
                ("file", filename),
                ("previewToken", ticket.as_str()),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_document_sandbox(&response);
        assert_eq!(response.text().await.unwrap(), content);
    }
    let mut other_root = asset.clone();
    let pairs = asset
        .query_pairs()
        .filter(|(key, _)| key != "path")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    other_root
        .query_pairs_mut()
        .clear()
        .extend_pairs(pairs)
        .append_pair("path", other.path().to_str().unwrap());
    assert_eq!(
        client.get(other_root).send().await.unwrap().status(),
        reqwest::StatusCode::FORBIDDEN
    );
    for route in [
        "/api/preview/5173/cookies",
        "/api/preview/5173/storage",
        "/api/terminal",
    ] {
        let response = client
            .get(format!("{}{route}", host.url))
            .query(&[("previewToken", &ticket)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "static resource ticket authorized {route}"
        );
    }
}

#[tokio::test]
async fn initial_resource_auth_requires_direct_owner_and_rejects_nonpreview_targets() {
    let host = host().await;
    let upstream = upstream().await;
    let client = client();
    let owner = access(&host, "resource-owner");
    let endpoint = format!("{}/api/preview/resource-auth", host.url);
    let target = format!("/preview/{}/main.js?application=kept", upstream.port);
    let minted = json_ok(
        client
            .post(&endpoint)
            .bearer_auth(&owner)
            .json(&json!({"targetPath":target}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let ticket = minted["previewToken"].as_str().unwrap();
    assert!(
        minted["expiresAt"].as_i64().unwrap() > time::OffsetDateTime::now_utc().unix_timestamp()
    );
    assert_ne!(ticket, owner);
    let legacy_target = format!(
        "/preview/{}/main.js?{}",
        upstream.port,
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("token", &owner)
            .append_pair("previewToken", ticket)
            .append_pair("application", "kept")
            .finish()
    );
    let sanitized = json_ok(
        client
            .post(&endpoint)
            .bearer_auth(&owner)
            .json(&json!({"targetPath":legacy_target}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let sanitized = sanitized["targetPath"].as_str().unwrap();
    assert!(!sanitized.contains(&owner) && !sanitized.contains(ticket));
    assert!(sanitized.contains("application=kept"));
    let business = json_ok(client.post(&endpoint).bearer_auth(&owner).json(&json!({"targetPath":format!("/preview/{}/main.js?token=application-business",upstream.port)})).send().await.unwrap()).await;
    assert!(business["targetPath"]
        .as_str()
        .unwrap()
        .contains("token=application-business"));
    let response = client
        .get(format!("{}{target}", host.url))
        .query(&[("previewToken", ticket)])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "export const answer = 42;");
    let denied_write = client
        .post(format!("{}{target}", host.url))
        .query(&[("previewToken", ticket)])
        .send()
        .await
        .unwrap();
    assert_eq!(denied_write.status(), reqwest::StatusCode::UNAUTHORIZED);
    let denied_admin = client
        .get(format!("{}/api/settings", host.url))
        .query(&[("previewToken", ticket)])
        .send()
        .await
        .unwrap();
    assert_eq!(denied_admin.status(), reqwest::StatusCode::UNAUTHORIZED);
    let other_port = if upstream.port == 65535 {
        upstream.port - 1
    } else {
        upstream.port + 1
    };
    let denied_port = client
        .get(format!("{}/preview/{other_port}/main.js", host.url))
        .query(&[("previewToken", ticket)])
        .send()
        .await
        .unwrap();
    assert_eq!(denied_port.status(), reqwest::StatusCode::UNAUTHORIZED);
    for invalid_target in [
        "/api/settings",
        "/api/auth/me",
        "/api/environments",
        "/api/preview/5173/storage",
        "/api/environments/missing/proxy/api/terminal",
        "/preview/5173/../api/settings",
        "/preview/65536/main.js",
        "https://example.test/preview/5173/main.js",
        "//example.test/preview/5173/main.js",
    ] {
        let response = client
            .post(&endpoint)
            .bearer_auth(&owner)
            .json(&json!({"targetPath":invalid_target}))
            .send()
            .await
            .unwrap();
        assert!(
            !response.status().is_success(),
            "issued resource credential for {invalid_target}"
        );
    }
    let cookie = preview_cookie(&client, &host, "resource-owner").await;
    let response = client
        .post(&endpoint)
        .header("cookie", &cookie)
        .json(&json!({"targetPath":target}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    for credential in [
        cookie.split_once('=').unwrap().1.to_string(),
        ticket.into(),
        expired_token(&host, &owner),
    ] {
        let response = client
            .post(&endpoint)
            .bearer_auth(credential)
            .json(&json!({"targetPath":target}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn initial_paired_resource_auth_checks_owner_and_live_environment_before_issuing() {
    let home = host().await;
    let target = host().await;
    let upstream = upstream().await;
    let client = client();
    let environment = pair(&client, &home, &target, "home-owner").await;
    let endpoint = format!("{}/api/preview/resource-auth", home.url);
    let target_path = format!(
        "/api/environments/{environment}/proxy/preview/{}/main.js",
        upstream.port
    );
    let wrong_owner = client
        .post(&endpoint)
        .bearer_auth(access(&home, "other-owner"))
        .json(&json!({"targetPath":target_path}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_owner.status(), reqwest::StatusCode::NOT_FOUND);
    let minted = json_ok(
        client
            .post(&endpoint)
            .bearer_auth(access(&home, "home-owner"))
            .json(&json!({"targetPath":target_path}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let ticket = minted["previewToken"].as_str().unwrap();
    assert_eq!(
        client
            .get(format!("{}{target_path}", home.url))
            .query(&[("previewToken", ticket)])
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    let response = client.post(&endpoint).bearer_auth(access(&home, "home-owner")).json(&json!({"targetPath":format!("/api/environments/{environment}/proxy/api/preview/5173/storage")})).send().await.unwrap();
    assert!(!response.status().is_success());
    home.state
        .lock_db()
        .unwrap()
        .execute(
            "UPDATE paired_environments SET expires=1 WHERE id=?1",
            [&environment],
        )
        .unwrap();
    let expired = client
        .post(&endpoint)
        .bearer_auth(access(&home, "home-owner"))
        .json(&json!({"targetPath":target_path}))
        .send()
        .await
        .unwrap();
    assert_eq!(expired.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn issued_static_and_external_resource_roots_remain_bound_for_every_credential_carrier() {
    let host = host().await;
    let client = client();
    let owner = access(&host, "resource-owner");
    let endpoint = format!("{}/api/preview/resource-auth", host.url);
    let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let project = tempfile::Builder::new()
        .prefix("issued-resource-root-")
        .tempdir_in(&project_root)
        .unwrap();
    let other = tempfile::Builder::new()
        .prefix("issued-resource-other-")
        .tempdir_in(project_root)
        .unwrap();
    std::fs::write(project.path().join("main.js"), "export const answer = 42;").unwrap();
    std::fs::write(
        other.path().join("main.js"),
        "export const secret = 'other';",
    )
    .unwrap();
    let query = |root: &std::path::Path| {
        format!(
            "/api/preview?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("path", root.to_str().unwrap())
                .append_pair("file", "main.js")
                .finish()
        )
    };
    let target_path = query(project.path());
    let minted = json_ok(
        client
            .post(&endpoint)
            .bearer_auth(&owner)
            .json(&json!({"targetPath":target_path}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let ticket = minted["previewToken"].as_str().unwrap();
    assert_eq!(
        client
            .get(format!("{}{target_path}", host.url))
            .query(&[("previewToken", ticket)])
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    for credential in ["bearer", "cookie", "query"] {
        let request = client.get(format!("{}{}", host.url, query(other.path())));
        let request = match credential {
            "bearer" => request.bearer_auth(ticket),
            "cookie" => request.header("cookie", format!("terminal_preview_token={ticket}")),
            _ => request.query(&[("previewToken", ticket)]),
        };
        assert_eq!(
            request.send().await.unwrap().status(),
            reqwest::StatusCode::FORBIDDEN,
            "static root changed through {credential}"
        );
    }
    let conflict = client
        .post(&endpoint)
        .bearer_auth(&owner)
        .json(&json!({"targetPath":target_path,"root":other.path().to_str().unwrap()}))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), reqwest::StatusCode::BAD_REQUEST);
    let missing = client
        .post(&endpoint)
        .bearer_auth(&owner)
        .json(&json!({"targetPath":"/api/preview?file=main.js"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::BAD_REQUEST);

    let external = "https://93.184.216.34/resource-fixture?application=kept";
    let target_path = format!(
        "/api/proxy-external?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("url", external)
            .finish()
    );
    let minted = json_ok(
        client
            .post(&endpoint)
            .bearer_auth(&owner)
            .json(&json!({"targetPath":target_path}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let ticket = minted["previewToken"].as_str().unwrap();
    assert!(super::auth_urls::resource_root_allowed(
        &host.state,
        ticket,
        external
    ));
    assert!(!super::auth_urls::resource_root_allowed(
        &host.state,
        ticket,
        "https://93.184.216.34/other"
    ));
    // A loopback mismatch verifies route rejection without contacting an external service.
    let upstream = upstream().await;
    let wrong = format!("http://127.0.0.1:{}/main.js", upstream.port);
    for credential in ["bearer", "cookie", "query"] {
        let request = client
            .get(format!("{}/api/proxy-external", host.url))
            .query(&[("url", &wrong)]);
        let request = match credential {
            "bearer" => request.bearer_auth(ticket),
            "cookie" => request.header("cookie", format!("terminal_preview_token={ticket}")),
            _ => request.query(&[("previewToken", ticket)]),
        };
        assert_eq!(
            request.send().await.unwrap().status(),
            reqwest::StatusCode::BAD_REQUEST,
            "private external target accepted through {credential}"
        );
    }
    assert!(upstream.requests.lock().unwrap().is_empty());
    let private = client
        .post(&endpoint)
        .bearer_auth(owner)
        .json(&json!({"targetPath":format!("/api/proxy-external?url={wrong}")}))
        .send()
        .await
        .unwrap();
    assert_eq!(private.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn fresh_initial_tickets_have_distinct_document_identity_and_children_reuse_it() {
    let host = host().await;
    let upstream = upstream().await;
    let client = client();
    let owner = access(&host, "resource-owner");
    let target = format!("/preview/{}/", upstream.port);
    let mut tickets = Vec::new();
    let mut identities = Vec::new();
    for _ in 0..2 {
        let minted = json_ok(
            client
                .post(format!("{}/api/preview/resource-auth", host.url))
                .bearer_auth(&owner)
                .json(&json!({"targetPath":target}))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let token = minted["previewToken"].as_str().unwrap().to_string();
        let claims = jsonwebtoken::decode::<Value>(
            &token,
            &jsonwebtoken::DecodingKey::from_secret(host.state.config().jwt_secret.as_bytes()),
            &jsonwebtoken::Validation::default(),
        )
        .unwrap()
        .claims;
        identities.push(
            uuid::Uuid::parse_str(
                claims["jti"].as_str().expect(
                    "fresh documents need a nonce even when expiry and target are identical",
                ),
            )
            .unwrap(),
        );
        tickets.push(token);
    }
    assert_ne!(identities[0], identities[1]);
    assert_ne!(tickets[0], tickets[1]);
    for ticket in tickets {
        let response = client
            .get(format!("{}{target}", host.url))
            .query(&[("previewToken", &ticket)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let html = response.text().await.unwrap();
        let module = module_url(&html, &host);
        assert_eq!(
            resource_token(&module),
            ticket,
            "child resources must retain their owning document identity"
        );
        assert_eq!(
            client.get(module).send().await.unwrap().status(),
            reqwest::StatusCode::OK
        );
    }
}
