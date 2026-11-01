use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub(crate) const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const SKEW_SECONDS: u64 = 60;
const CACHE_LIMIT: usize = 32;

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct ServiceAccount {
    pub(crate) client_email: String,
    pub(crate) private_key: String,
    #[serde(default)]
    pub(crate) private_key_id: Option<String>,
    #[serde(default)]
    pub(crate) token_endpoint: String,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(crate) fn parse_key_file(raw: &str) -> Result<ServiceAccount, String> {
    let invalid =
        || "Service-account key must be a valid Google service-account JSON key".to_string();
    let value: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    if value["type"] != "service_account" {
        return Err(invalid());
    }
    let account = ServiceAccount {
        client_email: value["client_email"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned(),
        private_key: value["private_key"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned(),
        private_key_id: value["private_key_id"].as_str().map(str::to_owned),
        token_endpoint: String::new(),
    };
    if !account.client_email.contains('@')
        || account
            .client_email
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(invalid());
    }
    jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes())
        .map_err(|_| "Service-account private key is not a valid RSA PEM key".to_string())?;
    Ok(account)
}

pub(crate) fn assertion(account: &ServiceAccount, issued_at: u64) -> Result<String, String> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes())
        .map_err(|_| "Service-account private key is not a valid RSA PEM key".to_string())?;
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = account.private_key_id.clone();
    jsonwebtoken::encode(
        &header,
        &Claims {
            iss: &account.client_email,
            scope: SCOPE,
            aud: &account.token_endpoint,
            iat: issued_at,
            exp: issued_at + 3600,
        },
        &key,
    )
    .map_err(|_| "Could not sign the service-account assertion".into())
}

#[derive(Default)]
pub(crate) struct TokenCache {
    entries: HashMap<String, (String, u64)>,
}

impl TokenCache {
    pub(crate) fn get(&self, key: &str, now: u64) -> Option<String> {
        self.entries
            .get(key)
            .filter(|(_, expires_at)| *expires_at > now)
            .map(|(token, _)| token.clone())
    }

    pub(crate) fn put(&mut self, key: String, token: String, expires_at: u64, now: u64) {
        if self.entries.len() >= CACHE_LIMIT {
            self.entries.retain(|_, (_, expiry)| *expiry > now);
            if self.entries.len() >= CACHE_LIMIT {
                self.entries.clear();
            }
        }
        self.entries.insert(key, (token, expires_at));
    }
}

fn cache() -> &'static Mutex<TokenCache> {
    static CACHE: OnceLock<Mutex<TokenCache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

