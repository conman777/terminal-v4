# Device ID relay connections

Terminal v4 can route paired runtime connections through a trusted self-hosted broker when the device cannot accept inbound connections. The remote host opens one outbound WebSocket to the broker. Browsers continue to use their home server; its JWT is never sent to the broker or target device. Pairing issues a separate, revocable credential bound to the remote account and its permission profile.

## Configure the broker

Run a separate Terminal v4 server with a persistent data directory. Set `TERMINAL_V4_RELAY_SERVER_KEY` to a randomly generated shared registration secret of 32 to 256 characters. Serve it through HTTPS using a reverse proxy that forwards WebSocket upgrades. Do not expose a plain HTTP broker outside loopback. No broker deployment or local service installation happens automatically.

## Configure each remote host

Set these environment variables on the host's server process, then restart it:

- `TERMINAL_V4_RELAY_URL=https://relay.example.com`
- `TERMINAL_V4_RELAY_KEY=<the broker registration secret>`

The server starts and reconnects its outbound registration automatically, backing off from 1 to 30 seconds after connection loss. Its local API remains behind its normal authentication. The device UUID is the same persistent identity shown in the environment address book. A separate random registration secret is kept in the host database; the broker pins its hash to the UUID at first registration. Sharing the broker key does not let another host replace an already registered UUID without that host's registration secret. Preserve the host and broker databases across upgrades. A restored clone of a device database carries the same identity and must not run concurrently as a different machine.

## Pair and connect

Open Environments → Connect by device ID. On the remote device, create a short-lived pairing code with the desired permission profile. Enter the broker HTTPS origin, the remote device UUID, its pairing code, and a device name. The home server exchanges the code through the broker, validates the returned device identity, encrypts the credential in its own database, and stores the broker device prefix as that environment's destination. Use the saved environment as usual. Terminal and structured WebSockets, previews, downloads, and service tunnels retain that prefix.

The broker forwards only pairing exchange/check/release and explicitly permitted runtime routes. Login, vault, administrator settings, nested environment proxies and relay management are excluded. It accepts only paired credentials on runtime requests. Host-side validation repeats this boundary. Pairing codes and credentials are sent in request bodies/headers, never URLs. The remote server still enforces the grant's actual capabilities. Removing a grant rejects subsequent requests and closes its relayed WebSockets.

## Limits and trust

This is a trusted relay, not end-to-end encryption. The relay operator can read relayed traffic, including pairing exchanges and runtime credentials; TLS protects the home-to-broker and host-to-broker connections. Use a broker you control and protect its registration secret. HTTPS certificates are verified normally. Plain HTTP is accepted only for loopback development and tests.

The broker allows at most 128 connected devices and 32 concurrent streams per device. Binary payload chunks are at most 64 KiB, per-stream queues hold eight events, and the shared socket queue holds 128 frames. Slow readers apply bounded backpressure and are disconnected when they exceed deadlines. HTTP requests are capped at 32 MiB at the relay (the paired proxy has its own smaller request cap); responses stream up to 1 GiB with a 60-second idle timeout. Relayed WebSocket messages are limited to 64 KiB. Streams terminate when the registration connection drops; the existing terminal reconnect/replay logic can reattach after the host reconnects. Long file transfers should use the chunked transfer API.

## Verification

`cargo test -p terminal-v4-api --lib device_relay` covers origin validation, runtime boundaries, real outbound registration and wrong-secret rejection, plus three independent servers performing device-ID pairing, real PTY WebSocket input/output, a 1 MiB binary download, a 256 KiB TCP tunnel, server isolation, and access revocation. The frontend `DeviceRelayPanel.test.jsx` checks stable identity, pairing payloads, home routing, and error recovery. Tests use loopback and temporary databases; production TLS termination and internet reachability require deployment verification.
