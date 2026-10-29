use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;

const APP_HTML: &str = "<!doctype html><title>Trusted synthetic app</title>";
const SCRIPT: &str = "export const fixture = 'synthetic asset';";

struct Fixture {
    root: tempfile::TempDir,
    state: crate::ApiState,
    router: Router,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("frontend/dist");
        std::fs::create_dir_all(bundle.join("assets")).unwrap();
        std::fs::write(bundle.join("index.html"), APP_HTML).unwrap();
        std::fs::write(bundle.join("assets/app-fixture.js"), SCRIPT).unwrap();
        let state = crate::ApiState::new_with_external_auth(
            AppConfig {
                data_dir: root.path().join("app/data"),
                jwt_secret: "synthetic-static-route-key".into(),
                ..AppConfig::default()
            },
            None,
        )
        .unwrap();
        let router = crate::app(state.clone());
        Self {
            root,
            state,
            router,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, headers, bytes)
    }
    fn token(&self, owner: &str) -> String {
        crate::auth::issue_access_token(&self.state.config().jwt_secret, owner, owner)
    }
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).map(|value| value.to_str().unwrap())
}
fn assert_no_runner_policy(headers: &HeaderMap) {
    for name in [
        "cross-origin-opener-policy",
        "cross-origin-embedder-policy",
        "referrer-policy",
    ] {
        assert_eq!(header(headers, name), None, "unexpected {name}");
    }
}

#[tokio::test]
async fn runner_exact_paths_get_and_head_serve_the_app_index_with_isolation_and_no_store() {
    let fixture = Fixture::new();
    // A colliding directory must neither redirect nor replace the trusted runner entry.
    let shadow = fixture.root.path().join("frontend/dist/webcontainer");
    std::fs::create_dir(&shadow).unwrap();
    std::fs::write(
        shadow.join("index.html"),
        "<title>Wrong shadow document</title>",
    )
    .unwrap();
    for method in ["GET", "HEAD"] {
        for path in [
            "/webcontainer",
            "/webcontainer/",
            "/webcontainer?fixture=1",
            "/webcontainer/?fixture=1",
        ] {
            let (status, headers, bytes) = fixture.request(method, path, None, Value::Null).await;
            assert_eq!(
                (
                    status,
                    header(&headers, "content-type"),
                    header(&headers, "cross-origin-opener-policy"),
                    header(&headers, "cross-origin-embedder-policy"),
                    header(&headers, "cache-control"),
                    header(&headers, "referrer-policy"),
                    header(&headers, "content-security-policy"),
                    header(&headers, "location")
                ),
                (
                    StatusCode::OK,
                    Some("text/html"),
                    Some("same-origin"),
                    Some("require-corp"),
                    Some("no-store"),
                    Some("strict-origin-when-cross-origin"),
                    Some("frame-ancestors 'none'"),
                    None
                ),
                "{method} {path}"
            );
            assert_eq!(
                bytes,
                if method == "HEAD" {
                    vec![]
                } else {
                    APP_HTML.as_bytes().to_vec()
                },
                "{method} {path}"
            );
            assert_eq!(
                headers
                    .get_all("cross-origin-embedder-policy")
                    .iter()
                    .count(),
                1
            );
        }
    }
}

#[tokio::test]
async fn runner_policy_does_not_spread_to_normal_spa_paths_assets_or_encoded_aliases() {
    let fixture = Fixture::new();
    for path in [
        "/",
        "/index.html",
        "/workspace/synthetic",
        "/webcontainer/nested",
        "/webcontainer-extra",
        "/webcontainer//",
        "/web%63ontainer",
    ] {
        let (status, headers, bytes) = fixture.request("GET", path, None, Value::Null).await;
        assert_eq!(
            (status, bytes),
            (
                if matches!(path, "/" | "/index.html") {
                    StatusCode::OK
                } else {
                    StatusCode::NOT_FOUND
                },
                APP_HTML.as_bytes().to_vec()
            ),
            "{path}"
        );
        assert_no_runner_policy(&headers);
        assert_eq!(
            header(&headers, "cache-control"),
            Some("no-cache, no-store, must-revalidate"),
            "SPA HTML must not become immutable: {path}"
        );
    }
    let guide = fixture.root.path().join("frontend/dist/guide");
    std::fs::create_dir(&guide).unwrap();
    std::fs::write(guide.join("index.html"), APP_HTML).unwrap();
    let (status, headers, bytes) = fixture.request("GET", "/guide/", None, Value::Null).await;
    assert_eq!(
        (status, bytes, header(&headers, "cache-control")),
        (
            StatusCode::OK,
            APP_HTML.as_bytes().to_vec(),
            Some("no-cache, no-store, must-revalidate")
        )
    );
    assert_no_runner_policy(&headers);
    let (status, headers, bytes) = fixture
        .request("GET", "/assets/app-fixture.js?fixture=1", None, Value::Null)
        .await;
    assert_eq!(
        (status, bytes, header(&headers, "cache-control")),
        (
            StatusCode::OK,
            SCRIPT.as_bytes().to_vec(),
            Some("public, max-age=31536000, immutable")
        )
    );
    assert_no_runner_policy(&headers);
    for path in ["/assets/missing.js", "/api/no-such-runner-route"] {
        let (status, headers, bytes) = fixture.request("GET", path, None, Value::Null).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_no_runner_policy(&headers);
        assert!(!String::from_utf8_lossy(&bytes).contains("Trusted synthetic app"));
        assert_ne!(
            header(&headers, "cache-control"),
            Some("public, max-age=31536000, immutable")
        );
    }
}

