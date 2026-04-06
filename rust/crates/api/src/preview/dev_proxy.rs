use super::proxy;
use super::script_inject;
use axum::http::HeaderMap;

/// Proxy an HTTP request through the dev proxy, rewriting URLs and injecting scripts.
pub async fn proxy_dev_request(
    port: u16,
    path: &str,
    method: &str,
    headers: &HeaderMap,
    body: Option<Vec<u8>>,
    api_origin: &str,
) -> Result<proxy::ProxyResponse, String> {
    let hosts = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    let mut response = proxy::proxy_request(port, path, method, headers, body, &hosts).await?;

    // If HTML response, inject debug script and rewrite URLs
    let content_type = response
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if script_inject::is_html_content_type(&content_type) {
        if let Ok(html) = String::from_utf8(response.body.clone()) {
            let injected = script_inject::inject_debug_script(&html, port, api_origin);
            let rewritten = rewrite_dev_urls(&injected, port);
            response.body = rewritten.into_bytes();

            // Update content-length
            if let Ok(len) = response.body.len().to_string().parse() {
                response.headers.insert("content-length", len);
            }
        }
    }

    Ok(response)
}

/// Rewrite localhost:PORT URLs to go through the dev proxy path.
fn rewrite_dev_urls(html: &str, port: u16) -> String {
    // Replace http://localhost:PORT with /api/dev-proxy/PORT
    let patterns = [
        (
            format!("http://localhost:{port}"),
            format!("/api/dev-proxy/{port}"),
        ),
        (
            format!("http://127.0.0.1:{port}"),
            format!("/api/dev-proxy/{port}"),
        ),
    ];

    let mut result = html.to_string();
    for (from, to) in &patterns {
        result = result.replace(from, to);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_urls() {
        let html = r#"<script>fetch("http://localhost:5173/api/data")</script>"#;
        let result = rewrite_dev_urls(html, 5173);
        assert_eq!(
            result,
            r#"<script>fetch("/api/dev-proxy/5173/api/data")</script>"#
        );
    }
}
