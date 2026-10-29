use super::*;
use crate::{app, ApiState};
use axum::{body::Body, http::Request};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::BodyExt;
use openssl::{
    bn::BigNumContext,
    ec::{EcGroup, EcKey},
    hash::MessageDigest,
    nid::Nid,
    pkey::{PKey, Private},
    sign::Signer,
};
use serde_json::{json, Value};
use terminal_v4_core::AppConfig;
use tower::ServiceExt;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};
fn enc(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
fn bytes(value: &[u8]) -> Vec<u8> {
    let mut out = if value.len() < 24 {
        vec![0x40 + value.len() as u8]
    } else if value.len() < 256 {
        vec![0x58, value.len() as u8]
    } else {
        vec![0x59, (value.len() >> 8) as u8, value.len() as u8]
    };
    out.extend(value);
    out
}
fn client(kind: &str, options: &Value, origin: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"type":kind,"challenge":options["publicKey"]["challenge"],"origin":origin,"crossOrigin":false})).unwrap()
}
fn auth_data(flags: u8, counter: u32) -> Vec<u8> {
    let mut out = openssl::sha::sha256(b"localhost").to_vec();
    out.push(flags);
    out.extend(counter.to_be_bytes());
    out
}
fn cose_key(key: &PKey<Private>) -> Vec<u8> {
    let key = key.ec_key().unwrap();
    let mut ctx = BigNumContext::new().unwrap();
    let mut x = openssl::bn::BigNum::new().unwrap();
    let mut y = openssl::bn::BigNum::new().unwrap();
    key.public_key()
        .affine_coordinates_gfp(key.group(), &mut x, &mut y, &mut ctx)
        .unwrap();
    let mut cose = vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21];
    cose.extend(bytes(&x.to_vec_padded(32).unwrap()));
    cose.push(0x22);
    cose.extend(bytes(&y.to_vec_padded(32).unwrap()));

    cose
}
fn registration(options: &Value, key: &PKey<Private>) -> RegisterPublicKeyCredential {
    let cose = cose_key(key);
    let id = [0x41u8; 32];
    let mut auth = auth_data(0x45, 0);
    auth.extend([0; 16]);
    auth.extend(32u16.to_be_bytes());
    auth.extend(id);
    auth.extend(cose);
    let mut att = vec![
        0xa3, 0x63, b'f', b'm', b't', 0x64, b'n', b'o', b'n', b'e', 0x67, b'a', b't', b't', b'S',
        b't', b'm', b't', 0xa0, 0x68, b'a', b'u', b't', b'h', b'D', b'a', b't', b'a',
    ];
    att.extend(bytes(&auth));
    serde_json::from_value(json!({"id":enc(id),"rawId":enc(id),"type":"public-key","response":{"clientDataJSON":enc(client("webauthn.create",options,"http://localhost:3020")),"attestationObject":enc(att),"transports":["internal"]},"clientExtensionResults":{}})).unwrap()
}
fn assertion(options: &Value, key: &PKey<Private>, counter: u32) -> PublicKeyCredential {
    assertion_with_security_properties(options, key, counter, "http://localhost:3020", 0x05)
}
fn assertion_with_security_properties(
    options: &Value,
    key: &PKey<Private>,
    counter: u32,
    origin: &str,
    flags: u8,
) -> PublicKeyCredential {
    let client = client("webauthn.get", options, origin);
    let auth = auth_data(flags, counter);
    let mut signed = auth.clone();
    signed.extend(openssl::sha::sha256(&client));
    let mut signer = Signer::new(MessageDigest::sha256(), key).unwrap();
    signer.update(&signed).unwrap();
    let signature = signer.sign_to_vec().unwrap();
    serde_json::from_value(json!({"id":enc([0x41;32]),"rawId":enc([0x41;32]),"type":"public-key","response":{"clientDataJSON":enc(client),"authenticatorData":enc(auth),"signature":enc(signature),"userHandle":null},"clientExtensionResults":{}})).unwrap()
}
async fn request(
    state: &ApiState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Content-Type", "application/json");
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = app(state.clone())
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn key() -> PKey<Private> {
    PKey::from_ec_key(
        EcKey::generate(&EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap()).unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn overlapping_ceremonies_verify_independently_and_failed_assertions_preserve_pending_state()
{
    for reverse in [false, true] {
        let service = PasskeyService::new(&AppConfig::default()).unwrap();
        let key = key();
        let owner = "synthetic-owner";
        let registration_a = serde_json::to_value(
            service
                .begin_registration(owner, "fixture", &[])
                .await
                .unwrap(),
        )
        .unwrap();
        let registration_b = serde_json::to_value(
            service
                .begin_registration(owner, "fixture", &[])
                .await
                .unwrap(),
        )
        .unwrap();
        let passkey = service
            .complete_registration(owner, registration(&registration_a, &key))
            .await
            .unwrap();
        assert!(service
            .complete_registration(owner, registration(&registration_b, &key))
            .await
            .is_ok());
        assert!(service
            .complete_registration(owner, registration(&registration_a, &key))
            .await
            .is_err());
        let first = serde_json::to_value(
            service
                .begin_authentication(owner, std::slice::from_ref(&passkey))
                .await
                .unwrap(),
        )
        .unwrap();
        let second = serde_json::to_value(
            service
                .begin_authentication(owner, std::slice::from_ref(&passkey))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_ne!(
            first["publicKey"]["challenge"],
            second["publicKey"]["challenge"]
        );
        assert!(service
            .complete_authentication(owner, assertion(&first, &self::key(), 1))
            .await
            .is_err());
        let wrong_origin =
            assertion_with_security_properties(&first, &key, 1, "http://invalid.example", 0x05);
        assert!(service
            .complete_authentication(owner, wrong_origin)
            .await
            .is_err());
        let unverified =
            assertion_with_security_properties(&first, &key, 1, "http://localhost:3020", 0x01);
        assert!(service
            .complete_authentication(owner, unverified)
            .await
            .is_err());
        let mut malformed = assertion(&first, &key, 1);
        malformed.response.client_data_json = b"invalid client data".to_vec().into();
        assert!(service
            .complete_authentication(owner, malformed)
            .await
            .is_err());
        assert!(service
            .complete_authentication("different-owner", assertion(&first, &key, 1))
            .await
            .is_err());
        let (a, b) = if reverse {
            (&second, &first)
        } else {
            (&first, &second)
        };
        service
            .complete_authentication(owner, assertion(a, &key, 1))
            .await
            .unwrap();
        assert!(service
            .complete_authentication(owner, assertion(a, &key, 2))
            .await
            .is_err());
        service
            .complete_authentication(owner, assertion(b, &key, 2))
            .await
            .unwrap();
        assert!(service.pending.lock().await.is_empty());
    }
}

#[tokio::test]
async fn actual_router_preserves_passkey_ceremonies_persistence_and_username_policy() {
    let data = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: data.path().into(),
        jwt_secret: "synthetic-passkey-key".into(),
        ..AppConfig::default()
    };
    let state = ApiState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("synthetic", "synthetic-password")
        .unwrap();
    let auth = state
        .login("synthetic", "synthetic-password")
        .await
        .unwrap()
        .unwrap();
    let access = auth.tokens.access_token;
    let key = key();
    let (status, options) = request(
        &state,
        "POST",
        "/api/auth/passkey/register/begin",
        Some(&access),
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, record) = request(
        &state,
        "POST",
        "/api/auth/passkey/register/complete",
        Some(&access),
        json!({"credential":registration(&options,&key),"name":"Fixture authenticator"}),
    )
    .await;
    assert_eq!(status, 200);
    let state = ApiState::new(config.clone()).unwrap();
    let (status, list) = request(
        &state,
        "GET",
        "/api/auth/passkey/credentials",
        Some(&access),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, list["credentials"].as_array().unwrap().len()),
        (200, 1)
    );
    let mut options = Vec::new();
    for _ in 0..2 {
        let (status, challenge) = request(
            &state,
            "POST",
            "/api/auth/passkey/authenticate/begin",
            None,
            json!({"username":"synthetic"}),
        )
        .await;
        assert_eq!(status, 200);
        options.push(challenge);
    }
    let denied = ApiState::new(AppConfig {
        allowed_username: Some("another-user".into()),
        ..config
    })
    .unwrap();
    let (status, _) = request(
        &denied,
        "POST",
        "/api/auth/passkey/authenticate/begin",
        None,
        json!({"username":"synthetic"}),
    )
    .await;
    assert_eq!(status, 401);
    let native = {
        let conn = denied.lock_db().unwrap();
        db::list_passkeys(&conn, &user.id).unwrap()[0]
            .passkey
            .clone()
    };
    let denied_options = serde_json::to_value(
        denied
            .passkey_service()
            .begin_authentication(&user.id, &[native])
            .await
            .unwrap(),
    )
    .unwrap();
    let before: i64 = denied
        .lock_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM refresh_tokens", [], |r| r.get(0))
        .unwrap();
    let (status, _) = request(
        &denied,
        "POST",
        "/api/auth/passkey/authenticate/complete",
        None,
        json!({"username":"synthetic","credential":assertion(&denied_options,&key,1)}),
    )
    .await;
    assert_eq!(status, 401);
    let after: i64 = denied
        .lock_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM refresh_tokens", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        (after, denied.passkey_service().pending.lock().await.len()),
        (before, 1)
    );
    for (i, options) in options.iter().enumerate() {
        let (status, authenticated) = request(
            &state,
            "POST",
            "/api/auth/passkey/authenticate/complete",
            None,
            json!({"username":"synthetic","credential":assertion(options,&key,i as u32+1)}),
        )
        .await;
        assert_eq!(status, 200, "{authenticated}");
        assert_eq!(authenticated["user"]["id"], user.id);
        let (status, _) = request(
            &state,
            "GET",
            "/api/auth/me",
            authenticated["tokens"]["accessToken"].as_str(),
            Value::Null,
        )
        .await;
        assert_eq!(status, 200);
    }
    let (counter, used): (i64, Option<String>) = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT counter,last_used_at FROM passkey_credentials WHERE user_id=?",
            [&user.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counter, 2);
    assert!(used.is_some());
    let (status, _) = request(
        &state,
        "DELETE",
        &format!(
            "/api/auth/passkey/credentials/{}",
            record["id"].as_str().unwrap()
        ),
        Some(&access),
        Value::Null,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/auth/passkey/authenticate/begin",
            None,
            json!({"username":"synthetic"})
        )
        .await
        .0,
        400
    );
}

