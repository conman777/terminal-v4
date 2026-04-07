use axum::extract::ws::{CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket};
use axum::http::{header, HeaderMap, HeaderValue};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

const WS_SKIP_HEADERS: &[&str] = &[
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
];

pub async fn proxy_websocket(
    mut client_socket: WebSocket,
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) -> Result<(), String> {
    let upstream_socket = connect_with_fallback(port, path, request_headers, cookie_header).await?;
    let (mut upstream_sender, mut upstream_receiver) = upstream_socket.split();

    loop {
        tokio::select! {
            client_message = client_socket.recv() => {
                match client_message {
                    Some(Ok(message)) => {
                        let Some(upstream_message) = to_upstream_message(message) else {
                            continue;
                        };
                        let should_close = matches!(upstream_message, UpstreamMessage::Close(_));
                        upstream_sender
                            .send(upstream_message)
                            .await
                            .map_err(|error| format!("Failed to send websocket message upstream: {error}"))?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        return Err(format!("Failed to receive websocket message from client: {error}"));
                    }
                    None => {
                        let _ = upstream_sender.close().await;
                        break;
                    }
                }
            }
            upstream_message = upstream_receiver.next() => {
                match upstream_message {
                    Some(Ok(message)) => {
                        let Some(client_message) = to_client_message(message) else {
                            continue;
                        };
                        let should_close = matches!(client_message, AxumMessage::Close(_));
                        client_socket
                            .send(client_message)
                            .await
                            .map_err(|error| format!("Failed to send websocket message to client: {error}"))?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        let _ = client_socket
                            .send(AxumMessage::Close(Some(AxumCloseFrame {
                                code: 1011,
                                reason: format!("Preview websocket proxy error: {error}").into(),
                            })))
                            .await;
                        return Err(format!("Failed to receive websocket message from upstream: {error}"));
                    }
                    None => {
                        let _ = client_socket.send(AxumMessage::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

async fn connect_with_fallback(
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let hosts = super::proxy_hosts();
    if hosts.is_empty() {
        return Err("Preview websocket proxy hosts are not configured".to_string());
    }

    let mut last_error = None;

    for host in hosts {
        let target_url = format!("ws://{}:{port}{path}", format_host_for_url(&host));
        let mut request = target_url
            .into_client_request()
            .map_err(|error| format!("Failed to build websocket request: {error}"))?;
        populate_forward_headers(request.headers_mut(), port, request_headers, cookie_header);

        match connect_async(request).await {
            Ok((socket, _response)) => return Ok(socket),
            Err(error) => {
                last_error = Some(format!(
                    "Preview websocket proxy to {host}:{port} failed: {error}"
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Preview websocket proxy failed".to_string()))
}

fn populate_forward_headers(
    target_headers: &mut HeaderMap,
    port: u16,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) {
    for (key, value) in request_headers {
        let name = key.as_str().to_ascii_lowercase();
        if WS_SKIP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        target_headers.insert(key, value.clone());
    }

    if let Ok(value) = HeaderValue::from_str(&format!("localhost:{port}")) {
        target_headers.insert(header::HOST, value);
    }

    if let Some(host) = request_headers.get(header::HOST) {
        target_headers.insert("x-forwarded-host", host.clone());
    }

    target_headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    target_headers.insert("x-forwarded-port", HeaderValue::from_static("80"));
    target_headers.insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));

    if let Some(cookie_header) = cookie_header {
        if let Ok(value) = HeaderValue::from_str(cookie_header) {
            target_headers.insert(header::COOKIE, value);
        }
    }
}

fn format_host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn to_upstream_message(message: AxumMessage) -> Option<UpstreamMessage> {
    match message {
        AxumMessage::Text(text) => Some(UpstreamMessage::Text(text.to_string().into())),
        AxumMessage::Binary(bytes) => Some(UpstreamMessage::Binary(bytes)),
        AxumMessage::Ping(bytes) => Some(UpstreamMessage::Ping(bytes)),
        AxumMessage::Pong(bytes) => Some(UpstreamMessage::Pong(bytes)),
        AxumMessage::Close(frame) => Some(UpstreamMessage::Close(frame.map(|frame| {
            UpstreamCloseFrame {
                code: CloseCode::from(frame.code),
                reason: frame.reason.to_string().into(),
            }
        }))),
    }
}

fn to_client_message(message: UpstreamMessage) -> Option<AxumMessage> {
    match message {
        UpstreamMessage::Text(text) => Some(AxumMessage::Text(text.to_string().into())),
        UpstreamMessage::Binary(bytes) => Some(AxumMessage::Binary(bytes)),
        UpstreamMessage::Ping(bytes) => Some(AxumMessage::Ping(bytes)),
        UpstreamMessage::Pong(bytes) => Some(AxumMessage::Pong(bytes)),
        UpstreamMessage::Close(frame) => {
            Some(AxumMessage::Close(frame.map(|frame| AxumCloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            })))
        }
        UpstreamMessage::Frame(_) => None,
    }
}
