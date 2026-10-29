use super::*;
use axum::http::Request;
use http_body_util::BodyExt;

fn isolated(name: &str) -> bool {
    const MARKER: &str = "TERMINAL_V4_RENAME_CONTRACT_FIXTURE";
    if std::env::var(MARKER).as_deref() == Ok(name) {
        return false;
    }
    let directory = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env(MARKER, name)
        .env("HOME", directory.path())
        .env("USERPROFILE", directory.path())
        .env_remove("TERMINAL_V4_ALLOWED_FILE_ROOTS")
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}
fn fixture() -> (tempfile::TempDir, Router) {
    let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let state = AppState::new_with_external_auth(
        terminal_v4_core::AppConfig {
            data_dir: root.path().join("data"),
            ..Default::default()
        },
        None,
    )
    .unwrap();
    (root, app(state))
}
async fn rename(router: &Router, from: &FsPath, to: &FsPath, aliases: bool) -> (StatusCode, Value) {
    let body = if aliases {
        json!({"oldPath":from,"newPath":to})
    } else {
        json!({"from":from,"to":to})
    };
    let token = auth::issue_access_token(
        terminal_v4_core::DEFAULT_JWT_SECRET,
        "rename-fixture",
        "synthetic",
    );
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/files/rename")
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
fn create(path: &FsPath, directory: bool, bytes: &[u8]) {
    if directory {
        std::fs::create_dir(path).unwrap();
        std::fs::write(path.join("marker.bin"), bytes).unwrap();
    } else {
        std::fs::write(path, bytes).unwrap();
    }
}
fn content(path: &FsPath, directory: bool) -> Vec<u8> {
    std::fs::read(if directory {
        path.join("marker.bin")
    } else {
        path.into()
    })
    .unwrap()
}

#[tokio::test]
async fn rename_moves_regular_files_and_directories_with_both_payload_contracts() {
    if isolated("file_rename_contract_tests::rename_moves_regular_files_and_directories_with_both_payload_contracts") { return; }
    let (root, router) = fixture();
    for directory in [false, true] {
        let from = root.path().join(if directory {
            "source-dir"
        } else {
            "source.bin"
        });
        let to = root.path().join(if directory {
            "target-dir"
        } else {
            "target.bin"
        });
        create(&from, directory, b"synthetic source bytes");
        if directory {
            std::fs::create_dir(from.join("empty")).unwrap();
        }
        assert_eq!(
            rename(&router, &from, &to, directory).await,
            (StatusCode::NO_CONTENT, Value::Null)
        );
        assert!(!from.exists());
        assert_eq!(content(&to, directory), b"synthetic source bytes");
        if directory {
            assert!(to.join("empty").is_dir());
        }
    }
}

#[tokio::test]
async fn rename_collision_preserves_regular_files_empty_and_nonempty_directories_and_late_targets()
{
    if isolated("file_rename_contract_tests::rename_collision_preserves_regular_files_empty_and_nonempty_directories_and_late_targets") { return; }
    let (root, router) = fixture();
    for (index, (source_directory, target_directory, empty)) in [
        (false, false, false),
        (true, true, false),
        (true, true, true),
        (false, true, true),
        (true, false, false),
    ]
    .into_iter()
    .enumerate()
    {
        let from = root.path().join(format!("source-{index}"));
        let to = root.path().join(format!("target-{index}"));
        create(&from, source_directory, b"original source");
        assert!(!to.exists());
        if empty {
            std::fs::create_dir(&to).unwrap();
        } else {
            create(&to, target_directory, b"concurrent destination");
        }
        let (status, body) = rename(&router, &from, &to, false).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(content(&from, source_directory), b"original source");
        if empty {
            assert_eq!(std::fs::read_dir(&to).unwrap().count(), 0);
        } else {
            assert_eq!(content(&to, target_directory), b"concurrent destination");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rename_moves_the_selected_symlink_and_preserves_file_directory_and_dangling_referents() {
    if isolated("file_rename_contract_tests::rename_moves_the_selected_symlink_and_preserves_file_directory_and_dangling_referents") { return; }
    use std::os::unix::fs::symlink;
    let (root, router) = fixture();
    let outside = tempfile::tempdir().unwrap();
    for kind in ["file", "directory", "dangling", "outside"] {
        let target = if kind == "outside" {
            outside.path().join("referent")
        } else {
            root.path().join(format!("referent-{kind}"))
        };
        if kind != "dangling" {
            create(&target, kind == "directory", b"referent stays unchanged");
        }
        let from = root.path().join(format!("source-link-{kind}"));
        let to = root.path().join(format!("target-link-{kind}"));
        symlink(&target, &from).unwrap();
        assert_eq!(
            rename(&router, &from, &to, false).await.0,
            StatusCode::NO_CONTENT,
            "{kind}"
        );
        assert!(std::fs::symlink_metadata(&to)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&to).unwrap(), target);
        assert!(std::fs::symlink_metadata(&from).is_err());
        if kind == "dangling" {
            assert!(!target.exists());
        } else {
            assert_eq!(
                content(&target, kind == "directory"),
                b"referent stays unchanged"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rename_existing_symlink_destinations_preserve_the_link_referent_and_source() {
    if isolated("file_rename_contract_tests::rename_existing_symlink_destinations_preserve_the_link_referent_and_source") { return; }
    use std::os::unix::fs::symlink;
    let (root, router) = fixture();
    let outside = tempfile::tempdir().unwrap();
    for kind in ["file", "directory", "dangling", "outside"] {
        let from = root.path().join(format!("source-{kind}"));
        create(&from, false, b"preserved source");
        let target = if kind == "outside" {
            outside.path().join("referent")
        } else {
            root.path().join(format!("referent-{kind}"))
        };
        if kind != "dangling" {
            create(&target, kind == "directory", b"preserved referent");
        }
        let to = root.path().join(format!("destination-link-{kind}"));
        symlink(&target, &to).unwrap();
        let (status, body) = rename(&router, &from, &to, false).await;
        assert_eq!(status, StatusCode::CONFLICT, "{kind}: {body}");
        assert_eq!(std::fs::read_link(&to).unwrap(), target);
        assert_eq!(content(&from, false), b"preserved source");
        if kind == "dangling" {
            assert!(!target.exists());
        } else {
            assert_eq!(content(&target, kind == "directory"), b"preserved referent");
        }
    }
}

#[tokio::test]
async fn concurrent_rename_requests_publish_one_winner_and_keep_every_losing_source() {
    if isolated("file_rename_contract_tests::concurrent_rename_requests_publish_one_winner_and_keep_every_losing_source") { return; }
    let (root, router) = fixture();
    const CONTENDERS: usize = 8;
    for directory in [false, true] {
        let folder = root
            .path()
            .join(if directory { "directories" } else { "files" });
        std::fs::create_dir(&folder).unwrap();
        let to = folder.join("destination");
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(CONTENDERS));
        let mut jobs = tokio::task::JoinSet::new();
        for index in 0..CONTENDERS {
            let from = folder.join(format!("source-{index}"));
            let bytes = format!("source bytes {index}").into_bytes();
            create(&from, directory, &bytes);
            let router = router.clone();
            let to = to.clone();
            let barrier = barrier.clone();
            jobs.spawn(async move {
                barrier.wait().await;
                let result = rename(&router, &from, &to, false).await;
                (from, bytes, result)
            });
        }
        let mut winners = 0;
        while let Some(job) = jobs.join_next().await {
            let (from, bytes, (status, body)) = job.unwrap();
            if status == StatusCode::NO_CONTENT {
                winners += 1;
                assert!(!from.exists());
                assert_eq!(content(&to, directory), bytes);
            } else {
                assert_eq!(status, StatusCode::CONFLICT, "{body}");
                assert_eq!(content(&from, directory), bytes);
            }
        }
        assert_eq!(winners, 1);
    }
}

#[tokio::test]
async fn rename_refuses_outside_parents_missing_destinations_and_unauthorized_requests_without_source_loss(
) {
    if isolated("file_rename_contract_tests::rename_refuses_outside_parents_missing_destinations_and_unauthorized_requests_without_source_loss") { return; }
    let (root, router) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let from = root.path().join("source.bin");
    create(&from, false, b"source survives errors");
    let denied = outside.path().join("target.bin");
    assert_eq!(
        rename(&router, &from, &denied, false).await.0,
        StatusCode::FORBIDDEN
    );
    let outside_source = outside.path().join("source.bin");
    create(&outside_source, false, b"outside stays unchanged");
    assert_eq!(
        rename(
            &router,
            &outside_source,
            &root.path().join("outside-moved.bin"),
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        rename(
            &router,
            &from,
            &root.path().join("missing/target.bin"),
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside-parent")).unwrap();
        assert_eq!(
            rename(
                &router,
                &from,
                &root.path().join("outside-parent/target.bin"),
                false
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/files/rename")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"from":from,"to":root.path().join("unauthorized.bin")}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(content(&from, false), b"source survives errors");
    assert_eq!(content(&outside_source, false), b"outside stays unchanged");
    assert!(!denied.exists());
}
