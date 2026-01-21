# Session Changes Summary

This document summarizes the changes applied during the current support session.

## Terminal Performance & History
- Reduced terminal history limits and set defaults to lower memory usage.
- Persisted smaller history snapshots to disk to reduce IO pressure.
- Added history auto-load when scrolling to the top, with buffering during reloads.

## Terminal Connectivity & Reliability
- Added server-to-client heartbeat messages to detect stale WebSocket connections.
- Filtered control ping strings so they do not appear in terminal output.

## Terminal UI
- Added a per-terminal refresh button to remount and reconnect a pane.

## Rendering Performance
- Enabled a "performance mode" by default: smaller scrollback and no WebGL renderer.

## Clipboard & Paste
- Prioritized text paste; only upload images when no text exists on the clipboard.
- Expanded accepted image types and added server-side content sniffing for unknown types.

## Mobile Experience
- Improved scroll mode behavior (long-press no longer exits immediately).
- Reduced accidental swipe-to-switch so vertical scrolling works reliably.

## Diagnostics
- Added WebSocket RTT diagnostics and server event loop timing in Settings.