#[tokio::test]
async fn incompatible_legacy_rows_remain_intact_and_do_not_poison_native_registration() {
    let data = tempfile::tempdir().unwrap();
    let state = ApiState::new(AppConfig {
        data_dir: data.path().into(),
        ..AppConfig::default()
    })
    .unwrap();
    let user = state
        .create_local_user_for_test("synthetic", "synthetic-password")
        .unwrap();
    let access = state
        .login("synthetic", "synthetic-password")
        .await
        .unwrap()
        .unwrap()
        .tokens
        .access_token;
    let legacy = cose_key(&key());
    state.lock_db().unwrap().execute("INSERT INTO passkey_credentials(id,user_id,credential_id,public_key,created_at) VALUES(?,?,?,?,?)",rusqlite::params!["legacy",user.id,"legacy-credential",legacy.as_slice(),"2020-01-01"]).unwrap();
    let (status, body) = request(
        &state,
        "POST",
        "/api/auth/passkey/authenticate/begin",
        None,
        json!({"username":"synthetic"}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("register a new passkey"));
    let (status, options) = request(
        &state,
        "POST",
        "/api/auth/passkey/register/begin",
        Some(&access),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{options}");
    let key = key();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/auth/passkey/register/complete",
            Some(&access),
            json!({"credential":registration(&options,&key)})
        )
        .await
        .0,
        200
    );
    let (status, options) = request(
        &state,
        "POST",
        "/api/auth/passkey/authenticate/begin",
        None,
        json!({"username":"synthetic"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/auth/passkey/authenticate/complete",
            None,
            json!({"username":"synthetic","credential":assertion(&options,&key,1)})
        )
        .await
        .0,
        200
    );
    let stored: Vec<u8> = state
        .lock_db()
        .unwrap()
        .query_row(
            "SELECT public_key FROM passkey_credentials WHERE id='legacy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, legacy);
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/auth/passkey/credentials",
            Some(&access),
            Value::Null
        )
        .await
        .1["credentials"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn pending_attempt_limits_reject_new_begins_without_eviction_and_expiry_recovers_capacity() {
    let service = PasskeyService::new(&AppConfig::default()).unwrap();
    let key = key();
    let options = serde_json::to_value(
        service
            .begin_registration("bounded", "fixture", &[])
            .await
            .unwrap(),
    )
    .unwrap();
    let passkey = service
        .complete_registration("bounded", registration(&options, &key))
        .await
        .unwrap();
    let mut attempts = Vec::new();
    for _ in 0..MAX_PENDING_PER_USER {
        attempts.push(
            serde_json::to_value(
                service
                    .begin_authentication("bounded", std::slice::from_ref(&passkey))
                    .await
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    assert!(service
        .begin_authentication("bounded", std::slice::from_ref(&passkey))
        .await
        .unwrap_err()
        .contains("Too many pending"));
    let first = assertion(&attempts[0], &key, 1);
    let (a, b) = tokio::join!(
        service.complete_authentication("bounded", first.clone()),
        service.complete_authentication("bounded", first)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    {
        let mut pending = service.pending.lock().await;
        let expired_key = (
            "bounded".to_owned(),
            "authentication",
            client_challenge(
                assertion(&attempts[1], &key, 2)
                    .response
                    .client_data_json
                    .as_ref(),
            )
            .unwrap(),
        );
        match pending.get_mut(&expired_key).unwrap() {
            PendingChallenge::Authentication { expires_at, .. } => *expires_at = now_millis() - 1,
            _ => unreachable!(),
        }
    }
    assert!(service
        .complete_authentication("bounded", assertion(&attempts[1], &key, 2))
        .await
        .is_err());
    service
        .complete_authentication("bounded", assertion(&attempts[2], &key, 2))
        .await
        .unwrap();
    service
        .begin_authentication("bounded", std::slice::from_ref(&passkey))
        .await
        .unwrap();
    let mut pending = service.pending.lock().await;
    let template = pending.values().next().unwrap().clone();
    pending.clear();
    for index in 0..MAX_PENDING_CHALLENGES {
        pending.insert(
            (
                format!("capacity-{index}"),
                "authentication",
                vec![index as u8],
            ),
            template.clone(),
        );
    }
    drop(pending);
    assert!(service
        .begin_authentication("new-owner", std::slice::from_ref(&passkey))
        .await
        .unwrap_err()
        .contains("Too many pending"));
    assert_eq!(service.pending.lock().await.len(), MAX_PENDING_CHALLENGES);
    {
        let mut pending = service.pending.lock().await;
        for value in pending.values_mut() {
            match value {
                PendingChallenge::Authentication { expires_at, .. } => {
                    *expires_at = now_millis() - 1
                }
                _ => unreachable!(),
            }
        }
    }
    service
        .begin_authentication("new-owner", std::slice::from_ref(&passkey))
        .await
        .unwrap();
    assert_eq!(service.pending.lock().await.len(), 1);
}
