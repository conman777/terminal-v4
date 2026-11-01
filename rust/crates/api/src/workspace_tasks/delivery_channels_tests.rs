use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const SECRET: &str = "super-secret-signing-key-123";
const HOOK_PATH: &str = "/hook/T000/B000/XXXXTOKENXXXX";

fn allow() -> Policy {
    Policy {
        allow_loopback: true,
    }
}

mod pure {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_vectors() {
        let short = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let long_key = hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            (hex::encode(short), hex::encode(long_key)),
            (
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843".to_owned(),
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54".to_owned()
            )
        );
    }

    #[test]
    fn signature_covers_timestamp_and_body() {
        let sig = signature_header("k".repeat(16).as_str(), 100, b"{}");
        let expected = format!(
            "sha256={}",
            hex::encode(hmac_sha256("k".repeat(16).as_bytes(), b"100.{}"))
        );
        assert_eq!(
            (
                sig.clone(),
                sig == signature_header("k".repeat(16).as_str(), 101, b"{}"),
                sig == signature_header("k".repeat(16).as_str(), 100, b"{ }")
            ),
            (expected, false, false)
        );
    }

    #[test]
    fn private_loopback_and_reserved_addresses_are_blocked() {
        let blocked = [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "ff02::1",
        ];
        let allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"];
        assert_eq!(
            (
                blocked
                    .iter()
                    .filter(|ip| !is_blocked_ip(ip.parse().unwrap()))
                    .collect::<Vec<_>>(),
                allowed
                    .iter()
                    .filter(|ip| is_blocked_ip(ip.parse().unwrap()))
                    .collect::<Vec<_>>(),
            ),
            (vec![], vec![])
        );
    }

    #[test]
    fn endpoints_are_validated_per_channel() {
        let p = Policy::default();
        let ok_secret = Some(SECRET);
        let cases: Vec<(Channel, &str, Option<&str>, bool)> = vec![
            (
                Channel::Slack,
                "https://hooks.slack.com/services/T0/B0/x",
                None,
                true,
            ),
            (
                Channel::Slack,
                "https://evil.example.com/services/T0/B0/x",
                None,
                false,
            ),
            (
                Channel::Slack,
                "http://hooks.slack.com/services/T0/B0/x",
                None,
                false,
            ),
            (
                Channel::Slack,
                "https://user:pw@hooks.slack.com/services/T0/B0/x",
                None,
                false,
            ),
            (
                Channel::Discord,
                "https://discord.com/api/webhooks/1/abc",
                None,
                true,
            ),
            (
                Channel::Discord,
                "https://discord.com/other/1/abc",
                None,
                false,
            ),
            (Channel::Webhook, "https://example.com/in", ok_secret, true),
            (Channel::Webhook, "https://example.com/in", None, false),
            (
                Channel::Webhook,
                "https://example.com/in",
                Some("short"),
                false,
            ),
            (Channel::Webhook, "https://10.0.0.5/in", ok_secret, false),
            (
                Channel::Webhook,
                "https://169.254.169.254/latest",
                ok_secret,
                false,
            ),
            (Channel::Webhook, "https://[::1]/in", ok_secret, false),
            (Channel::Webhook, "https://localhost/in", ok_secret, false),
            (
                Channel::Webhook,
                "https://printer.local/in",
                ok_secret,
                false,
            ),
            (Channel::Webhook, "http://example.com/in", ok_secret, false),
            (Channel::Webhook, "http://127.0.0.1:9/in", ok_secret, false),
            (Channel::Webhook, "ftp://example.com/in", ok_secret, false),
            (Channel::Webhook, "", ok_secret, false),
        ];
        let got: Vec<bool> = cases
            .iter()
            .map(|(c, u, s, _)| validate_endpoint(*c, u, *s, p).is_ok())
            .collect();
        let want: Vec<bool> = cases.iter().map(|case| case.3).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn loopback_is_allowed_only_under_the_explicit_test_policy_and_private_ranges_never() {
        assert_eq!(
            (
                validate_endpoint(
                    Channel::Webhook,
                    "http://127.0.0.1:9/in",
                    Some(SECRET),
                    allow()
                )
                .is_ok(),
                validate_endpoint(
                    Channel::Webhook,
                    "http://10.0.0.5/in",
                    Some(SECRET),
                    allow()
                )
                .is_ok(),
            ),
            (true, false)
        );
    }

    #[test]
    fn bodies_are_bounded_and_cannot_ping_or_inject_markup() {
        let id = Uuid::nil();
        let slack: serde_json::Value =
            serde_json::from_slice(&build_body(Channel::Slack, id, "<!channel> a & b")).unwrap();
        let discord: serde_json::Value =
            serde_json::from_slice(&build_body(Channel::Discord, id, &"x".repeat(10_000))).unwrap();
        let hook: serde_json::Value =
            serde_json::from_slice(&build_body(Channel::Webhook, id, &"y".repeat(50_000))).unwrap();
        assert_eq!(
            (
                slack["text"].as_str().unwrap().to_owned(),
                discord["content"].as_str().unwrap().chars().count() < 2000,
                discord["allowed_mentions"]["parse"].clone(),
                hook["text"].as_str().unwrap().chars().count() < WEBHOOK_CHARS + 20,
                hook["deliveryId"].clone(),
            ),
            (
                "&lt;!channel&gt; a &amp; b".to_owned(),
                true,
                serde_json::json!([]),
                true,
                serde_json::json!(id.to_string())
            )
        );
    }
}

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    fn hits(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}{HOOK_PATH}", self.port)
    }
}

