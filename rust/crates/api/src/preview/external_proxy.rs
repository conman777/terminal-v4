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

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?;

        if bytes.len() > MAX_RESPONSE_SIZE {
            return Err("Response exceeds 10MB limit".to_string());
        }

        return Ok(ExternalProxyResponse {
            status,
            content_type,
            body: bytes.to_vec(),
        });
    }
}

#[derive(Debug)]
pub struct ExternalProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
struct ValidatedUrl {
    url: url::Url,
    dns_overrides: Vec<SocketAddr>,
}

/// Validate a URL for external proxying. Blocks private/local IPs and DNS targets.
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
