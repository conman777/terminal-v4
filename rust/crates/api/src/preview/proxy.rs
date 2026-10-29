use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
use std::time::Duration;

const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024; // 10MB
const PROXY_TIMEOUT: Duration = Duration::from_secs(30);

/// Headers to strip from proxied responses (iframe-blocking).
const STRIP_HEADERS: &[&str] = &[
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

/// Proxy an HTTP request to a local port, trying multiple upstream hosts.
pub async fn proxy_request(
    port: u16,
    path: &str,
    method: &str,
    headers: &HeaderMap,
    body: Option<Vec<u8>>,
    hosts: &[String],
) -> Result<ProxyResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut last_error = String::new();
    let mut only_refused = true;

    for host in hosts {
        let url = upstream_url(host, port, path);
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);

        let mut req = client.request(method, &url);

        // Forward safe headers
        for (key, value) in headers {
            let name = key.as_str().to_lowercase();
            if [
                "host",
                "connection",
                "keep-alive",
                "transfer-encoding",
                "te",
                "trailer",
                "upgrade",
                "proxy-authorization",
            ]
            .contains(&name.as_str())
            {
                continue;
            }
            if let Ok(v) = value.to_str() {
                req = req.header(key.as_str(), v);
            }
        }

        if let Some(ref body_data) = body {
            req = req.body(body_data.clone());
        }

        match req.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let mut resp_headers = HeaderMap::new();

                for (key, value) in response.headers() {
                    let name = key.as_str().to_lowercase();
                    if STRIP_HEADERS.contains(&name.as_str()) {
                        continue;
                    }
                    resp_headers.append(key.clone(), value.clone());
                }

                let mut response = response;
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|e| format!("Failed to read response body: {e}"))?
                {
                    if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
                        return Err("Response exceeds 10MB limit".to_string());
                    }
                    bytes.extend_from_slice(&chunk);
                }

                return Ok(ProxyResponse {
                    status,
                    headers: resp_headers,
                    body: bytes,
                });
            }
            Err(e) => {
                only_refused &= e.is_connect();
                last_error = format!("Proxy to {host}:{port} failed: {e}");
                continue;
            }
        }
    }

    if only_refused && !hosts.is_empty() {
        return Err(format!(
            "Nothing is running on port {port}. Start your app, then refresh the preview."
        ));
    }
    Err(last_error)
}

/// IPv6 literals such as `::1` need brackets inside a URL.
fn upstream_url(host: &str, port: u16, path: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("http://[{host}]:{port}{path}")
    } else {
        format!("http://{host}:{port}{path}")
    }
}

/// A readable page for the preview frame when the app behind a port cannot be reached.
pub fn unreachable_page(message: &str) -> Response<Body> {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>Preview unavailable</title>\
<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0a0a;color:#f5f5f5;font:14px/1.5 system-ui,sans-serif\">\
<main style=\"max-width:420px;padding:24px;text-align:center\"><h1 style=\"font-size:16px;margin:0 0 8px\">Preview unavailable</h1>\
<p style=\"margin:0;color:#a3a3a3\">{escaped}</p></main></body>"
    );
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Body::from(html))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Convert a ProxyResponse into an axum Response.
pub fn into_axum_response(proxy_resp: ProxyResponse) -> Response<Body> {
    let status = StatusCode::from_u16(proxy_resp.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);

    for (key, value) in &proxy_resp.headers {
        builder = builder.header(key, value);
    }

    builder
        .body(Body::from(proxy_resp.body))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("Proxy response build failed"))
                .unwrap()
        })
}

#[derive(Debug)]
pub struct ProxyResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

#[cfg(test)]
mod regressions {
    use super::*;
    #[test]
    fn ipv6_hosts_are_bracketed_in_upstream_urls() {
        assert_eq!(
            [
                upstream_url("::1", 5173, "/"),
                upstream_url("[::1]", 5173, "/a"),
                upstream_url("127.0.0.1", 5173, "/b"),
            ],
            [
                "http://[::1]:5173/",
                "http://[::1]:5173/a",
                "http://127.0.0.1:5173/b"
            ]
        );
    }

    #[tokio::test]
    async fn a_port_with_nothing_running_says_so() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = proxy_request(
            port,
            "/",
            "GET",
            &HeaderMap::new(),
            None,
            &["127.0.0.1".into(), "::1".into()],
        )
        .await
        .err()
        .unwrap();
        assert_eq!(
            error,
            format!("Nothing is running on port {port}. Start your app, then refresh the preview.")
        );
    }
    #[tokio::test]
    async fn repeated_cookies_survive_upstream_and_axum_conversion() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: session=first; Path=/\r\nSet-Cookie: csrf=second; Path=/\r\nConnection: close\r\n\r\nok").await.unwrap();
        });
        let response = proxy_request(
            port,
            "/",
            "GET",
            &HeaderMap::new(),
            None,
            &["127.0.0.1".into()],
        )
        .await
        .unwrap();
        server.await.unwrap();
        let response = into_axum_response(response);
        assert_eq!(
            response
                .headers()
                .get_all("set-cookie")
                .iter()
                .map(|v| v.to_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["session=first; Path=/", "csrf=second; Path=/"]
        );
    }
}