async fn mock(script: Vec<u16>) -> Mock {
    let seen: Arc<Mutex<Vec<Seen>>> = Default::default();
    let queue = Arc::new(Mutex::new(VecDeque::from(script)));
    let (log, replies) = (seen.clone(), queue);
    let app = axum::Router::new().fallback(move |request: Request<Body>| {
        let (log, replies) = (log.clone(), replies.clone());
        async move {
            let (parts, body) = request.into_parts();
            let body = axum::body::to_bytes(body, 1 << 20).await.unwrap().to_vec();
            log.lock().unwrap().push(Seen {
                path: parts.uri.path().to_owned(),
                headers: parts
                    .headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
                    .collect(),
                body,
            });
            let code = replies.lock().unwrap().pop_front().unwrap_or(200);
            let mut response = axum::response::Response::new(Body::from("ok"));
            *response.status_mut() = StatusCode::from_u16(code).unwrap();
            if code == 302 {
                response
                    .headers_mut()
                    .insert("location", "http://127.0.0.1:1/elsewhere".parse().unwrap());
            }
            response
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Mock { port, seen }
}

fn app(data: &FsPath, owner: &str) -> Router {
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: data.to_path_buf(),
        ..Default::default()
    })
    .unwrap();
    routes()
        .layer(Extension(AuthenticatedUser {
            user_id: owner.into(),
            username: "fixture".into(),
        }))
        .with_state(state)
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn enable_loopback() {
    ALLOW_LOOPBACK.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn finished(data: &FsPath, owner: &str, target: DeliveryTarget, result: &str) -> Uuid {
    let mut store = TaskStore {
        owner_id: owner.into(),
        ..Default::default()
    };
    let input = TaskInput {
        workspace_path: data.to_string_lossy().into_owned(),
        provider: "codex".into(),
        prompt: "Nightly".into(),
        model: None,
        parent_session_id: None,
        parent_task_id: None,
    };
    let id = enqueue(&mut store, input, None, 1).unwrap().id;
    delivery::mark_for_delivery(&mut store, id, Some(target));
    store.tasks[0].result = result.into();
    transition(&mut store.tasks[0], TaskStatus::Completed, "done", 5);
    write_store(data, &store).unwrap();
    id
}

async fn run_delivery(data: &FsPath) -> usize {
    let claimed = delivery::claim_deliveries(data, false).unwrap();
    let count = claimed.len();
    for item in claimed {
        delivery::deliver(data.to_path_buf(), item).await;
    }
    count
}

fn outcome(data: &FsPath, owner: &str) -> (Option<DeliveryStatus>, Option<String>) {
    let delivery = read_store(data, owner).unwrap().tasks.remove(0).delivery;
    (delivery.delivery_status, delivery.delivery_reason)
}

async fn configure_all(router: &Router, mock: &Mock) {
    for channel in ["slack", "discord", "webhook"] {
        let (status, _) = call(
            router,
            "PUT",
            &format!("/api/workspace/delivery-channels/{channel}"),
            serde_json::json!({ "url": mock.url(), "secret": SECRET }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "configuring {channel}");
    }
}

#[tokio::test]
async fn slack_discord_and_signed_webhook_deliver_once_with_secrets_encrypted_at_rest() {
    enable_loopback();
    let data = tempfile::tempdir().unwrap();
    let server = mock(vec![]).await;
    let router = app(data.path(), "alice");
    configure_all(&router, &server).await;
    let stored = std::fs::read_to_string(config_path(data.path(), "alice")).unwrap();
    let mut expected = Vec::new();
    for target in [
        DeliveryTarget::Slack,
        DeliveryTarget::Discord,
        DeliveryTarget::Webhook,
    ] {
        let dir = tempfile::tempdir_in(data.path()).unwrap();
        let _ = dir;
        let id = finished(data.path(), "alice", target, "all good API_KEY=hunter2");
        assert_eq!(run_delivery(data.path()).await, 1);
        assert_eq!(run_delivery(data.path()).await, 0, "claimed only once");
        expected.push((id, outcome(data.path(), "alice")));
        let mut store = read_store(data.path(), "alice").unwrap();
        store.tasks.clear();
        write_store(data.path(), &store).unwrap();
    }
    let hits = server.hits();
    let bodies: Vec<serde_json::Value> = hits
        .iter()
        .map(|hit| serde_json::from_slice(&hit.body).unwrap())
        .collect();
    let header = |hit: &Seen, name: &str| {
        hit.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let timestamp: u64 = header(&hits[2], "x-terminal-v4-timestamp")
        .unwrap()
        .parse()
        .unwrap();
    let signed = signature_header(SECRET, timestamp, &hits[2].body);
    assert_eq!(
        (
            expected.iter().map(|e| e.1.clone()).collect::<Vec<_>>(),
            hits.len(),
            hits.iter().map(|h| h.path.clone()).collect::<Vec<_>>(),
            bodies[0]["text"].as_str().unwrap().contains("hunter2"),
            bodies[1]["content"].as_str().unwrap().contains("hunter2"),
            bodies[1]["allowed_mentions"]["parse"].clone(),
            header(&hits[2], "x-terminal-v4-signature"),
            header(&hits[2], "x-terminal-v4-delivery-id"),
            header(&hits[0], "x-terminal-v4-signature"),
            bodies[2]["deliveryId"] == serde_json::json!(expected[2].0.to_string()),
            stored.contains(SECRET)
                || stored.contains("127.0.0.1")
                || stored.contains("XXXXTOKENXXXX"),
        ),
        (
            vec![(Some(DeliveryStatus::Delivered), None); 3],
            3,
            vec![HOOK_PATH.to_owned(); 3],
            false,
            false,
            serde_json::json!([]),
            Some(signed),
            Some(expected[2].0.to_string()),
            None,
            true,
            false,
        )
    );
}

#[tokio::test]
async fn transient_failures_are_retried_with_backoff_then_delivered() {
    enable_loopback();
    let data = tempfile::tempdir().unwrap();
    let server = mock(vec![503, 429, 200]).await;
    let router = app(data.path(), "alice");
    configure_all(&router, &server).await;
    finished(data.path(), "alice", DeliveryTarget::Slack, "r");
    run_delivery(data.path()).await;
    assert_eq!(
        (outcome(data.path(), "alice"), server.hits().len()),
        ((Some(DeliveryStatus::Delivered), None), 3)
    );
}

#[tokio::test]
async fn exhausted_retries_and_hard_rejections_fail_without_leaking_the_url() {
    enable_loopback();
    let data = tempfile::tempdir().unwrap();
    let server = mock(vec![500, 500, 500, 400, 302]).await;
    let router = app(data.path(), "alice");
    configure_all(&router, &server).await;
    let mut results = Vec::new();
    for _ in 0..3 {
        finished(data.path(), "alice", DeliveryTarget::Webhook, "r");
        run_delivery(data.path()).await;
        results.push((outcome(data.path(), "alice"), server.hits().len()));
        let mut store = read_store(data.path(), "alice").unwrap();
        store.tasks.clear();
        write_store(data.path(), &store).unwrap();
    }
    let reason = "The delivery endpoint did not accept the message".to_owned();
    assert_eq!(
        results,
        vec![
            ((Some(DeliveryStatus::Failed), Some(reason.clone())), 3),
            ((Some(DeliveryStatus::Failed), Some(reason.clone())), 4),
            ((Some(DeliveryStatus::Failed), Some(reason)), 5),
        ]
    );
}

#[tokio::test]
async fn an_unconfigured_channel_is_skipped_and_sends_nothing() {
    enable_loopback();
    let data = tempfile::tempdir().unwrap();
    let server = mock(vec![]).await;
    let router = app(data.path(), "alice");
    call(
        &router,
        "PUT",
        "/api/workspace/delivery-channels/slack",
        serde_json::json!({ "url": server.url() }),
    )
    .await;
    finished(data.path(), "alice", DeliveryTarget::Discord, "r");
    run_delivery(data.path()).await;
    assert_eq!(
        (outcome(data.path(), "alice"), server.hits().len()),
        (
            (
                Some(DeliveryStatus::Skipped),
                Some("This delivery channel is not configured".to_owned())
            ),
            0
        )
    );
}

#[tokio::test]
async fn a_stored_private_target_is_refused_at_send_time() {
    let data = tempfile::tempdir().unwrap();
    let cipher = VaultCipher::load(data.path()).unwrap();
    let config = OwnerChannels {
        owner: "alice".into(),
        webhook: Some(Endpoint {
            url: cipher.encrypt("https://10.0.0.5/in").unwrap(),
            secret: Some(cipher.encrypt(SECRET).unwrap()),
        }),
        ..Default::default()
    };
    save(data.path(), &config).unwrap();
    let result = send_with_policy(
        data.path(),
        "alice",
        Channel::Webhook,
        Uuid::nil(),
        "x",
        Policy::default(),
    )
    .await;
    assert_eq!(result, Err(BLOCKED));
}

#[tokio::test]
async fn configuration_routes_are_owner_scoped_validated_and_never_echo_secrets() {
    enable_loopback();
    let data = tempfile::tempdir().unwrap();
    let alice = app(data.path(), "alice");
    let bob = app(data.path(), "bob");
    let put = |router: &Router, channel: &str, body: serde_json::Value| {
        let (router, uri) = (
            router.clone(),
            format!("/api/workspace/delivery-channels/{channel}"),
        );
        async move { call(&router, "PUT", &uri, body).await }
    };
    let private = put(
        &alice,
        "webhook",
        serde_json::json!({"url":"https://10.0.0.5/in","secret":SECRET}),
    )
    .await;
    let wrong_host = put(
        &alice,
        "slack",
        serde_json::json!({"url":"https://example.com/services/a"}),
    )
    .await;
    let no_secret = put(
        &alice,
        "webhook",
        serde_json::json!({"url":"https://example.com/in"}),
    )
    .await;
    let unknown = put(
        &alice,
        "telegram",
        serde_json::json!({"url":"https://example.com/in"}),
    )
    .await;
    let ok = put(
        &alice,
        "slack",
        serde_json::json!({"url":"https://hooks.slack.com/services/T0/B0/TOKENVALUE"}),
    )
    .await;
    let alice_view = call(
        &alice,
        "GET",
        "/api/workspace/delivery-channels",
        serde_json::json!({}),
    )
    .await;
    let bob_view = call(
        &bob,
        "GET",
        "/api/workspace/delivery-channels",
        serde_json::json!({}),
    )
    .await;
    let removed = call(
        &alice,
        "DELETE",
        "/api/workspace/delivery-channels/slack",
        serde_json::json!({}),
    )
    .await;
    let after = call(
        &alice,
        "GET",
        "/api/workspace/delivery-channels",
        serde_json::json!({}),
    )
    .await;
    let configured = |body: &str, channel: &str| {
        serde_json::from_str::<serde_json::Value>(body).unwrap()[channel]["configured"].clone()
    };
    assert_eq!(
        (
            private.0,
            wrong_host.0,
            no_secret.0,
            unknown.0,
            ok.0,
            configured(&alice_view.1, "slack"),
            alice_view.1.contains("TOKENVALUE") || ok.1.contains("TOKENVALUE"),
            configured(&bob_view.1, "slack"),
            removed.0,
            configured(&after.1, "slack"),
        ),
        (
            StatusCode::BAD_REQUEST,
            StatusCode::BAD_REQUEST,
            StatusCode::BAD_REQUEST,
            StatusCode::NOT_FOUND,
            StatusCode::OK,
            serde_json::json!(true),
            false,
            serde_json::json!(false),
            StatusCode::OK,
            serde_json::json!(false),
        )
    );
}

#[test]
fn delivery_targets_serialize_as_snake_case_and_old_telegram_records_load() {
    assert_eq!(
        (
            serde_json::to_value([
                DeliveryTarget::Telegram,
                DeliveryTarget::Slack,
                DeliveryTarget::Discord,
                DeliveryTarget::Webhook
            ])
            .unwrap(),
            serde_json::from_str::<DeliveryTarget>("\"telegram\"").unwrap(),
        ),
        (
            serde_json::json!(["telegram", "slack", "discord", "webhook"]),
            DeliveryTarget::Telegram
        )
    );
}
