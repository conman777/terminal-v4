use std::net::IpAddr;
use std::time::Duration;

const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Safe headers to forward to external sites.
/// Proxy a request to an external URL, with security validation.
pub async fn proxy_external(url: &str) -> Result<ExternalProxyResponse, String> {
    validate_url(url)?;

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("External request failed: {e}"))?;

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

    Ok(ExternalProxyResponse {
        status,
        content_type,
        body: bytes.to_vec(),
    })
}

#[derive(Debug)]
pub struct ExternalProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Validate a URL for external proxying. Blocks private/local IPs.
fn validate_url(url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("Unsupported scheme: {s}")),
    }

    let host = parsed
        .host_str()
        .ok_or("URL has no host")?;

    // Block private/local IPs
    if is_private_host(host) {
        return Err(format!("Blocked: {host} is a private/local address"));
    }

    // Block credentials in URL
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with credentials are not allowed".to_string());
    }

    Ok(())
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host == "0.0.0.0" || host == "::1" {
        return true;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.octets()[0] == 0
            }
            IpAddr::V6(v6) => v6.is_loopback(),
        };
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_localhost() {
        assert!(validate_url("http://localhost:3000").is_err());
        assert!(validate_url("http://127.0.0.1:8080").is_err());
    }

    #[test]
    fn blocks_private_ips() {
        assert!(validate_url("http://10.0.0.1/api").is_err());
        assert!(validate_url("http://192.168.1.1/").is_err());
        assert!(validate_url("http://172.16.0.1/").is_err());
    }

    #[test]
    fn blocks_credentials() {
        assert!(validate_url("http://user:pass@example.com").is_err());
    }

    #[test]
    fn blocks_non_http() {
        assert!(validate_url("ftp://example.com").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn allows_public_urls() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://api.github.com/repos").is_ok());
    }
}
