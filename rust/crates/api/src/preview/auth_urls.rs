use crate::{auth::AuthenticatedUser, state::AppState};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use url::Url;

#[derive(Serialize, Deserialize)]
struct ResourceClaims {
    sub: String,
    username: String,
    exp: usize,
    token_kind: String,
    #[serde(default)]
    generation: i64,
    #[serde(default)]
    auth_protocol: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default)]
    jti: String,
    prefix: String,
    root: Option<String>,
    #[serde(default)]
    dependency_depth: usize,
    #[serde(default)]
    controller_origin: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewController {
    pub(crate) origin: String,
    pub(crate) expires_at: usize,
}

pub(crate) fn normalized_controller_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    (matches!(parsed.scheme(), "http" | "https")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/"
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && parsed.origin().ascii_serialization() == value)
        .then(|| value.to_owned())
}

pub(crate) fn controller_resource_token(
    state: &AppState,
    owner: &str,
    prefix: &str,
    origin: &str,
) -> Option<String> {
    crate::auth::authenticate_local_token(state, owner).ok()?;
    let origin = normalized_controller_origin(origin)?;
    let token = resource_token(state, owner, prefix)?;
    let mut claims = resource_claims(state, &token).ok()?;
    claims.controller_origin = Some(origin);
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config().jwt_secret.as_bytes()),
    )
    .ok()
}

pub(crate) fn resource_controller(
    state: &AppState,
    token: &str,
    prefix: &str,
) -> Option<PreviewController> {
    let claims = resource_claims(state, token).ok()?;
    authenticate_resource_token(state, token, "GET", prefix).ok()?;
    if claims.prefix != prefix || claims.root.is_some() {
        return None;
    }
    Some(PreviewController {
        origin: normalized_controller_origin(claims.controller_origin.as_deref()?)?,
        expires_at: claims.exp,
    })
}

#[derive(Deserialize)]
struct ParentClaims {
    exp: usize,
    #[serde(default)]
    generation: i64,
    #[serde(default)]
    auth_protocol: i64,
    #[serde(default)]
    session_id: Option<String>,
}

fn resource_claims(state: &AppState, token: &str) -> Result<ResourceClaims, String> {
    let claims = decode::<ResourceClaims>(
        token,
        &DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| "Invalid preview resource credential")?
    .claims;
    if claims.token_kind != "preview-resource" {
        return Err("Invalid preview resource credential".into());
    }
    Ok(claims)
}

pub(crate) fn authenticate_resource_token(
    state: &AppState,
    token: &str,
    method: &str,
    path: &str,
) -> Result<AuthenticatedUser, String> {
    if !matches!(method, "GET" | "HEAD") {
        return Err("Preview resource credentials are read-only".into());
    }
    let claims = resource_claims(state, token)?;
    state.validate_auth_claims(
        &claims.sub,
        claims.generation,
        claims.auth_protocol,
        claims.session_id.as_deref(),
    )?;
    if !(path == claims.prefix
        || (claims.root.is_none()
            && !claims.prefix.ends_with("/api/preview")
            && path
                .strip_prefix(&claims.prefix)
                .is_some_and(|rest| rest.starts_with('/'))))
        || state
            .config()
            .allowed_username
            .as_deref()
            .is_some_and(|username| username != claims.username)
    {
        return Err("Preview resource credential is outside its scope".into());
    }
    crate::auth::runtime_identity(
        state,
        AuthenticatedUser {
            user_id: claims.sub,
            username: claims.username,
        },
    )
}

pub(crate) fn resource_token(state: &AppState, parent: &str, prefix: &str) -> Option<String> {
    resource_token_for_root(state, parent, prefix, None)
}

