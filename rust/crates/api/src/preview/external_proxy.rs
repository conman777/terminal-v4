#[path = "external_rewrite.rs"]
mod external_rewrite;

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Safe headers to forward to external sites.
/// Proxy a request to an external URL, with security validation.
pub async fn proxy_external(url: &str) -> Result<ExternalProxyResponse, String> {
    let mut current = validate_url(url).await?;
    let mut redirects = 0usize;

    loop {
        let response = send_request(&current).await?;

        if response.status().is_redirection() {
            if redirects >= MAX_REDIRECTS {
                return Err(format!("Too many redirects (max {MAX_REDIRECTS})"));
            }

            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or("Redirect response missing Location header")?
                .to_str()
                .map_err(|_| "Redirect Location header is not valid UTF-8".to_string())?;

            let next_url = current
                .url
                .join(location)
                .map_err(|e| format!("Invalid redirect target: {e}"))?;

            current = validate_parsed_url(next_url).await?;
            redirects += 1;
            continue;
        }

        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Failed to read response: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_SIZE {
                return Err("Response exceeds 10MB limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }

        let body = rewrite_external_content(&content_type, bytes, &current.url)?;
        return Ok(ExternalProxyResponse {
            status,
            content_type,
            body,
            final_url: current.url.to_string(),
        });
    }
}

const MAX_EXTERNAL_URL: usize = 8192;
const MAX_EXTERNAL_TICKET: usize = 16384;
const MAX_LOCAL_URL: usize = 65536;

fn external_source(
    content_type: &str,
    bytes: &[u8],
    document: &url::Url,
) -> Result<(url::Url, String), String> {
    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err("External response exceeds 10MB limit".into());
    }
    if document.as_str().len() > MAX_EXTERNAL_URL {
        return Err("External document URL exceeds 8192-byte limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "External text response is not UTF-8")?;
    if super::script_inject::is_html_content_type(content_type) {
        external_rewrite::document_base(text, document)
    } else {
        Ok((document.clone(), text.into()))
    }
}

fn finish_external(
    content_type: &str,
    mut rewritten: String,
    base: &url::Url,
) -> Result<Vec<u8>, String> {
    if super::script_inject::is_html_content_type(content_type) {
        let mut tag = String::new();
        external_rewrite::append(&mut tag, "<base href=\"")?;
        external_rewrite::append(&mut tag, &external_rewrite::escape(base.as_str())?)?;
        external_rewrite::append(&mut tag, "\">")?;
        if rewritten.len().saturating_add(tag.len()) > MAX_RESPONSE_SIZE {
            return Err("Rewritten external response exceeds 10MB limit".into());
        }
        let at = regex_lite::Regex::new(r"(?i)<head\b[^>]*>")
            .unwrap()
            .find(&rewritten)
            .map(|head| head.end())
            .unwrap_or(0);
        rewritten
            .try_reserve_exact(tag.len())
            .map_err(|_| "External rewrite allocation failed")?;
        rewritten.insert_str(at, &tag);
    }
    Ok(rewritten.into_bytes())
}

fn external_target(
    base: &url::Url,
    raw: &str,
    html: bool,
    module: bool,
) -> Result<Option<url::Url>, String> {
    if raw.len() > MAX_EXTERNAL_URL {
        return Err("External preview URL exceeds 8192-byte limit".into());
    }
    let raw = if html {
        raw.replace("&amp;", "&")
    } else {
        raw.into()
    };
    if raw.is_empty()
        || raw.starts_with('#')
        || (module
            && !raw.starts_with('.')
            && !raw.starts_with('/')
            && url::Url::parse(&raw).is_err())
    {
        return Ok(None);
    }
    let Ok(target) = base.join(&raw) else {
        return Ok(None);
    };
    if !matches!(target.scheme(), "http" | "https") {
        return Ok(None);
    }
    if target.as_str().len() > MAX_EXTERNAL_URL {
        return Err("External preview URL exceeds 8192-byte limit".into());
    }
    Ok(Some(target))
}

fn escaped_dependency_url(value: &str) -> Result<String, String> {
    let length = value
        .bytes()
        .map(|byte| match byte {
            b'&' => 5,
            b'"' => 6,
            b'\'' => 5,
            b'<' => 4,
            _ => 1,
        })
        .sum::<usize>();
    if length > MAX_LOCAL_URL {
        return Err("Escaped external dependency URL exceeds 65536-byte limit".into());
    }
    external_rewrite::escape(value)
}

fn rewrite_external_content(
    content_type: &str,
    bytes: Vec<u8>,
    document: &url::Url,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err("External response exceeds 10MB limit".into());
    }
    if std::str::from_utf8(&bytes).is_err() {
        return Ok(bytes);
    }
    let (base, source) = external_source(content_type, &bytes, document)?;
    let rewritten = external_rewrite::rewrite(content_type, &source, |raw, html, module| {
        let Some(target) = external_target(&base, raw, html, module)? else {
            return Ok(None);
        };
        Ok(Some(if html {
            external_rewrite::escape(target.as_str())?
        } else {
            target.into()
        }))
    })?;
    finish_external(content_type, rewritten, &base)
}

pub fn authorize_external_dependencies(
    content_type: &str,
    bytes: Vec<u8>,
    document_url: &str,
    proxy_origin: &str,
    token_for_target: impl Fn(&str) -> Option<String>,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err("External response exceeds 10MB limit".into());
    }
    if document_url.len() > MAX_EXTERNAL_URL || proxy_origin.len() > 2048 {
        return Err("External preview origin or document URL exceeds limits".into());
    }
    if std::str::from_utf8(&bytes).is_err() {
        return Ok(bytes);
    }
    let document = url::Url::parse(document_url).map_err(|_| "Invalid external document URL")?;
    let (base, source) = external_source(content_type, &bytes, &document)?;
    let mut urls = std::collections::HashMap::<String, String>::new();
    let rewritten = external_rewrite::rewrite(content_type, &source, |raw, html, module| {
        let Some(mut target) = external_target(&base, raw, html, module)? else {
            return Ok(None);
        };
        let fragment = target.fragment().map(str::to_owned);
        target.set_fragment(None);
        let key = target.as_str();
        let local = if let Some(local) = urls.get(key) {
            local.clone()
        } else {
            if urls.len() >= 256 {
                return Err("External preview exceeds dependency limits".into());
            }
            let token = token_for_target(key).ok_or(
                "External preview dependency is outside its resource scope or depth limit",
            )?;
            if token.len() > MAX_EXTERNAL_TICKET {
                return Err("External preview dependency ticket exceeds 16384-byte limit".into());
            }
            let encoded_len = |value: &str| {
                value
                    .bytes()
                    .map(|byte| {
                        if byte.is_ascii_alphanumeric() || b"*-._ ".contains(&byte) {
                            1
                        } else {
                            3
                        }
                    })
                    .sum::<usize>()
            };
            let predicted = proxy_origin.trim_end_matches('/').len()
                + "/api/proxy-external?url=".len()
                + encoded_len(key)
                + "&previewToken=".len()
                + encoded_len(&token);
            if predicted > MAX_LOCAL_URL {
                return Err("External preview dependency URL exceeds 65536-byte limit".into());
            }
            let mut query = url::form_urlencoded::Serializer::new(String::with_capacity(predicted));
            query
                .append_pair("url", key)
                .append_pair("previewToken", &token);
            let local = format!(
                "{}/api/proxy-external?{}",
                proxy_origin.trim_end_matches('/'),
                query.finish()
            );
            urls.insert(key.into(), local.clone());
            local
        };
        let mut local = local;
        if let Some(fragment) = fragment {
            if local.len() + fragment.len() + 1 > MAX_LOCAL_URL {
                return Err("External preview dependency URL exceeds 65536-byte limit".into());
            }
            local
                .try_reserve_exact(fragment.len() + 1)
                .map_err(|_| "External rewrite allocation failed")?;
            local.push('#');
            local.push_str(&fragment);
        }
        Ok(Some(if html {
            escaped_dependency_url(&local)?
        } else {
            local
        }))
    })?;
    finish_external(content_type, rewritten, &base)
}

#[derive(Debug)]
pub struct ExternalProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub final_url: String,
}

