use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn legacy_settings_gain_missing_columns_idempotently_preserving_all_rows() {
    for partial in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let db = Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE user_settings(user_id TEXT PRIMARY KEY, groq_api_key TEXT, updated_at TEXT NOT NULL, legacy_extra TEXT);
            INSERT INTO user_settings VALUES('fixture-a','synthetic-key-a','2020-01-01','extra-a');
            INSERT INTO user_settings VALUES('fixture-b',NULL,'2020-02-01','extra-b');").unwrap();
        if partial {
            db.execute_batch("ALTER TABLE user_settings ADD COLUMN theme TEXT DEFAULT 'dark'; UPDATE user_settings SET theme='light' WHERE user_id='fixture-a';").unwrap();
        }
        let read_rows = |db: &Connection| {
            db.prepare("SELECT user_id,groq_api_key,updated_at,legacy_extra FROM user_settings ORDER BY user_id").unwrap()
            .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
        };
        let original = read_rows(&db);
        for _ in 0..2 {
            let state = AppState::new(AppConfig {
                data_dir: data.path().into(),
                ..AppConfig::default()
            })
            .unwrap();
            assert_eq!(read_rows(&state.lock_db().unwrap()), original);
            let user = AuthenticatedUser {
                user_id: "fixture-a".into(),
                username: "fixture".into(),
            };
            let settings = state.get_settings(&user).unwrap();
            assert_eq!(
                (
                    settings.theme.as_str(),
                    settings.preview_url,
                    settings.sidebar_collapsed
                ),
                (if partial { "light" } else { "dark" }, None, false)
            );
            let token =
                issue_access_token(&state.config().jwt_secret, &user.user_id, &user.username);
            let response = crate::app(state.clone())
                .oneshot(
                    Request::builder()
                        .uri("/api/settings")
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        }
        let state = AppState::new(AppConfig {
            data_dir: data.path().into(),
            ..AppConfig::default()
        })
        .unwrap();
        let token = issue_access_token(&state.config().jwt_secret, "fixture-a", "fixture");
        let response = crate::app(state.clone())
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/settings")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"previewUrl":"http://localhost:4567","terminalFontSize":18}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let reopened = AppState::new(AppConfig {
            data_dir: data.path().into(),
            ..AppConfig::default()
        })
        .unwrap();
        let saved = reopened
            .get_settings(&AuthenticatedUser {
                user_id: "fixture-a".into(),
                username: "fixture".into(),
            })
            .unwrap();
        assert_eq!(
            (saved.preview_url.as_deref(), saved.terminal_font_size),
            (Some("http://localhost:4567"), Some(18))
        );
        let retained: (Option<String>, String) = reopened
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT groq_api_key,legacy_extra FROM user_settings WHERE user_id='fixture-a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(retained, (Some("synthetic-key-a".into()), "extra-a".into()));
        assert_eq!(read_rows(&reopened.lock_db().unwrap())[1], original[1]);
    }
}