pub(crate) fn resource_token_for_root(
    state: &AppState,
    parent: &str,
    prefix: &str,
    root: Option<&str>,
) -> Option<String> {
    if let Ok(claims) = resource_claims(state, parent) {
        authenticate_resource_token(state, parent, "GET", prefix).ok()?;
        return (claims.prefix == prefix && claims.root.as_deref() == root)
            .then(|| parent.to_string());
    }
    let user = crate::auth::authenticate_runtime_preview_token(state, parent, "/preview/")
        .ok()
        .or_else(|| crate::auth::authenticate_local_token(state, parent).ok())?;
    let parent_claims = decode::<ParentClaims>(
        parent,
        &DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()?
    .claims;
    encode(
        &Header::default(),
        &ResourceClaims {
            sub: user.user_id,
            username: user.username,
            exp: parent_claims
                .exp
                .min((time::OffsetDateTime::now_utc().unix_timestamp() + 900) as usize),
            token_kind: "preview-resource".into(),
            generation: parent_claims.generation,
            auth_protocol: parent_claims.auth_protocol,
            session_id: parent_claims.session_id,
            jti: uuid::Uuid::new_v4().to_string(),
            prefix: prefix.into(),
            root: root.map(str::to_string),
            dependency_depth: 0,
            controller_origin: None,
        },
        &EncodingKey::from_secret(state.config().jwt_secret.as_bytes()),
    )
    .ok()
}

pub(crate) fn external_dependency_token(
    state: &AppState,
    parent: &str,
    target: &str,
) -> Option<String> {
    let mut claims = resource_claims(state, parent).ok()?;
    if claims.prefix != "/api/proxy-external"
        || claims.root.is_none()
        || claims.dependency_depth >= 16
    {
        return None;
    }
    authenticate_resource_token(state, parent, "GET", "/api/proxy-external").ok()?;
    claims.root = Some(super::external_proxy::normalized_target(target).ok()?);
    claims.jti = uuid::Uuid::new_v4().to_string();
    claims.dependency_depth += 1;
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config().jwt_secret.as_bytes()),
    )
    .ok()
}

pub(crate) fn expires_at(state: &AppState, token: &str) -> Option<usize> {
    resource_claims(state, token).ok().map(|claims| claims.exp)
}

pub(crate) fn selected_resource_token(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    query: Option<&str>,
) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .filter(|token| is_resource_token(state, token))
        .map(str::to_string)
        .or_else(|| {
            headers
                .get(axum::http::header::COOKIE)
                .and_then(|header| header.to_str().ok())
                .and_then(|cookies| {
                    cookies.split(';').find_map(|cookie| {
                        cookie
                            .trim()
                            .split_once('=')
                            .filter(|(name, _)| {
                                matches!(*name, "terminal_preview_token" | "tv4_remote_preview")
                            })
                            .map(|(_, value)| value)
                    })
                })
                .filter(|token| is_resource_token(state, token))
                .map(str::to_string)
        })
        .or_else(|| {
            query
                .filter(|token| is_resource_token(state, token))
                .map(str::to_string)
        })
}

pub(crate) fn sanitized_target(state: &AppState, target: &str) -> Option<String> {
    if !target.starts_with('/') || target.starts_with("//") {
        return None;
    }
    let mut target = Url::parse("http://preview.invalid")
        .ok()?
        .join(target)
        .ok()?;
    let mut validation = Validation::default();
    validation.validate_exp = false;
    let pairs = target
        .query_pairs()
        .filter(|(name, value)| {
            name != "previewToken"
                && !(name == "token"
                    && decode::<ParentClaims>(
                        value,
                        &DecodingKey::from_secret(state.config().jwt_secret.as_bytes()),
                        &validation,
                    )
                    .is_ok())
        })
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        target.set_query(None);
    } else {
        target.query_pairs_mut().clear().extend_pairs(pairs);
    }
    Some(format!(
        "{}{}{}",
        target.path(),
        target
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default(),
        target
            .fragment()
            .map(|fragment| format!("#{fragment}"))
            .unwrap_or_default()
    ))
}

pub(crate) fn is_resource_token(state: &AppState, token: &str) -> bool {
    resource_claims(state, token).is_ok()
}

pub(crate) fn resource_root_allowed(state: &AppState, token: &str, root: &str) -> bool {
    resource_claims(state, token).is_ok_and(|claims| claims.root.as_deref() == Some(root))
}

static BASE_HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']"#).unwrap());