#[derive(Debug, Clone)]
struct ValidatedUrl {
    url: url::Url,
    dns_overrides: Vec<SocketAddr>,
}

/// Validate a URL for external proxying. Blocks private/local IPs and DNS targets.
pub(crate) fn normalized_target(url: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    validate_url_syntax(&parsed)?;
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

async fn validate_url(url: &str) -> Result<ValidatedUrl, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    validate_parsed_url(parsed).await
}

async fn validate_parsed_url(parsed: url::Url) -> Result<ValidatedUrl, String> {
    let host = validate_url_syntax(&parsed)?;
    let dns_overrides = resolve_public_dns_targets(&parsed, host).await?;

    Ok(ValidatedUrl {
        url: parsed,
        dns_overrides,
    })
}

fn validate_url_syntax(parsed: &url::Url) -> Result<&str, String> {
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("Unsupported scheme: {s}")),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with credentials are not allowed".to_string());
    }

    let host = parsed.host_str().ok_or("URL has no host")?;

    if is_private_host(host) {
        return Err(format!("Blocked: {host} is a private/local address"));
    }

    Ok(host)
}

async fn resolve_public_dns_targets(
    parsed: &url::Url,
    host: &str,
) -> Result<Vec<SocketAddr>, String> {
    if host.parse::<IpAddr>().is_ok() {
        return Ok(Vec::new());
    }

    let port = parsed
        .port_or_known_default()
        .ok_or("URL is missing a known network port")?;

    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Failed to resolve {host}: {e}"))?
        .map(|addr| SocketAddr::new(addr.ip(), 0))
        .collect();

    validate_resolved_addrs(host, &resolved)?;

    let deduped: BTreeSet<SocketAddr> = resolved.into_iter().collect();
    Ok(deduped.into_iter().collect())
}

