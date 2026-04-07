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
    websocket_proxy_origin: Option<&str>,
    auth_token: Option<&str>,
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
            let rewritten = rewrite_dev_urls(&injected, port, websocket_proxy_origin, auth_token);
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
fn rewrite_dev_urls(
    html: &str,
    port: u16,
    websocket_proxy_origin: Option<&str>,
    auth_token: Option<&str>,
) -> String {
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

    if let Some(origin) = websocket_proxy_origin {
        let ws_patterns = [
            format!("ws://localhost:{port}"),
            format!("ws://127.0.0.1:{port}"),
            format!("wss://localhost:{port}"),
            format!("wss://127.0.0.1:{port}"),
        ];
        for pattern in &ws_patterns {
            result = rewrite_dev_websocket_urls(&result, pattern, origin, port, auth_token);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_urls() {
        let html = r#"<script>fetch("http://localhost:5173/api/data")</script>"#;
        let result = rewrite_dev_urls(html, 5173, None, None);
        assert_eq!(
            result,
            r#"<script>fetch("/api/dev-proxy/5173/api/data")</script>"#
        );
    }

    #[test]
    fn rewrite_websocket_urls() {
        let html = r#"<script>new WebSocket("ws://localhost:5173/hmr")</script>"#;
        let result = rewrite_dev_urls(html, 5173, Some("wss://terminal.local"), Some("token"));
        assert_eq!(
            result,
            r#"<script>new WebSocket("wss://terminal.local/api/dev-proxy-ws/5173/hmr?token=token")</script>"#
        );
    }
}

fn rewrite_dev_websocket_urls(
    html: &str,
    pattern: &str,
    websocket_proxy_origin: &str,
    port: u16,
    auth_token: Option<&str>,
) -> String {
    let mut rewritten = String::with_capacity(html.len());
    let mut remaining = html;

    while let Some(index) = remaining.find(pattern) {
        rewritten.push_str(&remaining[..index]);
        let after_pattern = &remaining[index + pattern.len()..];
        let suffix_end = after_pattern
            .find(|ch: char| matches!(ch, '"' | '\'' | '<' | ' ' | ')'))
            .unwrap_or(after_pattern.len());
        let suffix = &after_pattern[..suffix_end];
        rewritten.push_str(&build_dev_websocket_proxy_url(
            websocket_proxy_origin,
            port,
            suffix,
            auth_token,
        ));
        remaining = &after_pattern[suffix_end..];
    }

    rewritten.push_str(remaining);
    rewritten
}

fn build_dev_websocket_proxy_url(
    websocket_proxy_origin: &str,
    port: u16,
    suffix: &str,
    auth_token: Option<&str>,
) -> String {
    let split_at = suffix
        .find(|ch| matches!(ch, '?' | '#'))
        .unwrap_or(suffix.len());
    let path_suffix = &suffix[..split_at];
    let trailing = &suffix[split_at..];

    let mut rewritten = format!("{websocket_proxy_origin}/api/dev-proxy-ws/{port}{path_suffix}");
    if let Some(token) = auth_token {
        rewritten.push(if trailing.contains('?') { '&' } else { '?' });
        rewritten.push_str("token=");
        rewritten.push_str(token);
    }
    rewritten.push_str(trailing);
    rewritten
}
