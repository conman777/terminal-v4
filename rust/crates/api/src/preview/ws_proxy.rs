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
    "authorization",
    "cookie",
    "referer",
];

type UpstreamSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub struct PreparedWebSocket {
    socket: UpstreamSocket,
    protocol: Option<String>,
    log: super::ws_logs::ConnectionLog,
}

impl PreparedWebSocket {
    pub fn selected_protocol(&self) -> Option<&str> {
        self.protocol.as_deref()
    }

    pub async fn relay(self, client_socket: WebSocket) -> Result<(), String> {
        relay(client_socket, self.socket, self.log).await
    }
}

pub async fn prepare_websocket(
    telemetry: &super::ws_logs::WebSocketLogStore,
    owner: &str,
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) -> Result<PreparedWebSocket, String> {
    prepare_with_timeout(
        telemetry,
        owner,
        port,
        path,
        request_headers,
        cookie_header,
        HANDSHAKE_TIMEOUT,
    )
    .await
}

async fn prepare_with_timeout(
    telemetry: &super::ws_logs::WebSocketLogStore,
    owner: &str,
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
    timeout: std::time::Duration,
) -> Result<PreparedWebSocket, String> {
    let log = telemetry.open(owner, port, path);
    match tokio::time::timeout(
        timeout,
        connect_with_fallback(port, path, request_headers, cookie_header),
    )
    .await
    {
        Ok(Ok((socket, protocol))) => {
            log.status("connected");
            Ok(PreparedWebSocket {
                socket,
                protocol,
                log,
            })
        }
        result => {
            log.status("error");
            Err(match result {
                Ok(Err(error)) => error,
                _ => "Preview websocket upstream handshake timed out".into(),
            })
        }
    }
}

pub async fn proxy_websocket(
    client_socket: WebSocket,
    telemetry: &super::ws_logs::WebSocketLogStore,
    owner: &str,
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) -> Result<(), String> {
    prepare_websocket(telemetry, owner, port, path, request_headers, cookie_header)
        .await?
        .relay(client_socket)
        .await
}