fn validate_resolved_addrs(host: &str, addrs: &[SocketAddr]) -> Result<(), String> {
    if addrs.is_empty() {
        return Err(format!("Failed to resolve {host} to any public address"));
    }

    if let Some(blocked) = addrs.iter().find(|addr| is_private_ip(addr.ip())) {
        return Err(format!(
            "Blocked: {host} resolves to private/local address {}",
            blocked.ip()
        ));
    }

    Ok(())
}

async fn send_request(target: &ValidatedUrl) -> Result<reqwest::Response, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());

    if !target.dns_overrides.is_empty() {
        let host = target
            .url
            .host_str()
            .ok_or("URL has no host for DNS override")?;
        builder = builder.resolve_to_addrs(host, &target.dns_overrides);
    }

    let client = builder
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    client
        .get(target.url.clone())
        .send()
        .await
        .map_err(|e| format!("External request failed: {e}"))
}

fn is_private_host(host: &str) -> bool {
    if matches!(host, "localhost" | "0.0.0.0" | "::1") {
        return true;
    }

    host.parse::<IpAddr>().is_ok_and(is_private_ip)
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_localhost() {
        let parsed = url::Url::parse("http://localhost:3000").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());

        let parsed = url::Url::parse("http://127.0.0.1:8080").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());
    }

    #[test]
    fn blocks_private_ips() {
        let parsed = url::Url::parse("http://10.0.0.1/api").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());

        let parsed = url::Url::parse("http://192.168.1.1/").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());

        let parsed = url::Url::parse("http://172.16.0.1/").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());
    }

    #[test]
    fn blocks_credentials() {
        let parsed = url::Url::parse("http://user:pass@example.com").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());
    }

    #[test]
    fn blocks_non_http() {
        let parsed = url::Url::parse("ftp://example.com").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());

        let parsed = url::Url::parse("file:///etc/passwd").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_err());
    }

    #[test]
    fn allows_public_urls() {
        let parsed = url::Url::parse("https://example.com").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_ok());

        let parsed = url::Url::parse("http://api.github.com/repos").expect("url should parse");
        assert!(validate_url_syntax(&parsed).is_ok());
    }

    #[test]
    fn blocks_hostnames_that_resolve_to_private_addresses() {
        let resolved = [SocketAddr::from(([127, 0, 0, 1], 0))];
        assert!(validate_resolved_addrs("example.com", &resolved).is_err());
    }

    #[test]
    fn blocks_mixed_public_and_private_dns_results() {
        let resolved = [
            SocketAddr::from(([93, 184, 216, 34], 0)),
            SocketAddr::from(([10, 0, 0, 5], 0)),
        ];

        assert!(validate_resolved_addrs("example.com", &resolved).is_err());
    }

    #[test]
    fn allows_public_dns_results() {
        let resolved = [
            SocketAddr::from(([93, 184, 216, 34], 0)),
            SocketAddr::from(([1, 1, 1, 1], 0)),
        ];

        assert!(validate_resolved_addrs("example.com", &resolved).is_ok());
    }
}

