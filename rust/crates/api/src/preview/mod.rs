pub mod cookie_jar;
pub mod dev_proxy;
pub mod external_proxy;
pub mod logs;
pub mod port_scan;
pub mod proxy;
pub mod script_inject;

use regex_lite::Regex;
use std::sync::LazyLock;

/// Extract a preview port from a Host header like `preview-8080.example.com`.
pub fn extract_port_from_host(host: &str) -> Option<u16> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^preview-(\d+)\.").expect("valid regex"));
    RE.captures(host)?
        .get(1)?
        .as_str()
        .parse::<u16>()
        .ok()
}

/// Extract a preview port from a path like `/preview/8080/...`.
pub fn extract_port_from_path(path: &str) -> Option<(u16, String)> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^/preview/(\d+)(/.*)?$").expect("valid regex"));
    let caps = RE.captures(path)?;
    let port = caps.get(1)?.as_str().parse::<u16>().ok()?;
    let remainder = caps
        .get(2)
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    Some((port, remainder))
}

/// Subdomain bases for preview URLs, from env or defaults.
pub fn subdomain_bases() -> Vec<String> {
    std::env::var("PREVIEW_SUBDOMAIN_BASES")
        .unwrap_or_else(|_| "localhost".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Hosts to try when proxying (fallback chain).
pub fn proxy_hosts() -> Vec<String> {
    std::env::var("PREVIEW_PROXY_HOSTS")
        .unwrap_or_else(|_| "localhost,127.0.0.1".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_port_from_subdomain() {
        assert_eq!(
            extract_port_from_host("preview-8080.localhost"),
            Some(8080)
        );
        assert_eq!(
            extract_port_from_host("preview-3000.example.com"),
            Some(3000)
        );
        assert_eq!(extract_port_from_host("example.com"), None);
    }

    #[test]
    fn extract_port_from_url_path() {
        let (port, path) = extract_port_from_path("/preview/5173/index.html").unwrap();
        assert_eq!(port, 5173);
        assert_eq!(path, "/index.html");

        let (port, path) = extract_port_from_path("/preview/3000").unwrap();
        assert_eq!(port, 3000);
        assert_eq!(path, "/");

        assert!(extract_port_from_path("/api/health").is_none());
    }
}
