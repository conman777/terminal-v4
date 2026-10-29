pub mod auth_urls;
pub mod cookie_jar;
pub mod dev_proxy;
pub mod external_proxy;
pub mod host_rewrite;
pub mod logs;
pub mod path_rewrite;
pub mod performance;
pub mod port_scan;
pub mod proxy;
pub mod request_logs;
pub(crate) mod resource_auth;
pub mod script_inject;
pub mod static_files;
pub mod static_rewrite;
pub mod ws_logs;
pub mod ws_proxy;

pub(crate) const DOCUMENT_SANDBOX: &str = "sandbox allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts";

use regex_lite::Regex;
use std::sync::LazyLock;

/// Extract a preview port from a Host header like `preview-8080.example.com`.
pub fn extract_port_from_host(host: &str) -> Option<u16> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^preview-(\d+)\.").expect("valid regex"));
    RE.captures(host)?.get(1)?.as_str().parse::<u16>().ok()
}

/// Extract a preview port when the host matches one of the configured bases.
pub fn extract_port_from_preview_subdomain(host: &str, bases: &[String]) -> Option<u16> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^preview-(\d+)\.(.+)$").expect("valid regex"));
    let normalized_host = strip_host_port(host.trim());
    let captures = RE.captures(normalized_host)?;
    let port = captures.get(1)?.as_str().parse::<u16>().ok()?;
    let base = captures.get(2)?.as_str();
    bases
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(base))
        .then_some(port)
}

/// The host a `preview-PORT.` subdomain was derived from; other hosts are unchanged.
pub fn strip_preview_subdomain(host: &str) -> &str {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^preview-\d+\.(.+)$").expect("valid regex"));
    RE.captures(host)
        .and_then(|captures| captures.get(1))
        .map_or(host, |base| base.as_str())
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
        .or_else(|_| std::env::var("PREVIEW_SUBDOMAIN_BASE"))
        .unwrap_or_else(|_| "conordart.com,localhost".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Hosts to try when proxying (fallback chain).
pub fn proxy_hosts() -> Vec<String> {
    std::env::var("PREVIEW_PROXY_HOSTS")
        .unwrap_or_else(|_| "localhost,127.0.0.1,::1".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn strip_host_port(host: &str) -> &str {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(host);
    }
    host.split(':').next().unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_preview_subdomain_returns_the_base_host() {
        let hosts = [
            strip_preview_subdomain("preview-8799.192.168.1.5.nip.io:3020"),
            strip_preview_subdomain("PREVIEW-5173.localhost:3030"),
            strip_preview_subdomain("localhost:3041"),
        ];
        assert_eq!(
            hosts,
            [
                "192.168.1.5.nip.io:3020",
                "localhost:3030",
                "localhost:3041"
            ]
        );
    }

    #[test]
    fn extract_port_from_subdomain() {
        assert_eq!(extract_port_from_host("preview-8080.localhost"), Some(8080));
        assert_eq!(
            extract_port_from_host("preview-3000.example.com"),
            Some(3000)
        );
        assert_eq!(extract_port_from_host("example.com"), None);
    }

    #[test]
    fn extract_port_from_configured_subdomain() {
        let bases = vec!["localhost".to_string(), "preview.example.com".to_string()];
        assert_eq!(
            extract_port_from_preview_subdomain("preview-8080.localhost:3020", &bases),
            Some(8080)
        );
        assert_eq!(
            extract_port_from_preview_subdomain("preview-3000.preview.example.com", &bases),
            Some(3000)
        );
        assert_eq!(
            extract_port_from_preview_subdomain("preview-3000.other.example.com", &bases),
            None
        );
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

#[cfg(test)]
mod regression_tests;
#[cfg(test)]
mod resource_auth_tests;

#[cfg(test)]
mod backend_regression_tests;
