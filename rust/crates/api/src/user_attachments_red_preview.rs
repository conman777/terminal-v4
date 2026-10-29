// SCRATCH TEST PREVIEW ONLY. Proposed local-owner API; no production implementation.
// Root must approve the envelope/status contract before applying this test-only module.
use super::*;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
const GIF: &str = "R0lGODdhAQABAIEAABE1WwAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==";
const BOUNDARY: &str = "v4-own-image-red-fixture";
const OWNER: &str = "image-red-owner";
const OTHER: &str = "image-red-other";
const JWT_SECRET: &str = "local-image-red-test-secret";

struct Harness {
    _data: tempfile::TempDir,
    _workspace: tempfile::TempDir,
    state: AppState,
    session: String,
}

impl Harness {
    async fn new(provider: &str, model: &str) -> Self {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: JWT_SECRET.into(),
            ..Default::default()
        })
        .unwrap();
        let session = state
            .structured_session_manager()
            .create_session(
                OWNER,
                workspace.path().to_str().unwrap(),
                Some(provider),
                Some(model),
                None,
            )
            .await
            .unwrap()
            .id;
        Self {
            _data: data,
            _workspace: workspace,
            state,
            session,
        }
    }

    fn uri(&self) -> String {
        format!("/api/structured/sessions/{}/attachments", self.session)
    }

    async fn request(
        &self,
        method: &str,
        uri: &str,
        owner: Option<&str>,
        content_type: &str,
        body: Body,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", content_type);
        if let Some(owner) = owner {
            request = request.header(
                "authorization",
                format!(
                    "Bearer {}",
                    crate::auth::issue_access_token(JWT_SECRET, owner, owner)
                ),
            );
        }
        app(self.state.clone())
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn upload(
        &self,
        owner: Option<&str>,
        upload_id: &str,
        mime: &str,
        bytes: &[u8],
    ) -> axum::response::Response {
        self.request(
            "POST",
            &self.uri(),
            owner,
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            Body::from(multipart(upload_id, mime, bytes)),
        )
        .await
    }

    async fn accepted_events(&self) -> usize {
        self.state
            .structured_session_manager()
            .get_session(OWNER, &self.session)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    terminal_v4_core::StructuredSessionEvent::UserMessageAccepted { .. }
                )
            })
            .count()
    }
}

fn multipart(upload_id: &str, mime: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = multipart_prefix(upload_id, mime).into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

fn multipart_prefix(upload_id: &str, mime: &str) -> String {
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"uploadId\"\r\n\r\n{upload_id}\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"pixel.{extension}\"\r\nContent-Type: {mime}\r\n\r\n")
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"unexpectedBody":String::from_utf8_lossy(&bytes)}))
}

fn typed_image_hash(mime: &str, bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"v4-image-v1\0");
    digest.update(mime.as_bytes());
    digest.update(b"\0");
    digest.update(bytes);
    hex::encode(digest.finalize())
}

fn padded_png(size: usize, text_byte: u8) -> Vec<u8> {
    let original = STANDARD.decode(PNG).unwrap();
    let payload_len = size.checked_sub(original.len() + 12).unwrap();
    assert!(payload_len >= 3);
    let mut chunk = b"tEXtv4\0".to_vec();
    chunk.resize(4 + payload_len, text_byte);
    let mut table = [0u32; 256];
    for (index, entry) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 == 0 {
                value >> 1
            } else {
                (value >> 1) ^ 0xedb8_8320
            };
        }
        *entry = value;
    }
    let mut crc = u32::MAX;
    for byte in &chunk {
        crc = (crc >> 8) ^ table[((crc ^ u32::from(*byte)) & 255) as usize];
    }
    let mut output = original[..original.len() - 12].to_vec();
    output.extend_from_slice(&(payload_len as u32).to_be_bytes());
    output.extend_from_slice(&chunk);
    output.extend_from_slice(&(!crc).to_be_bytes());
    output.extend_from_slice(&original[original.len() - 12..]);
    assert_eq!(output.len(), size);
    output
}

async fn ready(harness: &Harness, upload_id: &str) -> Value {
    let response = harness
        .upload(
            Some(OWNER),
            upload_id,
            "image/png",
            &STANDARD.decode(PNG).unwrap(),
        )
        .await;
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "a valid owned image must reach the new upload route, not a 404 or legacy path uploader"
    );
    let payload = json_body(response).await;
    assert_eq!(payload["status"], "ready");
    payload["attachment"].clone()
}