fn cache_key(account: &ServiceAccount) -> String {
    let mut digest = Sha256::new();
    for part in [
        &account.client_email,
        &account.token_endpoint,
        &account.private_key,
    ] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

pub(crate) fn expiry(issued_at: u64, expires_in: Option<u64>) -> u64 {
    issued_at + expires_in.unwrap_or(3600).clamp(SKEW_SECONDS + 1, 86_400) - SKEW_SECONDS
}

pub(crate) async fn access_token(
    client: &reqwest::Client,
    account: &ServiceAccount,
) -> Result<String, String> {
    let key = cache_key(account);
    let issued_at = now();
    if let Some(token) = cache().lock().ok().and_then(|c| c.get(&key, issued_at)) {
        return Ok(token);
    }
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
        .append_pair("assertion", &assertion(account, issued_at)?)
        .finish();
    let response = client
        .post(&account.token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|_| "Google token exchange failed; check connectivity".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Google token exchange returned HTTP {}; check the service-account key, its roles and that it is enabled.",
            status.as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Google token exchange was interrupted".to_string())?;
    if bytes.len() > 65_536 {
        return Err("Google token response is too large".into());
    }
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Google token exchange returned invalid JSON".to_string())?;
    let token = body["access_token"]
        .as_str()
        .filter(|token| {
            !token.is_empty() && token.len() <= 8192 && !token.chars().any(char::is_control)
        })
        .ok_or("Google token exchange returned no access token")?
        .to_owned();
    if let Ok(mut cache) = cache().lock() {
        cache.put(
            key,
            token.clone(),
            expiry(issued_at, body["expires_in"].as_u64()),
            issued_at,
        );
    }
    Ok(token)
}

#[cfg(test)]
pub(crate) mod test_keys {
    pub(crate) fn rsa_pair() -> (String, String) {
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let key = openssl::pkey::PKey::from_rsa(rsa).unwrap();
        (
            String::from_utf8(key.private_key_to_pem_pkcs8().unwrap()).unwrap(),
            String::from_utf8(key.public_key_to_pem().unwrap()).unwrap(),
        )
    }

    pub(crate) fn key_file(private_pem: &str) -> String {
        serde_json::json!({
            "type":"service_account","client_email":"agent@proj-123.iam.gserviceaccount.com",
            "private_key":private_pem,"private_key_id":"kid-1"
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, DecodingKey, Validation};

    #[test]
    fn assertion_is_an_rs256_jwt_with_google_claims_verifiable_with_the_public_key() {
        let (private, public) = test_keys::rsa_pair();
        let mut account = parse_key_file(&test_keys::key_file(&private)).unwrap();
        account.token_endpoint = "http://127.0.0.1:1/token".into();
        let jwt = assertion(&account, 1_700_000_000).unwrap();
        let header = jsonwebtoken::decode_header(&jwt).unwrap();
        assert_eq!(
            (header.alg, header.typ.as_deref(), header.kid.as_deref()),
            (Algorithm::RS256, Some("JWT"), Some("kid-1"))
        );
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_exp = false;
        validation.set_audience(&["http://127.0.0.1:1/token"]);
        let claims = jsonwebtoken::decode::<Value>(
            &jwt,
            &DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
            &validation,
        )
        .unwrap()
        .claims;
        assert_eq!(
            claims,
            serde_json::json!({
                "iss":"agent@proj-123.iam.gserviceaccount.com","scope":SCOPE,
                "aud":"http://127.0.0.1:1/token","iat":1_700_000_000u64,"exp":1_700_003_600u64
            })
        );
        assert!(!jwt.contains("PRIVATE"));
    }

    #[test]
    fn key_file_validation_rejects_wrong_type_missing_fields_and_bad_keys_without_echoing() {
        let (private, _) = test_keys::rsa_pair();
        let good: Value = serde_json::from_str(&test_keys::key_file(&private)).unwrap();
        for (field, value) in [
            ("type", serde_json::json!("authorized_user")),
            ("client_email", serde_json::json!("no-at-sign")),
            (
                "private_key",
                serde_json::json!(
                    "-----BEGIN PRIVATE KEY-----\nSECRETBITS\n-----END PRIVATE KEY-----\n"
                ),
            ),
            ("private_key", Value::Null),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            let error = parse_key_file(&bad.to_string()).err().unwrap();
            assert!(
                !error.contains("SECRETBITS") && !error.contains("no-at-sign"),
                "{error}"
            );
        }
        assert!(parse_key_file("not json").is_err());
    }

    #[test]
    fn cache_returns_tokens_only_until_expiry_and_stays_bounded() {
        let mut cache = TokenCache::default();
        cache.put("a".into(), "tok".into(), 1_000, 0);
        assert_eq!(cache.get("a", 999), Some("tok".into()));
        assert_eq!(cache.get("a", 1_000), None);
        assert_eq!(cache.get("missing", 0), None);
        for index in 0..(CACHE_LIMIT * 3) {
            cache.put(format!("k{index}"), "t".into(), 10_000, 0);
        }
        assert!(cache.entries.len() <= CACHE_LIMIT);
    }

    #[test]
    fn expiry_applies_a_skew_default_and_clamps_extremes() {
        assert_eq!(expiry(1_000, Some(3600)), 1_000 + 3600 - SKEW_SECONDS);
        assert_eq!(expiry(1_000, None), 1_000 + 3600 - SKEW_SECONDS);
        assert_eq!(expiry(1_000, Some(0)), 1_000 + 1);
        assert_eq!(expiry(1_000, Some(u64::MAX)), 1_000 + 86_400 - SKEW_SECONDS);
    }

    #[test]
    fn cache_key_does_not_contain_the_private_key_and_varies_by_endpoint() {
        let (private, _) = test_keys::rsa_pair();
        let mut account = parse_key_file(&test_keys::key_file(&private)).unwrap();
        account.token_endpoint = "http://a/token".into();
        let first = cache_key(&account);
        account.token_endpoint = "http://b/token".into();
        assert_ne!(first, cache_key(&account));
        assert_eq!(first.len(), 64);
        assert!(!first.contains("PRIVATE"));
    }
}
