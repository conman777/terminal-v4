use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use std::collections::HashSet;

fn isolated(test: &str) -> Option<tempfile::TempDir> {
    const MARKER: &str = "TERMINAL_V4_UPLOAD_CONTRACT_FIXTURE";
    if std::env::var(MARKER).as_deref() == Ok(test) {
        return None;
    }
    let directory = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(MARKER, test)
        .env("HOME", directory.path())
        .env("USERPROFILE", directory.path())
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Some(directory)
}

async fn upload(
    router: &Router,
    route: &str,
    target: Option<&str>,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let boundary = "SyntheticUploadBoundary";
    let mut body = Vec::new();
    if let Some(target) = target {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{target}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"synthetic.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let token = auth::issue_access_token(
        terminal_v4_core::DEFAULT_JWT_SECRET,
        "upload-fixture",
        "synthetic",
    );
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(route)
                .header("authorization", format!("Bearer {token}"))
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&body)})),
    )
}

fn fixture() -> (tempfile::TempDir, Router) {
    let directory = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: directory.path().join("data"),
        ..Default::default()
    })
    .unwrap();
    let router = app(state);
    (directory, router)
}

#[tokio::test]
async fn file_upload_accepts_three_mebibytes_below_advertised_limit() {
    if isolated("upload_contract_tests::file_upload_accepts_three_mebibytes_below_advertised_limit")
        .is_some()
    {
        return;
    }
    let (directory, router) = fixture();
    let target = directory.path().join("synthetic.bin");
    let bytes = vec![b'x'; 3 * 1024 * 1024];
    let (status, body) = upload(&router, "/api/files/upload", target.to_str(), &bytes).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn screenshot_upload_accepts_three_mebibytes_below_advertised_limit() {
    if isolated(
        "upload_contract_tests::screenshot_upload_accepts_three_mebibytes_below_advertised_limit",
    )
    .is_some()
    {
        return;
    }
    let (directory, router) = fixture();
    let target = directory.path().join("synthetic.png");
    let mut bytes = vec![0; 3 * 1024 * 1024];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let (status, body) = upload(&router, "/api/files/screenshot", target.to_str(), &bytes).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn pasted_images_receive_distinct_paths_and_preserve_all_prior_bytes() {
    if isolated(
        "upload_contract_tests::pasted_images_receive_distinct_paths_and_preserve_all_prior_bytes",
    )
    .is_some()
    {
        return;
    }
    let (_directory, router) = fixture();
    let mut saved = Vec::new();
    for marker in 0..8u8 {
        let mut bytes = b"\x89PNG\r\n\x1a\nsynthetic attachment".to_vec();
        bytes.push(marker);
        let (status, body) = upload(&router, "/api/files/screenshot", None, &bytes).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let path = files::resolve_safe_path(body["path"].as_str().unwrap()).unwrap();
        saved.push((path, bytes));
    }
    assert_eq!(
        saved
            .iter()
            .map(|(path, _)| path)
            .collect::<HashSet<_>>()
            .len(),
        saved.len()
    );
    for (path, bytes) in saved {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[tokio::test]
async fn transcription_upload_reaches_local_fixture_with_three_mebibytes() {
    if isolated(
        "upload_contract_tests::transcription_upload_reaches_local_fixture_with_three_mebibytes",
    )
    .is_some()
    {
        return;
    }
    let upstream = Router::new()
        .route(
            "/inference",
            post(|mut multipart: axum_extra::extract::Multipart| async move {
                let field = multipart.next_field().await.unwrap().unwrap();
                assert_eq!(field.name(), Some("file"));
                assert_eq!(
                    field.bytes().await.unwrap().as_ref(),
                    vec![b'x'; 3 * 1024 * 1024]
                );
                Json(json!({"text":"Synthetic local transcript"}))
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    std::env::set_var("WHISPER_SERVER_URL", format!("http://127.0.0.1:{port}"));
    let (_directory, router) = fixture();
    let bytes = vec![b'x'; 3 * 1024 * 1024];
    let (status, body) = upload(&router, "/api/transcribe?provider=local", None, &bytes).await;
    server.abort();
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({"text":"Synthetic local transcript","provider":"local"})
        )
    );
}
