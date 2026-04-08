use super::script_inject;

pub fn rewrite_html_for_subdomain_preview(
    html: &str,
    port: u16,
    api_origin: &str,
    preview_origin: &str,
    websocket_origin: Option<&str>,
) -> String {
    let injected = script_inject::inject_debug_script(html, port, api_origin);
    rewrite_text_for_subdomain_preview(&injected, port, preview_origin, websocket_origin)
}

pub fn rewrite_css_for_subdomain_preview(css: &str, port: u16, preview_origin: &str) -> String {
    rewrite_text_for_subdomain_preview(css, port, preview_origin, None)
}

pub fn rewrite_script_for_subdomain_preview(
    script: &str,
    port: u16,
    preview_origin: &str,
    websocket_origin: Option<&str>,
) -> String {
    rewrite_text_for_subdomain_preview(script, port, preview_origin, websocket_origin)
}

fn rewrite_text_for_subdomain_preview(
    input: &str,
    port: u16,
    preview_origin: &str,
    websocket_origin: Option<&str>,
) -> String {
    let mut rewritten = input.to_string();

    for origin in local_http_origins(port) {
        rewritten = rewritten.replace(&origin, preview_origin);
    }

    if let Some(websocket_origin) = websocket_origin
        .map(str::to_string)
        .or_else(|| derive_websocket_origin(preview_origin))
    {
        for origin in local_websocket_origins(port) {
            rewritten = rewritten.replace(&origin, &websocket_origin);
        }
    }

    rewritten
}

fn local_http_origins(port: u16) -> [String; 6] {
    [
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
        format!("http://0.0.0.0:{port}"),
        format!("https://localhost:{port}"),
        format!("https://127.0.0.1:{port}"),
        format!("https://0.0.0.0:{port}"),
    ]
}

fn local_websocket_origins(port: u16) -> [String; 8] {
    [
        format!("ws://localhost:{port}"),
        format!("ws://127.0.0.1:{port}"),
        format!("ws://0.0.0.0:{port}"),
        format!("ws://[::1]:{port}"),
        format!("wss://localhost:{port}"),
        format!("wss://127.0.0.1:{port}"),
        format!("wss://0.0.0.0:{port}"),
        format!("wss://[::1]:{port}"),
    ]
}

fn derive_websocket_origin(preview_origin: &str) -> Option<String> {
    preview_origin
        .strip_prefix("http://")
        .map(|rest| format!("ws://{rest}"))
        .or_else(|| {
            preview_origin
                .strip_prefix("https://")
                .map(|rest| format!("wss://{rest}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_html_and_injects_debug_script() {
        let html = r#"
            <html>
              <body>
                <script>
                  window.__api = "http://localhost:5173/api/data";
                  window.__ws = "ws://localhost:5173/hmr";
                </script>
              </body>
            </html>
        "#;

        let rewritten = rewrite_html_for_subdomain_preview(
            html,
            5173,
            "http://localhost:3020",
            "http://preview-5173.localhost:3020",
            None,
        );

        assert!(rewritten.contains("data-preview-debug"));
        assert!(rewritten.contains("http://preview-5173.localhost:3020/api/data"));
        assert!(rewritten.contains("ws://preview-5173.localhost:3020/hmr"));
    }

    #[test]
    fn rewrites_css_local_origins() {
        let css = r#"body { background-image: url("http://127.0.0.1:5173/assets/bg.png"); }"#;
        let rewritten =
            rewrite_css_for_subdomain_preview(css, 5173, "http://preview-5173.localhost:3020");

        assert!(rewritten.contains(r#"url("http://preview-5173.localhost:3020/assets/bg.png")"#));
    }

    #[test]
    fn rewrites_javascript_websocket_origins() {
        let script = r#"const socket = new WebSocket("wss://localhost:5173/hmr");"#;
        let rewritten = rewrite_script_for_subdomain_preview(
            script,
            5173,
            "https://preview-5173.localhost",
            None,
        );

        assert_eq!(
            rewritten,
            r#"const socket = new WebSocket("wss://preview-5173.localhost/hmr");"#
        );
    }

    #[test]
    fn derive_websocket_origin_http_to_ws() {
        assert_eq!(
            derive_websocket_origin("http://example.com:3020"),
            Some("ws://example.com:3020".to_string())
        );
    }

    #[test]
    fn derive_websocket_origin_https_to_wss() {
        assert_eq!(
            derive_websocket_origin("https://example.com"),
            Some("wss://example.com".to_string())
        );
    }

    #[test]
    fn derive_websocket_origin_unknown_protocol() {
        assert_eq!(derive_websocket_origin("ftp://example.com"), None);
    }

    #[test]
    fn rewrites_all_localhost_variants() {
        let html = r#"<a href="http://0.0.0.0:8080/path">link</a>"#;
        let rewritten = rewrite_html_for_subdomain_preview(
            html,
            8080,
            "http://localhost:3020",
            "http://preview-8080.localhost:3020",
            None,
        );
        assert!(rewritten.contains("http://preview-8080.localhost:3020/path"));
    }

    #[test]
    fn explicit_websocket_origin_overrides_derived() {
        let script = r#"new WebSocket("ws://localhost:5173/ws")"#;
        let rewritten = rewrite_script_for_subdomain_preview(
            script,
            5173,
            "https://preview-5173.example.com",
            Some("wss://custom-ws.example.com"),
        );
        assert!(rewritten.contains("wss://custom-ws.example.com/ws"));
    }
}