async fn relay(
    mut client_socket: WebSocket,
    upstream_socket: UpstreamSocket,
    log: super::ws_logs::ConnectionLog,
) -> Result<(), String> {
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
                        record_message(&log, "sent", &upstream_message);
                        upstream_sender
                            .send(upstream_message)
                            .await
                            .map_err(|_| "Failed to send preview websocket message upstream".to_owned())?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(_error)) => {
                        return Err("Failed to receive preview websocket message from client".into());
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
                        record_message(&log, "received", &message);
                        let Some(client_message) = to_client_message(message) else {
                            continue;
                        };
                        let should_close = matches!(client_message, AxumMessage::Close(_));
                        client_socket
                            .send(client_message)
                            .await
                            .map_err(|_| "Failed to send preview websocket message to client".to_owned())?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(_error)) => {
                        let _ = client_socket
                            .send(AxumMessage::Close(Some(AxumCloseFrame {
                                code: 1011,
                                reason: "Preview websocket upstream error".into(),
                            })))
                            .await;
                        return Err("Failed to receive preview websocket message from upstream".into());
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

fn record_message(log: &super::ws_logs::ConnectionLog, direction: &str, message: &UpstreamMessage) {
    match message {
        UpstreamMessage::Text(text) => log.message(direction, text.as_bytes(), false),
        UpstreamMessage::Binary(bytes) => log.message(direction, bytes, true),
        _ => {}
    }
}

async fn connect_with_fallback(
    port: u16,
    path: &str,
    request_headers: &HeaderMap,
    cookie_header: Option<&str>,
) -> Result<(UpstreamSocket, Option<String>), String> {
    let hosts = super::proxy_hosts();
    if hosts.is_empty() {
        return Err("Preview websocket proxy hosts are not configured".to_string());
    }

    let mut last_error = None;

    for host in hosts {
        let target_url = format!("ws://{}:{port}{path}", format_host_for_url(&host));
        let mut request = target_url
            .into_client_request()
            .map_err(|_| "Failed to build preview websocket request".to_owned())?;
        populate_forward_headers(request.headers_mut(), port, request_headers, cookie_header);

        match connect_async(request).await {
            Ok((socket, response)) => {
                let protocol = response
                    .headers()
                    .get(header::SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                return Ok((socket, protocol));
            }
            Err(error) => {
                last_error = Some(match error {
                    tokio_tungstenite::tungstenite::Error::Http(response) => format!(
                        "Preview websocket upstream handshake returned HTTP {}",
                        response.status().as_u16()
                    ),
                    _ => "Preview websocket upstream handshake failed".into(),
                });
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
        if key == header::SEC_WEBSOCKET_PROTOCOL {
            target_headers.append(key, value.clone());
        } else {
            target_headers.insert(key, value.clone());
        }
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

#[cfg(test)]
mod handshake_regressions {
    use super::*;
    use axum::{routing::get, Router};
    use tokio_tungstenite::tungstenite::handshake::server::{
        Callback, ErrorResponse, Request, Response,
    };

    struct UpstreamHandshake {
        offered: Option<&'static str>,
        selected: Option<&'static str>,
        check_credentials: bool,
    }

    impl Callback for UpstreamHandshake {
        fn on_request(
            self,
            request: &Request,
            mut response: Response,
        ) -> Result<Response, ErrorResponse> {
            assert_eq!(
                request
                    .headers()
                    .get(header::SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|value| value.to_str().ok()),
                self.offered
            );
            if self.check_credentials {
                assert_eq!(request.headers()[header::COOKIE], "session=own");
                assert!(request.headers().get(header::AUTHORIZATION).is_none());
            }
            if let Some(selected) = self.selected {
                response
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, selected.parse().unwrap());
            }
            Ok(response)
        }
    }

    #[tokio::test]
    async fn prepared_handshake_forwards_only_upstream_selection_and_preserves_frames() {
        for (offered, selected) in [
            (Some("fixture.first, fixture.v1"), Some("fixture.v1")),
            (None, None),
        ] {
            let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = upstream.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                let (stream, _) = upstream.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    UpstreamHandshake {
                        offered,
                        selected,
                        check_credentials: true,
                    },
                )
                .await
                .unwrap();
                while let Some(Ok(message)) = socket.next().await {
                    if message.is_close() {
                        break;
                    }
                    socket.send(message).await.unwrap();
                }
            });
            let telemetry = super::super::ws_logs::WebSocketLogStore::default();
            let store = telemetry.clone();
            let router = Router::new().route(
                "/hmr",
                get(
                    move |ws: axum::extract::ws::WebSocketUpgrade, headers: HeaderMap| {
                        let store = store.clone();
                        async move {
                            let prepared = prepare_websocket(
                                &store,
                                "owner",
                                port,
                                "/hmr?synthetic=1",
                                &headers,
                                Some("session=own"),
                            )
                            .await
                            .unwrap();
                            let ws = ws.protocols(prepared.selected_protocol().map(str::to_owned));
                            ws.on_upgrade(move |socket| async move {
                                let _ = prepared.relay(socket).await;
                            })
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            let mut request = format!("ws://{address}/hmr").into_client_request().unwrap();
            if let Some(offered) = offered {
                request
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, offered.parse().unwrap());
            }
            request.headers_mut().insert(
                header::AUTHORIZATION,
                "Bearer synthetic-never-forward".parse().unwrap(),
            );
            request
                .headers_mut()
                .insert(header::COOKIE, "other-owner=never-forward".parse().unwrap());
            let (mut socket, response) = connect_async(request).await.unwrap();
            assert_eq!(
                response
                    .headers()
                    .get(header::SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|v| v.to_str().ok()),
                selected
            );
            socket
                .send(UpstreamMessage::Text("echo".into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                UpstreamMessage::Text("echo".into())
            );
            socket.close(None).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap();
            let snapshot =
                serde_json::to_value(telemetry.snapshot("owner", port, None, None)).unwrap();
            assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
            assert!(serde_json::to_string(&snapshot)
                .unwrap()
                .find("synthetic=1")
                .is_none());
            assert_eq!(
                serde_json::to_value(telemetry.snapshot("other", port, None, None)).unwrap()
                    ["messages"],
                serde_json::json!([])
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn timeout_and_cancellation_close_pending_upstream_and_log_scope() {
        for cancel in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let store = super::super::ws_logs::WebSocketLogStore::default();
            let telemetry = store.clone();
            let pending = tokio::spawn(async move {
                prepare_with_timeout(
                    &telemetry,
                    "owner",
                    port,
                    "/pending",
                    &HeaderMap::new(),
                    None,
                    std::time::Duration::from_millis(100),
                )
                .await
            });
            let (mut stream, _) = listener.accept().await.unwrap();
            use tokio::io::AsyncReadExt;
            let mut buffer = vec![0; 2048];
            assert!(stream.read(&mut buffer).await.unwrap() > 0);
            if cancel {
                pending.abort();
                let _ = pending.await;
            } else {
                assert!(pending.await.unwrap().is_err());
            }
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(1), stream.read(&mut buffer))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            let snapshot = serde_json::to_value(store.snapshot("owner", port, None, None)).unwrap();
            assert_eq!(
                snapshot["connections"][0]["status"],
                if cancel { "closed" } else { "error" }
            );
        }
    }

    #[tokio::test]
    async fn unsupported_upstream_protocol_fails_before_downstream_upgrade() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_hdr_async(
                stream,
                UpstreamHandshake {
                    offered: Some("fixture.v1"),
                    selected: Some("not-offered"),
                    check_credentials: false,
                },
            )
            .await
            .unwrap();
            drop(socket);
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            "fixture.v1".parse().unwrap(),
        );
        assert!(prepare_websocket(
            &super::super::ws_logs::WebSocketLogStore::default(),
            "owner",
            port,
            "/hmr",
            &headers,
            None
        )
        .await
        .is_err());
        task.await.unwrap();
    }
}

#[cfg(test)]
mod credential_forwarding_regressions {
    use super::*;
    #[test]
    fn application_credentials_are_removed_with_or_without_jar_cookie() {
        let mut incoming = HeaderMap::new();
        incoming.insert(
            header::COOKIE,
            "app-session=synthetic-secret".parse().unwrap(),
        );
        incoming.insert(
            header::AUTHORIZATION,
            "Bearer synthetic-secret".parse().unwrap(),
        );
        incoming.insert(
            header::REFERER,
            "http://app.invalid/preview?previewToken=synthetic-secret"
                .parse()
                .unwrap(),
        );
        incoming.append(
            header::SEC_WEBSOCKET_PROTOCOL,
            "fixture.first".parse().unwrap(),
        );
        incoming.append(
            header::SEC_WEBSOCKET_PROTOCOL,
            "fixture.v1".parse().unwrap(),
        );
        for cookie in [None, Some("session=owner-scoped")] {
            let mut outgoing = HeaderMap::new();
            populate_forward_headers(&mut outgoing, 5173, &incoming, cookie);
            assert!(outgoing.get(header::AUTHORIZATION).is_none());
            assert!(outgoing.get(header::REFERER).is_none());
            assert_eq!(
                outgoing.get(header::COOKIE).and_then(|v| v.to_str().ok()),
                cookie
            );
            assert_eq!(
                outgoing
                    .get_all(header::SEC_WEBSOCKET_PROTOCOL)
                    .iter()
                    .map(|v| v.to_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["fixture.first", "fixture.v1"]
            );
        }
    }
}