#[tokio::test]
async fn image_upload_red_owned_bytes_return_typed_descriptor_and_private_content_without_accepting_a_turn(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload_id = uuid::Uuid::new_v4().to_string();
    let image = ready(&h, &upload_id).await;
    let bytes = STANDARD.decode(PNG).unwrap();
    uuid::Uuid::parse_str(image["attachmentId"].as_str().unwrap()).unwrap();
    assert_eq!(image["artifactId"], typed_image_hash("image/png", &bytes));
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(image["bytes"], bytes.len());
    assert_eq!(image["name"], "pixel.png");
    for forbidden in ["path", "url", "data", "owner", "workspace", "apiKey"] {
        assert!(image.get(forbidden).is_none());
    }
    assert_eq!(h.accepted_events().await, 0, "upload is not Send");
    assert_eq!(
        h.upload(None, &uuid::Uuid::new_v4().to_string(), "image/png", &bytes)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let content = h
        .request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                image["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty(),
        )
        .await;
    assert_eq!(content.status(), StatusCode::OK);
    assert_eq!(content.headers()["content-type"], "image/png");
    assert_eq!(content.headers()["cache-control"], "private, no-store");
    assert_eq!(content.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        to_bytes(content.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .as_ref(),
        bytes.as_slice()
    );
}

#[tokio::test]
async fn image_upload_red_same_upload_uuid_is_idempotent_but_different_bytes_or_mime_conflict() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload_id = uuid::Uuid::new_v4().to_string();
    let first = ready(&h, &upload_id).await;
    let duplicate = h
        .upload(
            Some(OWNER),
            &upload_id,
            "image/png",
            &STANDARD.decode(PNG).unwrap(),
        )
        .await;
    assert_eq!(duplicate.status(), StatusCode::OK);
    assert_eq!(json_body(duplicate).await["attachment"], first);
    let changed = h
        .upload(
            Some(OWNER),
            &upload_id,
            "image/gif",
            &STANDARD.decode(GIF).unwrap(),
        )
        .await;
    assert_eq!(
        changed.status(),
        StatusCode::CONFLICT,
        "an existing upload identity cannot be rebound to different valid image bytes"
    );
}

#[tokio::test]
async fn image_upload_red_owner_and_session_isolation_covers_read_cancel_upload_and_forged_send() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let attachment_id = image["attachmentId"].as_str().unwrap();
    for (method, suffix) in [("GET", ""), ("GET", "/content"), ("DELETE", "")] {
        let response = h
            .request(
                method,
                &format!("{}/{attachment_id}{suffix}", h.uri()),
                Some(OTHER),
                "application/json",
                Body::empty(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    assert_eq!(
        h.upload(
            Some(OTHER),
            &uuid::Uuid::new_v4().to_string(),
            "image/png",
            &STANDARD.decode(PNG).unwrap()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let other_session = h
        .state
        .structured_session_manager()
        .create_session(
            OWNER,
            h._workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            None,
        )
        .await
        .unwrap()
        .id;
    let response = h.request("POST", &format!("/api/structured/sessions/{other_session}/attachments/send"), Some(OWNER), "application/json", Body::from(json!({"requestId":uuid::Uuid::new_v4(),"text":"foreign session reference","attachments":[image]}).to_string())).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(h.accepted_events().await, 0);
    let attempted_target = h
        .state
        .structured_session_manager()
        .get_session(OWNER, &other_session)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attempted_target.events.iter().filter(|event| matches!(event, terminal_v4_core::StructuredSessionEvent::UserMessageAccepted { .. })).count(), 0, "a rejected cross-session reference must not append acceptance in the attempted target before returning its error");
}

#[tokio::test]
async fn image_upload_red_mime_mismatch_and_uri_path_fields_are_rejected_without_a_turn() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    for (mime, bytes) in [
        ("image/jpeg", STANDARD.decode(PNG).unwrap()),
        ("image/svg+xml", b"<svg/>".to_vec()),
        ("image/png", vec![0, 1, 2]),
    ] {
        assert_eq!(
            h.upload(Some(OWNER), &uuid::Uuid::new_v4().to_string(), mime, &bytes)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for forbidden in ["path", "url", "workspace", "owner"] {
        let mut body = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{forbidden}\"\r\n\r\nfile:///synthetic/not-read\r\n").into_bytes();
        body.extend_from_slice(&multipart(
            &uuid::Uuid::new_v4().to_string(),
            "image/png",
            &STANDARD.decode(PNG).unwrap(),
        ));
        assert_eq!(
            h.request(
                "POST",
                &h.uri(),
                Some(OWNER),
                &format!("multipart/form-data; boundary={BOUNDARY}"),
                Body::from(body)
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(h.accepted_events().await, 0);
}

#[tokio::test]
async fn image_upload_red_oversized_chunked_body_stops_reading_before_consuming_the_tail() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let polls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = polls.clone();
    let prefix = multipart_prefix(&uuid::Uuid::new_v4().to_string(), "image/png").into_bytes();
    let original = STANDARD.decode(PNG).unwrap();
    let mut image_prefix = original[..original.len() - 12].to_vec();
    image_prefix.extend_from_slice(&(16_777_216u32).to_be_bytes());
    image_prefix.extend_from_slice(b"tEXt");
    let body = futures_util::stream::unfold(
        (0usize, prefix, image_prefix),
        move |(index, prefix, image_prefix)| {
            let observed = observed.clone();
            async move {
                if index == 0 {
                    return Some((
                        Ok::<_, std::io::Error>(prefix.clone()),
                        (1, prefix, image_prefix),
                    ));
                }
                if index > 256 {
                    return None;
                }
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut chunk = if index == 1 {
                    image_prefix.clone()
                } else {
                    Vec::new()
                };
                chunk.resize(65_536, 0);
                Some((Ok(chunk), (index + 1, prefix, image_prefix)))
            }
        },
    );
    let response = h
        .request(
            "POST",
            &h.uri(),
            Some(OWNER),
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            Body::from_stream(body),
        )
        .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(
        polls.load(std::sync::atomic::Ordering::SeqCst) <= 130,
        "streaming rejection must not first buffer all 16 MiB"
    );
    assert_eq!(h.accepted_events().await, 0);
}

#[tokio::test]
async fn image_upload_red_exact_per_file_limit_is_usable_and_combined_occurrences_are_bounded_before_acceptance(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let mut descriptors = Vec::new();
    for text_byte in [b'x', b'y'] {
        let bytes = padded_png(8 * 1024 * 1024, text_byte);
        let uploaded = h
            .upload(
                Some(OWNER),
                &uuid::Uuid::new_v4().to_string(),
                "image/png",
                &bytes,
            )
            .await;
        assert_eq!(
            uploaded.status(),
            StatusCode::CREATED,
            "the advertised 8 MiB limit must not actually be the extractor's smaller default"
        );
        let descriptor = json_body(uploaded).await["attachment"].clone();
        assert_eq!(descriptor["bytes"], bytes.len());
        assert_eq!(
            descriptor["artifactId"],
            typed_image_hash("image/png", &bytes)
        );
        descriptors.push(descriptor);
    }
    assert_eq!(
        h.upload(
            Some(OWNER),
            &uuid::Uuid::new_v4().to_string(),
            "image/png",
            &padded_png(8 * 1024 * 1024 + 1, b'x')
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    descriptors.push(ready(&h, &uuid::Uuid::new_v4().to_string()).await);
    assert_ne!(
        descriptors[0]["attachmentId"],
        descriptors[1]["attachmentId"]
    );
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"do not exceed the combined decoded image budget","attachments":descriptors});
    assert_eq!(
        h.request(
            "POST",
            &format!("{}/send", h.uri()),
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.accepted_events().await,
        0,
        "two8MiB images plus any image exceed the combined decoded budget"
    );
}

#[tokio::test]
async fn image_upload_red_cancel_is_idempotent_and_prevents_late_same_identity_republication() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload_id = uuid::Uuid::new_v4().to_string();
    let image = ready(&h, &upload_id).await;
    let uri = format!("{}/{}", h.uri(), image["attachmentId"].as_str().unwrap());
    for _ in 0..2 {
        assert_eq!(
            h.request(
                "DELETE",
                &uri,
                Some(OWNER),
                "application/json",
                Body::empty()
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(
        h.upload(
            Some(OWNER),
            &upload_id,
            "image/png",
            &STANDARD.decode(PNG).unwrap()
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.request(
            "GET",
            &(uri + "/content"),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::GONE
    );
    assert_eq!(h.accepted_events().await, 0);
}

#[tokio::test]
async fn image_upload_red_text_only_and_unknown_models_reject_user_images_before_acceptance() {
    for (provider, model) in [
        ("deepseek", "deepseek-v4-pro"),
        ("actual", "actual/test-model"),
    ] {
        let h = Harness::new(provider, model).await;
        let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
        let response = h.request("POST", &format!("/api/structured/sessions/{}/attachments/send", h.session), Some(OWNER), "application/json", Body::from(json!({"requestId":uuid::Uuid::new_v4(),"text":"do not send text alone","attachments":[image]}).to_string())).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(h.accepted_events().await, 0, "known-false and unknown image capability must be rejected before accepted event/inference");
    }
}

#[tokio::test]
async fn image_upload_red_image_only_acceptance_and_lookup_bind_exact_manifest_and_preserve_history_pins(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let request_id = uuid::Uuid::new_v4().to_string();
    let input = json!({"text":"","attachments":[image.clone()]});
    let body = json!({"requestId":request_id,"text":"","attachments":[image.clone()]});
    let route = format!("/api/structured/sessions/{}/attachments/send", h.session);
    let sent = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(
        sent.status(),
        StatusCode::ACCEPTED,
        "an image-only message is not an empty prompt"
    );
    let first = json_body(sent).await;
    assert_eq!(
        first["input"], input,
        "the receipt must bind text plus the complete ordered descriptor"
    );
    let lookup = h
        .request(
            "GET",
            &format!(
                "/api/structured/sessions/{}/requests/{request_id}",
                h.session
            ),
            Some(OWNER),
            "application/json",
            Body::empty(),
        )
        .await;
    assert_eq!(lookup.status(), StatusCode::OK);
    let looked_up = json_body(lookup).await;
    for key in ["requestId", "messageId", "turnId", "acceptedSeq", "input"] {
        assert_eq!(looked_up[key], first[key]);
    }
    let again = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(again.status(), StatusCode::ACCEPTED);
    assert_eq!(json_body(again).await["turnId"], first["turnId"]);
    assert_eq!(h.accepted_events().await, 1);
    let mut changed = body;
    changed["attachments"][0]["name"] = json!("changed-name.png");
    assert_eq!(
        h.request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(changed.to_string())
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let uri = format!("{}/{}", h.uri(), image["attachmentId"].as_str().unwrap());
    assert_eq!(
        h.request(
            "DELETE",
            &uri,
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        h.request(
            "GET",
            &(uri + "/content"),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK,
        "release of staging cannot delete accepted image history"
    );
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}

#[tokio::test]
async fn image_upload_red_unicode_order_hash_owner_and_restart_lookup_bind_the_accepted_input() {
    for (raw, canonical) in [
        (
            " \tCafe\u{301}\r\nsnow \u{2603}\u{a0}\n",
            "Cafe\u{301}\nsnow \u{2603}",
        ),
        (
            "\u{85}Cafe\u{301}\r\nsnow \u{2603}\u{85}",
            "Cafe\u{301}\nsnow \u{2603}",
        ),
        (
            "\u{feff}Cafe\u{301}\r\nsnow \u{2603}\u{feff}",
            "\u{feff}Cafe\u{301}\nsnow \u{2603}\u{feff}",
        ),
        (
            "\u{85}\u{feff}Cafe\u{301}\r\nsnow \u{2603}\u{feff}\u{85}",
            "\u{feff}Cafe\u{301}\nsnow \u{2603}\u{feff}",
        ),
        (
            "\u{feff}\u{85}Cafe\u{301}\r\nsnow \u{2603}\u{85}\u{feff}",
            "\u{feff}\u{85}Cafe\u{301}\nsnow \u{2603}\u{85}\u{feff}",
        ),
    ] {
        let h = Harness::new("deepseek", "deepseek-v4-flash").await;
        let first = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
        let second = h
            .upload(
                Some(OWNER),
                &uuid::Uuid::new_v4().to_string(),
                "image/gif",
                &STANDARD.decode(GIF).unwrap(),
            )
            .await;
        assert_eq!(second.status(), StatusCode::CREATED);
        let second = json_body(second).await["attachment"].clone();
        assert_ne!(first["attachmentId"], second["attachmentId"]);
        let request_id = uuid::Uuid::new_v4().to_string();
        let body =
            json!({"requestId":request_id,"text":raw,"attachments":[first.clone(),second.clone()]});
        let expected_input = json!({"text":canonical,"attachments":[first.clone(),second.clone()]});
        let route = format!("{}/send", h.uri());
        let accepted = h
            .request(
                "POST",
                &route,
                Some(OWNER),
                "application/json",
                Body::from(body.to_string()),
            )
            .await;
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
        let original_receipt = json_body(accepted).await;
        assert_eq!(original_receipt["input"], expected_input, "preserve decomposed Unicode; use existing CRLF/edge-whitespace normalization, never NFC");
        let mut reordered = body.clone();
        reordered["attachments"] = json!([second, first]);
        let mut changed_hash = body.clone();
        changed_hash["attachments"][0]["artifactId"] = json!("f".repeat(64));
        let mut changed_unicode = body.clone();
        changed_unicode["text"] = json!("Caf\u{e9}\nsnow \u{2603}");
        for changed in [reordered, changed_hash, changed_unicode] {
            assert_eq!(
                h.request(
                    "POST",
                    &route,
                    Some(OWNER),
                    "application/json",
                    Body::from(changed.to_string())
                )
                .await
                .status(),
                StatusCode::CONFLICT
            );
        }
        assert_eq!(
            h.request(
                "POST",
                &route,
                Some(OTHER),
                "application/json",
                Body::from(body.to_string())
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        let lookup = format!(
            "/api/structured/sessions/{}/requests/{request_id}",
            h.session
        );
        assert_eq!(
            h.request(
                "GET",
                &lookup,
                Some(OTHER),
                "application/json",
                Body::empty()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(h.accepted_events().await, 1);
        h.state
            .structured_session_manager()
            .shutdown()
            .await
            .unwrap();
        let restarted = AppState::new(terminal_v4_core::AppConfig {
            data_dir: h._data.path().into(),
            jwt_secret: JWT_SECRET.into(),
            ..Default::default()
        })
        .unwrap();
        let response = app(restarted.clone())
            .oneshot(
                Request::builder()
                    .uri(&lookup)
                    .header(
                        "authorization",
                        format!(
                            "Bearer {}",
                            crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER)
                        ),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let restored = json_body(response).await;
        for key in ["requestId", "turnId", "messageId", "acceptedSeq", "input"] {
            assert_eq!(restored[key], original_receipt[key]);
        }
        restarted
            .structured_session_manager()
            .shutdown()
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn image_upload_red_deleting_one_session_hides_its_content_and_preserves_another_session() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let first = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let second_session = h
        .state
        .structured_session_manager()
        .create_session(
            OWNER,
            h._workspace.path().to_str().unwrap(),
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            None,
        )
        .await
        .unwrap()
        .id;
    let second_route = format!("/api/structured/sessions/{second_session}/attachments");
    let second = h
        .request(
            "POST",
            &second_route,
            Some(OWNER),
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            Body::from(multipart(
                &uuid::Uuid::new_v4().to_string(),
                "image/png",
                &STANDARD.decode(PNG).unwrap(),
            )),
        )
        .await;
    assert_eq!(second.status(), StatusCode::CREATED);
    let second = json_body(second).await["attachment"].clone();
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/api/structured/sessions/{}", h.session),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                first["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{second_route}/{}/content",
                second["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn image_upload_red_text_only_websocket_rejects_images_instead_of_silently_accepting_only_text(
) {
    use futures_util::{SinkExt, StreamExt};
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app(h.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let token = crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER);
    let request_id = uuid::Uuid::new_v4().to_string();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/api/structured/sessions/{}/ws?token={token}",
        h.session
    ))
    .await
    .unwrap();
    socket.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"message","requestId":request_id,"text":"never strip this image","attachments":[{"attachmentId":"11111111-1111-4111-8111-111111111111","artifactId":"a".repeat(64),"mimeType":"image/png","bytes":67,"name":"fixture.png"}]}).to_string().into())).await.unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(frame) = socket.next().await {
            if let Ok(text) = frame.unwrap().into_text() {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["requestId"] == request_id
                        && matches!(
                            value["type"].as_str(),
                            Some("command_receipt" | "command_rejected")
                        )
                    {
                        return value;
                    }
                }
            }
        }
        json!(null)
    })
    .await;
    let _ = socket.close(None).await;
    server.abort();
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
    assert_eq!(reply.unwrap()["type"], "command_rejected");
    assert_eq!(h.accepted_events().await, 0);
}

#[tokio::test]
async fn image_upload_red_old_http_text_routes_keep_rejecting_an_attachment_field_without_acceptance(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    for action in ["message", "input"] {
        let mut body = json!({"requestId":uuid::Uuid::new_v4(),"text":"never silently strip images","attachments":[]});
        if action == "input" {
            body["fallbackToMessage"] = json!(true);
        }
        let status = h
            .request(
                "POST",
                &format!("/api/structured/sessions/{}/{action}", h.session),
                Some(OWNER),
                "application/json",
                Body::from(body.to_string()),
            )
            .await
            .status();
        assert!(matches!(status, StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY), "retain existing typed JSON rejection without forcing an unrelated error-status migration");
    }
    assert_eq!(h.accepted_events().await, 0);
}

#[test]
fn image_upload_red_all_new_routes_remain_denied_for_paired_capabilities() {
    let mut transfer_only = crate::remote_permissions::Capabilities::observer();
    transfer_only.transfer = true;
    for capabilities in [
        crate::remote_permissions::Capabilities::operator(),
        crate::remote_permissions::Capabilities::observer(),
        transfer_only,
    ] {
        for (method, path) in [
            ("POST", "/api/structured/sessions/ss-fixture/attachments"),
            ("POST", "/api/structured/sessions/ss-fixture/attachments/send"),
            ("GET", "/api/structured/sessions/ss-fixture/attachments/11111111-1111-4111-8111-111111111111"),
            ("GET", "/api/structured/sessions/ss-fixture/attachments/11111111-1111-4111-8111-111111111111/content"),
            ("DELETE", "/api/structured/sessions/ss-fixture/attachments/11111111-1111-4111-8111-111111111111"),
        ] { assert!(!capabilities.allows_http(method, path), "new owner-only attachment route must not inherit paired permission: {method} {path}"); }
    }
}

#[tokio::test]
async fn image_upload_red_same_uuid_same_mime_and_same_size_cannot_rebind_different_valid_png_bytes(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload_id = uuid::Uuid::new_v4().to_string();
    let original = padded_png(256, b'x');
    let replacement = padded_png(256, b'y');
    assert_eq!(original.len(), replacement.len());
    assert_ne!(original, replacement);
    assert_ne!(
        typed_image_hash("image/png", &original),
        typed_image_hash("image/png", &replacement)
    );
    let response = h
        .upload(Some(OWNER), &upload_id, "image/png", &original)
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let descriptor = json_body(response).await["attachment"].clone();
    assert_eq!(
        descriptor["artifactId"],
        typed_image_hash("image/png", &original)
    );
    let changed = h
        .upload(Some(OWNER), &upload_id, "image/png", &replacement)
        .await;
    assert_eq!(
        changed.status(),
        StatusCode::CONFLICT,
        "MIME/name/size equality cannot authorize different bytes under the same upload UUID"
    );
    let unchanged = h
        .request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                descriptor["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty(),
        )
        .await;
    assert_eq!(unchanged.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(unchanged.into_body(), 1024)
            .await
            .unwrap()
            .as_ref(),
        original.as_slice()
    );
    assert_eq!(h.accepted_events().await, 0);
}

// B1/B2/B3 additions, authored before the user-image production implementation.
// These tests exercise the real router; registry edits below are explicit fixture
// clock/failure injection inside the generated data directory, never user files.
fn image_red_registry_path(h: &Harness) -> std::path::PathBuf {
    // Session creation canonicalizes its workspace; temporary /var aliases must match that authoritative scope.
    let workspace = h._workspace.path().canonicalize().unwrap();
    h._data
        .path()
        .join("v4-user-image-staging")
        .join(hex::encode(Sha256::digest(OWNER.as_bytes())))
        .join(hex::encode(Sha256::digest(
            crate::session_search::normalize_workspace_path(workspace.to_str().unwrap()).as_bytes(),
        )))
        .join(crate::structured::engine_session_id(&h.session).unwrap())
        .join("registry.json")
}
fn image_red_expire_staging(h: &Harness, attachment_id: &str) {
    let path = image_red_registry_path(h);
    let mut registry: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let entry = registry["entries"]
        .as_object_mut()
        .unwrap()
        .get_mut(attachment_id)
        .unwrap();
    entry["createdAt"] = json!(0);
    entry["expiresAt"] = json!(1);
    std::fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
}
#[tokio::test]
async fn image_upload_red_b1_nine_references_are_rejected_but_eight_ordered_occurrences_are_accepted(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let route = format!("{}/send", h.uri());
    let body =
        json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":vec![image.clone();9]});
    assert_eq!(
        h.request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(h.accepted_events().await, 0);
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":vec![image;8]});
    let response = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(
        json_body(response).await["input"]["attachments"],
        body["attachments"]
    );
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}
#[tokio::test]
async fn image_upload_red_b1_duplicate_reference_occurrences_still_count_toward_decoded_budget() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let bytes = padded_png(8 * 1024 * 1024, b'q');
    let response = h
        .upload(
            Some(OWNER),
            &uuid::Uuid::new_v4().to_string(),
            "image/png",
            &bytes,
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let image = json_body(response).await["attachment"].clone();
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"not deduped for inference budget","attachments":vec![image;3]});
    assert_eq!(
        h.request(
            "POST",
            &format!("{}/send", h.uri()),
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(h.accepted_events().await, 0);
}
#[tokio::test]
async fn image_upload_red_b2_descriptor_and_strict_envelope_tampering_never_accepts_partial_input()
{
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    for (field, value) in [
        ("artifactId", json!("f".repeat(64))),
        ("mimeType", json!("image/gif")),
        ("bytes", json!(1)),
        ("name", json!("other.png")),
        ("path", json!("file:///never-read")),
        ("url", json!("https://invalid.example/never-fetch")),
    ] {
        let mut changed = image.clone();
        changed[field] = value;
        let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"must not strip bad image","attachments":[image.clone(),changed]});
        assert_eq!(
            h.request(
                "POST",
                &format!("{}/send", h.uri()),
                Some(OWNER),
                "application/json",
                Body::from(body.to_string())
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST,
            "descriptor {field}"
        );
        assert_eq!(h.accepted_events().await, 0);
    }
    let body =
        json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":[image],"owner":OWNER});
    assert_eq!(
        h.request(
            "POST",
            &format!("{}/send", h.uri()),
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(h.accepted_events().await, 0);
}
#[tokio::test]
async fn image_upload_red_b2_failed_accepted_snapshot_keeps_staging_and_retry_identity_without_acceptance(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let snapshot = h
        ._data
        .path()
        .join("structured-sessions")
        .join(hex::encode(Sha256::digest(OWNER.as_bytes())))
        .join(format!("{}.json", h.session));
    let prior = std::fs::read(&snapshot).unwrap();
    std::fs::remove_file(&snapshot).unwrap();
    std::fs::create_dir(&snapshot).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let body = json!({"requestId":request,"text":"","attachments":[image.clone()]});
    let route = format!("{}/send", h.uri());
    assert_eq!(
        h.request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(h.accepted_events().await, 0);
    let lookup = format!("/api/structured/sessions/{}/requests/{request}", h.session);
    assert_eq!(
        h.request(
            "GET",
            &lookup,
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                image["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    std::fs::remove_dir(&snapshot).unwrap();
    std::fs::write(&snapshot, prior).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let accepted = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    assert_eq!(
        json_body(accepted).await["input"],
        json!({"text":"","attachments":[image]})
    );
    assert_eq!(h.accepted_events().await, 1);
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}
#[tokio::test]
async fn image_upload_red_b2_corrupt_registry_fails_closed_and_cannot_publish_an_accepted_event() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let path = image_red_registry_path(&h);
    let prior = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"{broken").unwrap();
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":[image.clone()]});
    assert_eq!(
        h.request(
            "POST",
            &format!("{}/send", h.uri()),
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(h.accepted_events().await, 0);
    assert_eq!(
        h.upload(
            Some(OWNER),
            &uuid::Uuid::new_v4().to_string(),
            "image/png",
            &STANDARD.decode(PNG).unwrap()
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    std::fs::write(path, prior).unwrap();
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                image["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
}
#[cfg(unix)]
#[tokio::test]
async fn image_upload_red_b2_staged_symlink_cannot_read_or_accept_a_substituted_file() {
    use std::os::unix::fs::symlink;
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let dir = image_red_registry_path(&h).parent().unwrap().to_path_buf();
    let staged = dir.join(format!("{}.png", image["artifactId"].as_str().unwrap()));
    let target = h._data.path().join("synthetic-never-read-target");
    std::fs::write(&target, b"synthetic private sentinel").unwrap();
    std::fs::remove_file(&staged).unwrap();
    symlink(&target, &staged).unwrap();
    let read = h
        .request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                image["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty(),
        )
        .await;
    assert_eq!(read.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":[image]});
    assert_eq!(
        h.request(
            "POST",
            &format!("{}/send", h.uri()),
            Some(OWNER),
            "application/json",
            Body::from(body.to_string())
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(h.accepted_events().await, 0);
    assert_eq!(
        std::fs::read(target).unwrap(),
        b"synthetic private sentinel"
    );
}
#[tokio::test]
async fn image_upload_red_b3_expired_unaccepted_bytes_are_collected_but_tombstone_and_other_ready_image_survive(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload = uuid::Uuid::new_v4().to_string();
    let image = ready(&h, &upload).await;
    let fresh = h
        .upload(
            Some(OWNER),
            &uuid::Uuid::new_v4().to_string(),
            "image/gif",
            &STANDARD.decode(GIF).unwrap(),
        )
        .await;
    assert_eq!(fresh.status(), StatusCode::CREATED);
    let fresh = json_body(fresh).await["attachment"].clone();
    image_red_expire_staging(&h, image["attachmentId"].as_str().unwrap());
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                image["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::GONE
    );
    assert!(!image_red_registry_path(&h)
        .parent()
        .unwrap()
        .join(format!("{}.png", image["artifactId"].as_str().unwrap()))
        .exists());
    assert_eq!(
        h.request(
            "GET",
            &format!(
                "{}/{}/content",
                h.uri(),
                fresh["attachmentId"].as_str().unwrap()
            ),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        h.upload(
            Some(OWNER),
            &upload,
            "image/png",
            &STANDARD.decode(PNG).unwrap()
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(h.accepted_events().await, 0);
}
#[tokio::test]
async fn image_upload_red_b3_expired_cancelled_accepted_image_and_same_send_receipt_remain_pinned()
{
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let image = ready(&h, &uuid::Uuid::new_v4().to_string()).await;
    let body = json!({"requestId":uuid::Uuid::new_v4(),"text":"","attachments":[image.clone()]});
    let route = format!("{}/send", h.uri());
    let response = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let receipt = json_body(response).await;
    image_red_expire_staging(&h, image["attachmentId"].as_str().unwrap());
    let uri = format!("{}/{}", h.uri(), image["attachmentId"].as_str().unwrap());
    assert_eq!(
        h.request(
            "DELETE",
            &uri,
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        h.request(
            "GET",
            &(uri + "/content"),
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    let response = h
        .request(
            "POST",
            &route,
            Some(OWNER),
            "application/json",
            Body::from(body.to_string()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let duplicate = json_body(response).await;
    for key in ["requestId", "turnId", "messageId", "acceptedSeq", "input"] {
        assert_eq!(duplicate[key], receipt[key]);
    }
    assert_eq!(h.accepted_events().await, 1);
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}
#[tokio::test]
async fn image_upload_red_b3_cancel_tombstone_survives_restart_and_blocks_late_upload_success() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload = uuid::Uuid::new_v4().to_string();
    let image = ready(&h, &upload).await;
    let uri = format!("{}/{}", h.uri(), image["attachmentId"].as_str().unwrap());
    assert_eq!(
        h.request(
            "DELETE",
            &uri,
            Some(OWNER),
            "application/json",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
    let restarted = AppState::new(terminal_v4_core::AppConfig {
        data_dir: h._data.path().into(),
        jwt_secret: JWT_SECRET.into(),
        ..Default::default()
    })
    .unwrap();
    let response = app(restarted.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(h.uri())
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER)
                    ),
                )
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={BOUNDARY}"),
                )
                .body(Body::from(multipart(
                    &upload,
                    "image/png",
                    &STANDARD.decode(PNG).unwrap(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = app(restarted.clone())
        .oneshot(
            Request::builder()
                .uri(format!("{uri}/content"))
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER)
                    ),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    restarted
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}

#[tokio::test]
async fn image_upload_red_animated_gif_is_rejected_without_silent_frame_selection() {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let still = STANDARD.decode(GIF).unwrap();
    let frame = still.iter().position(|byte| *byte == 0x2c).unwrap();
    let mut animated = still[..still.len() - 1].to_vec();
    animated.extend_from_slice(&still[frame..still.len() - 1]);
    animated.push(0x3b);
    assert_eq!(h.upload(Some(OWNER),&uuid::Uuid::new_v4().to_string(),"image/gif",&animated).await.status(),StatusCode::BAD_REQUEST,"the first user-image slice supports still images and must not silently choose one GIF frame");
    assert_eq!(h.accepted_events().await, 0);
}

#[tokio::test]
async fn image_upload_red_cancel_before_registration_survives_restart_and_blocks_a_late_initial_upload(
) {
    let h = Harness::new("deepseek", "deepseek-v4-flash").await;
    let upload = uuid::Uuid::new_v4().to_string();
    let uri = format!("{}/{}", h.uri(), upload);
    assert_eq!(h.request("DELETE",&uri,Some(OWNER),"application/json",Body::empty()).await.status(),StatusCode::NO_CONTENT,"cancellation must reserve an owned tombstone even while the streamed upload has not yet registered");
    h.state
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
    let restarted = AppState::new(terminal_v4_core::AppConfig {
        data_dir: h._data.path().into(),
        jwt_secret: JWT_SECRET.into(),
        ..Default::default()
    })
    .unwrap();
    let response = app(restarted.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(h.uri())
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER)
                    ),
                )
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={BOUNDARY}"),
                )
                .body(Body::from(multipart(
                    &upload,
                    "image/png",
                    &STANDARD.decode(PNG).unwrap(),
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = app(restarted.clone())
        .oneshot(
            Request::builder()
                .uri(format!("{uri}/content"))
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        crate::auth::issue_access_token(JWT_SECRET, OWNER, OWNER)
                    ),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    assert_eq!(
        restarted
            .structured_session_manager()
            .get_session(OWNER, &h.session)
            .await
            .unwrap()
            .unwrap()
            .events
            .iter()
            .filter(|event| matches!(
                event,
                terminal_v4_core::StructuredSessionEvent::UserMessageAccepted { .. }
            ))
            .count(),
        0
    );
    restarted
        .structured_session_manager()
        .shutdown()
        .await
        .unwrap();
}