/// Carry an existing preview-only credential through opaque-origin subresource requests.
pub fn authorize_resources(
    content: &str,
    content_type: &str,
    document_url: &str,
    allowed_prefix: &str,
    token: &str,
) -> String {
    let Ok(document) = Url::parse(document_url) else {
        return content.into();
    };
    let mut base = document.clone();
    if content_type.contains("html") {
        if let Some(captures) = BASE_HREF.captures(content) {
            if let Ok(parsed) = document.join(&captures[1].replace("&amp;", "&")) {
                base = parsed;
            }
        }
    }
    super::static_rewrite::rewrite_urls(content_type, content, |raw, html, module| {
        let decoded = html.then(|| raw.replace("&amp;", "&"));
        let raw = decoded.as_deref().unwrap_or(raw);
        if raw.is_empty() || raw.starts_with('#') {
            return None;
        }
        if module && !raw.starts_with('.') && !raw.starts_with('/') && Url::parse(raw).is_err() {
            return None;
        }
        let mut target = base.join(raw).ok()?;
        if target.origin() != document.origin()
            || !(allowed_prefix == "/"
                || target.path() == allowed_prefix
                || target
                    .path()
                    .strip_prefix(allowed_prefix)
                    .is_some_and(|rest| rest.starts_with('/')))
            || !matches!(target.scheme(), "http" | "https")
            || (target.query().is_none()
                && (target.path() == allowed_prefix
                    || target.path() == format!("{allowed_prefix}/")))
        {
            return None;
        }
        let pairs = target
            .query_pairs()
            .filter(|(name, _)| name != "previewToken")
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        target
            .query_pairs_mut()
            .clear()
            .extend_pairs(pairs)
            .append_pair("previewToken", token);
        let output = if raw.starts_with('/') && !raw.starts_with("//") {
            format!(
                "{}{}{}",
                target.path(),
                target
                    .query()
                    .map(|query| format!("?{query}"))
                    .unwrap_or_default(),
                target
                    .fragment()
                    .map(|fragment| format!("#{fragment}"))
                    .unwrap_or_default()
            )
        } else {
            target.to_string()
        };
        Some(if html {
            output.replace('&', "&amp;")
        } else {
            output
        })
    })
}

pub fn strip_preview_token(path: &str) -> String {
    strip_query_key(path, "previewToken")
}

pub(crate) fn strip_query_key(path: &str, key: &str) -> String {
    let Ok(mut parsed) = Url::parse("http://preview.invalid").and_then(|base| base.join(path))
    else {
        return path.into();
    };
    let pairs = parsed
        .query_pairs()
        .filter(|(name, _)| name != key)
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
    }
    format!(
        "{}{}",
        parsed.path(),
        parsed
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_origins_require_exact_http_origins() {
        for value in [
            "http://localhost:5173",
            "http://127.0.0.1:3020",
            "https://synthetic.example",
            "http://synthetic-device.synthetic-tail.ts.net:8080",
        ] {
            assert_eq!(normalized_controller_origin(value).as_deref(), Some(value));
        }
        for value in [
            "null",
            "",
            "*",
            "file:///tmp/controller",
            "https://user@synthetic.example",
            "https://synthetic.example/",
            "https://synthetic.example/path",
            "https://synthetic.example?query",
            "https://synthetic.example#fragment",
            "https://synthetic.example, https://other.example",
        ] {
            assert_eq!(normalized_controller_origin(value), None, "{value}");
        }
    }

    #[test]
    fn module_dependencies_keep_scoped_auth_without_authorizing_external_or_app_urls() {
        let script = "import '/preview/5173/root.js'; import './relative.js'; import('../shared.js'); import 'react'; import 'https://example.test/external.js';";
        let rewritten = authorize_resources(
            script,
            "application/javascript",
            "http://localhost:3049/preview/5173/src/main.js",
            "/preview/5173",
            "scoped-ticket",
        );
        assert!(rewritten.contains("'/preview/5173/root.js?previewToken=scoped-ticket'"));
        assert!(rewritten.contains(
            "'http://localhost:3049/preview/5173/src/relative.js?previewToken=scoped-ticket'"
        ));
        assert!(rewritten
            .contains("'http://localhost:3049/preview/5173/shared.js?previewToken=scoped-ticket'"));
        assert!(rewritten.contains("import 'react'"));
        assert!(rewritten.contains("import 'https://example.test/external.js'"));
        assert_eq!(
            authorize_resources(
                "<img src='/api/settings'><img src='https://evil.test/x'>",
                "text/html",
                "http://localhost:3049/preview/5173/",
                "/preview/5173",
                "scoped-ticket"
            ),
            "<img src='/api/settings'><img src='https://evil.test/x'>"
        );
    }

    #[test]
    fn strip_preview_token_retains_business_query_and_external_base_does_not_receive_ticket() {
        assert_eq!(
            strip_preview_token("/main.js?theme=blue&previewToken=secret&token=app-business"),
            "/main.js?theme=blue&token=app-business"
        );
        let html = "<base href='https://cdn.example.test/'><script src='app.js'></script>";
        assert_eq!(
            authorize_resources(
                html,
                "text/html",
                "http://localhost/preview/5173/",
                "/preview/5173",
                "ticket"
            ),
            html
        );
    }
}
