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

    for host in hosts {
        let url = format!("http://{host}:{port}{path}");
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .unwrap_or(reqwest::Method::GET);

        let mut req = client.request(method, &url);

        // Forward safe headers
        for (key, value) in headers {
            let name = key.as_str().to_lowercase();
            if name == "host" || name == "connection" || name == "transfer-encoding" {
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
                    resp_headers.insert(key.clone(), value.clone());
                }

                let bytes = response
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read response body: {e}"))?;

                if bytes.len() > MAX_RESPONSE_SIZE {
                    return Err("Response exceeds 10MB limit".to_string());
                }

                return Ok(ProxyResponse {
                    status,
                    headers: resp_headers,
                    body: bytes.to_vec(),
                });
            }
            Err(e) => {
                last_error = format!("Proxy to {host}:{port} failed: {e}");
                continue;
            }
        }
    }

    Err(last_error)
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