#[cfg(test)]
mod asset_regressions {
    use super::*;
    #[test]
    fn external_assets_keep_final_document_origin_and_existing_base() {
        let document = url::Url::parse("https://fixture.test/nested/page.html").unwrap();
        let html=String::from_utf8(rewrite_external_content("text/html",br#"<html><head></head><body><script src="main.js"></script><link href="/styles.css"><img src="//cdn.test/logo.png"></body></html>"#.to_vec(),&document).unwrap()).unwrap();
        assert!(html.contains("src=\"https://fixture.test/nested/main.js\""));
        assert!(html.contains("href=\"https://fixture.test/styles.css\""));
        assert!(html.contains("src=\"https://cdn.test/logo.png\""));
        let html = String::from_utf8(
            rewrite_external_content(
                "text/html",
                b"<base href='../assets/'><img src='logo.png'>".to_vec(),
                &document,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(html.contains("src='https://fixture.test/assets/logo.png'"));
        assert_eq!(
            rewrite_external_content("image/png", vec![255, 0], &document).unwrap(),
            vec![255, 0]
        );
    }
}

#[cfg(test)]
mod dependency_regressions {
    use super::*;
    #[test]
    fn dependencies_use_app_origin_tickets_for_modules_css_and_images() {
        let html = r#"<head><base href="https://cdn.test/assets/"><script type="module" src="main.js"></script><link href="/style.css"><img src="icon.svg#icon"></head>"#;
        let output = String::from_utf8(
            authorize_external_dependencies(
                "text/html",
                html.as_bytes().to_vec(),
                "https://fixture.test/nested/page.html",
                "https://app.test",
                |_| Some("child-ticket".into()),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(output.contains("<base href=\"https://cdn.test/assets/\">"));
        assert!(output.contains("https://app.test/api/proxy-external?url=https%3A%2F%2Fcdn.test%2Fassets%2Fmain.js&amp;previewToken=child-ticket"));
        assert!(!output.contains("https://cdn.test/api/proxy-external"));
        for (content_type, source, base, dependency) in [
            (
                "text/javascript",
                "import './dep.js'; export {value} from './other.js'; import('./lazy.js');",
                "https://cdn.test/assets/main.js",
                "https%3A%2F%2Fcdn.test%2Fassets%2Fdep.js",
            ),
            (
                "text/css",
                "@import './theme.css'; body { background: url('../images/icon.svg'); }",
                "https://cdn.test/assets/site.css",
                "https%3A%2F%2Fcdn.test%2Fimages%2Ficon.svg",
            ),
        ] {
            let result = String::from_utf8(
                authorize_external_dependencies(
                    content_type,
                    source.as_bytes().to_vec(),
                    base,
                    "https://app.test",
                    |_| Some("different-child-ticket".into()),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(result.contains(dependency));
            assert!(result.contains("https://app.test/api/proxy-external?"));
            assert!(!result.contains("parent-access-token"));
        }
    }
    #[test]
    fn dependency_count_and_failed_authorization_reject_entire_response() {
        let html = (0..257)
            .map(|index| format!("<img src='{index}.svg'>"))
            .collect::<String>();
        assert!(authorize_external_dependencies(
            "text/html",
            html.into_bytes(),
            "https://fixture.test/page",
            "https://app.test",
            |_| Some("ticket".into())
        )
        .unwrap_err()
        .contains("limits"));
        assert!(authorize_external_dependencies(
            "text/html",
            b"<script src='app.js'></script>".to_vec(),
            "https://fixture.test/page",
            "https://app.test",
            |_| None
        )
        .is_err());
    }
}

#[cfg(test)]
mod base_budget_regressions {
    use super::*;
    #[test]
    fn quoted_unquoted_and_first_effective_bases_resolve_modules_consistently() {
        let document = url::Url::parse("https://fixture.invalid/nested/page.html").unwrap();
        for base in [
            "<base href=../assets/>",
            "<BASE HREF = '../assets/'>",
            "<base href=\"../assets/\">",
            "<base target=_blank><base href=../assets/><base href=/ignored/>",
        ] {
            let input = format!("<head>{base}<script type=module src='main.js'></script></head>");
            let first = rewrite_external_content("text/html", input.as_bytes().to_vec(), &document)
                .unwrap();
            let output = String::from_utf8(
                authorize_external_dependencies(
                    "text/html",
                    first,
                    document.as_str(),
                    "https://app.invalid",
                    |_| Some("child-ticket".into()),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(
                output.contains("url=https%3A%2F%2Ffixture.invalid%2Fassets%2Fmain.js"),
                "{base}: {output}"
            );
            assert_eq!(output.to_ascii_lowercase().matches("<base ").count(), 1);
        }
    }
    #[test]
    fn repeated_dependency_growth_is_rejected_during_construction() {
        let input = "<img src='x'>".repeat(2000);
        let started = std::time::Instant::now();
        let result = authorize_external_dependencies(
            "text/html",
            input.into_bytes(),
            "https://fixture.invalid/",
            "https://app.invalid",
            |_| Some("x".repeat(8192)),
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "bounded repeated references must abort promptly"
        );
    }
}

#[cfg(test)]
mod nested_budget_regressions {
    use super::*;
    #[test]
    fn nested_srcset_css_and_module_replacements_reject_excess_growth() {
        let references = 2000;
        for (kind, input) in [
            (
                "text/html",
                format!("<img srcset=\"{}\">", "x 1x, ".repeat(references)),
            ),
            (
                "text/html",
                format!(
                    "<div style=\"{}\"></div>",
                    "background:url('x');".repeat(references)
                ),
            ),
            (
                "text/html",
                format!(
                    "<style>{}</style>",
                    "a{background:url('x')}".repeat(references)
                ),
            ),
            (
                "text/html",
                format!(
                    "<script type=module>{}</script>",
                    "import './x';".repeat(references)
                ),
            ),
            ("text/css", "@import 'x';".repeat(references)),
        ] {
            let result = authorize_external_dependencies(
                kind,
                input.into_bytes(),
                "https://fixture.invalid/",
                "https://app.invalid",
                |_| Some("t".repeat(8192)),
            );
            assert!(result.unwrap_err().contains("10MB"), "{kind}");
        }
    }
    #[test]
    fn input_reference_ticket_and_reference_work_limits_precede_expansion() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let sign = |_: &str| {
            calls.set(calls.get() + 1);
            Some("ticket".into())
        };
        assert!(authorize_external_dependencies(
            "text/html",
            vec![b'a'; MAX_RESPONSE_SIZE + 1],
            "https://fixture.invalid/",
            "https://app.invalid",
            sign
        )
        .is_err());
        assert_eq!(calls.get(), 0);
        let html = format!("<img src='{}'>", "x".repeat(8193));
        assert!(authorize_external_dependencies(
            "text/html",
            html.into_bytes(),
            "https://fixture.invalid/",
            "https://app.invalid",
            sign
        )
        .is_err());
        assert_eq!(calls.get(), 0);
        assert!(authorize_external_dependencies(
            "text/html",
            b"<img src='x'>".to_vec(),
            "https://fixture.invalid/",
            "https://app.invalid",
            |_| Some("x".repeat(MAX_EXTERNAL_TICKET + 1))
        )
        .unwrap_err()
        .contains("ticket"));
        assert!(authorize_external_dependencies(
            "text/html",
            "<img src='x'>".repeat(8193).into_bytes(),
            "https://fixture.invalid/",
            "https://app.invalid",
            |_| Some("tiny".into())
        )
        .unwrap_err()
        .contains("reference work"));
    }
    #[test]
    fn inline_css_and_unquoted_inline_modules_keep_dependency_contract() {
        let source="<head><base href=../assets/></head><div style=\"background:url('icon.svg')\"></div><script type=module>import './main.js';</script><img srcset='icon.svg 1x, large.svg 2x'>";
        let output = String::from_utf8(
            authorize_external_dependencies(
                "text/html",
                source.as_bytes().to_vec(),
                "https://fixture.invalid/nested/page.html",
                "https://app.invalid",
                |_| Some("child".into()),
            )
            .unwrap(),
        )
        .unwrap();
        for path in ["main.js", "icon.svg", "large.svg"] {
            assert!(
                output.contains(&format!(
                    "url=https%3A%2F%2Ffixture.invalid%2Fassets%2F{path}"
                )),
                "{path}: {output}"
            );
        }
        assert!(output.contains("import 'https://app.invalid/api/proxy-external?"));
    }
}

#[cfg(test)]
mod inline_css_stage_regressions {
    use super::*;
    #[test]
    fn both_stages_authorize_exact_quoted_inline_css_target_without_fragment() {
        use std::cell::RefCell;
        let document = url::Url::parse("https://fixture.invalid/nested/page.html").unwrap();
        for (style, expected) in [
            (
                r#"style="background-image:url('one.svg#inline')""#,
                "https://fixture.invalid/assets/one.svg",
            ),
            (
                r#"style='background-image:url("one.svg#inline")'"#,
                "https://fixture.invalid/assets/one.svg",
            ),
            (
                r#"style="background-image:url(&quot;one.svg#inline&quot;)""#,
                "https://fixture.invalid/assets/one.svg",
            ),
            (
                r#"style="background-image:url(&#39;one.svg#inline&#39;)""#,
                "https://fixture.invalid/assets/one.svg",
            ),
            (
                r#"style="background-image:url(&#x27;one.svg#inline&#x27;)""#,
                "https://fixture.invalid/assets/one.svg",
            ),
            (
                r#"style="background-image:url('one.svg?theme=a&amp;mode=b#inline')""#,
                "https://fixture.invalid/assets/one.svg?theme=a&mode=b",
            ),
            (
                r#"style="background-image:url('one.svg?theme=a&amp;amp;mode=b#inline')""#,
                "https://fixture.invalid/assets/one.svg?theme=a&amp;mode=b",
            ),
        ] {
            let raw = format!("<head><base href='../assets/'></head><div {style}></div>");
            let preliminary =
                rewrite_external_content("text/html", raw.into_bytes(), &document).unwrap();
            let targets = RefCell::new(Vec::new());
            let output = authorize_external_dependencies(
                "text/html",
                preliminary,
                document.as_str(),
                "https://app.invalid",
                |target| {
                    targets.borrow_mut().push(target.to_owned());
                    Some("child-ticket".into())
                },
            )
            .unwrap();
            assert_eq!(targets.into_inner(), vec![expected], "{style}");
            let output = String::from_utf8(output).unwrap();
            assert!(
                output.contains("#inline"),
                "fragment must remain on app URL"
            );
            assert!(
                !output.contains("url(&amp;#"),
                "CSS delimiter must decode once"
            );
        }
    }
}