#[tokio::test]
async fn runner_errors_and_unsupported_methods_do_not_receive_success_document_policy() {
    let fixture = Fixture::new();
    for path in ["/webcontainer", "/webcontainer/"] {
        let (status, headers, _) = fixture.request("POST", path, None, json!({})).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_no_runner_policy(&headers);
    }
    std::fs::remove_file(fixture.root.path().join("frontend/dist/index.html")).unwrap();
    for method in ["GET", "HEAD"] {
        for path in ["/webcontainer", "/webcontainer/?fixture=1"] {
            let (status, headers, bytes) = fixture.request(method, path, None, Value::Null).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_no_runner_policy(&headers);
            assert_ne!(
                header(&headers, "cache-control"),
                Some("public, max-age=31536000, immutable")
            );
            if method == "HEAD" {
                assert!(bytes.is_empty());
            }
        }
    }
}

#[tokio::test]
async fn runner_public_shell_preserves_api_auth_preview_ticket_scope_and_private_environment_responses(
) {
    let fixture = Fixture::new();
    for path in [
        "/api/auth/me",
        "/api/settings",
        "/api/webcontainer/files?path=synthetic",
        "/preview/5173/webcontainer",
        "/api/proxy-external?url=https%3A%2F%2Fexample.invalid",
        "/api/environments/missing/proxy/webcontainer",
    ] {
        let (status, headers, _) = fixture.request("GET", path, None, Value::Null).await;
        assert_eq!(
            status,
            if path.starts_with("/api/environments/") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::UNAUTHORIZED
            },
            "{path}"
        );
        assert_no_runner_policy(&headers);
        if path.starts_with("/api/environments/") {
            assert_eq!(header(&headers, "cache-control"), Some("private, no-store"));
        }
    }
    let preview_host = format!("preview-5173.{}", crate::preview::subdomain_bases()[0]);
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/webcontainer")
                .header("host", preview_host)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_runner_policy(response.headers());
    let owner = fixture.token("synthetic-owner");
    let (status, headers, bytes) = fixture
        .request(
            "POST",
            "/api/preview/resource-auth",
            Some(&owner),
            json!({"targetPath":"/preview/5173/asset.js"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_no_runner_policy(&headers);
    let resource: Value = serde_json::from_slice(&bytes).unwrap();
    let ticket = resource["previewToken"].as_str().unwrap();
    let identity = crate::preview::auth_urls::authenticate_resource_token(
        &fixture.state,
        ticket,
        "GET",
        "/preview/5173/asset.js",
    )
    .unwrap();
    assert_eq!(identity.user_id, "synthetic-owner");
    assert!(crate::preview::auth_urls::authenticate_resource_token(
        &fixture.state,
        ticket,
        "GET",
        "/preview/5174/asset.js"
    )
    .is_err());
    assert!(crate::preview::auth_urls::authenticate_resource_token(
        &fixture.state,
        ticket,
        "POST",
        "/preview/5173/asset.js"
    )
    .is_err());
    let (status, headers, _) = fixture
        .request(
            "GET",
            &format!("/api/settings?previewToken={ticket}"),
            None,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_no_runner_policy(&headers);
    let (status, headers, _) = fixture
        .request("GET", "/api/environments", Some(&owner), Value::Null)
        .await;
    assert_eq!(
        (status, header(&headers, "cache-control")),
        (StatusCode::OK, Some("private, no-store"))
    );
    assert_no_runner_policy(&headers);
}
