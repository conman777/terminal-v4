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

The broker allows at most 128 connected devices and 32 concurrent streams per device. Binary payload chunks are at most 64 KiB plus the 17-byte stream/type header; per-stream queues hold eight events and the shared socket queue holds 128 frames. Slow readers apply bounded backpressure and are disconnected when they exceed deadlines. HTTP requests are capped at 32 MiB at the relay (the paired proxy has its own smaller request cap); responses stream up to 1 GiB with a 60-second idle timeout. Long file transfers should use the chunked transfer API.

Upgraded hosts request `x-terminal-v4-relay-fragments: 1` during registration, and an upgraded broker acknowledges the same response header. Preserve both headers across WebSocket upgrade proxies. When negotiated, complete text/binary WebSocket messages of up to **8 MiB**, including their serialized event envelope, travel in bounded continuation chunks. UTF-8 is validated after reassembly. Reassembly stays capped at 8 MiB per active stream and enqueueing a whole message has a ten-second deadline. Without acknowledgement, complete messages retain the **64 KiB** legacy limit. Upgrade both host and broker to enable larger messages; new hosts do not send continuation chunks to an unacknowledged peer.

A new broker closes an unsupported or oversized message with code **1009** and a recovery reason. The home paired proxy preserves that code/reason. The structured conversation consumer stops reconnecting and starts one authenticated, environment-scoped recovery of the existing owned session-history route. An expired home session may use the normal authentication refresh flow and retry that GET once; these authentication requests do not send conversation input. Recovery is capped at **20 MiB of decoded response bytes**, **32,768 canonical events** and **15 seconds**; it does not send input or relax the remote grant. Saved history replaces partial replay once, retaining canonical message IDs and sequence numbers. Desktop and mobile disable Send in history-only mode while keeping controller drafts editable and retained; the hook also synchronously rejects captured Send/retry callbacks, including sends awaiting preparation before a POST. Existing observer read-only restrictions remain in force. A persistent recovery status outside the scrolling transcript remains visible on desktop and mobile. The visible notice identifies history-only mode: later live output is paused until the user reloads after upgrading, or uses a direct connection. Failed, revoked, malformed or oversized recovery preserves already visible text and displays a recovery error. Auth/environment changes and unmount abort and discard stale responses. Old broker releases that do not emit diagnostic 1009 closes must themselves be upgraded; a reasonless disconnect cannot reliably be identified as a message-size failure.

Ordinary registration loss still uses the existing reconnect/replay behavior. Service tunnels separately negotiate `x-terminal-v4-tcp-half-close: 1` in the request and response; after acknowledgement, an empty binary message signals write EOF while the opposite direction remains open. Legacy peers retain full-close-on-EOF behavior. Relay proxies preserve that negotiation header.

## Verification

`cargo test -p terminal-v4-api --lib device_relay` covers origin validation, runtime boundaries, real outbound registration and wrong-secret rejection, plus three independent servers performing device-ID pairing, real PTY WebSocket input/output, a 1 MiB binary download, a 256 KiB TCP tunnel, server isolation, and access revocation. The frontend `DeviceRelayPanel.test.jsx` checks stable identity, pairing payloads, home routing, and error recovery. Tests use loopback and temporary databases; production TLS termination and internet reachability require deployment verification.

The opt-in `e2e/relay-recovery.spec.ts` uses the current API binary, three independent loopback API instances, an isolated Chrome profile and the actual structured hook. It checks a registration-header stripping shim for legacy 64 KiB behavior, negotiated delivery above 64 KiB, and HTTP recovery for a 9 MiB event above the negotiated limit. The shim is not an old-release binary deployment test. See the testing guide for the command.
