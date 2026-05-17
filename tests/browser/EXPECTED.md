# Expected behavior per browser

This document is the oracle for `run.ts` output. Pair it with the digest built from `test-results/` (jq snippets in `README.md`) when sending a run to Claude for analysis: Claude should compare each session's observed events against the expectations here and flag anything that doesn't match.

## Universal expectations

Every target should, in order:

1. Connect to the relay (default `https://cdn.moq.dev/demo`). Look for `connected via WebTransport` or `connected via WebSocket`.
2. Negotiate ALPN. Expect `negotiated ALPN: moq-lite-04` (or whatever the relay currently runs).
3. Receive the announce stream and see `announced: broadcast=bbb active=true` (or whichever broadcast name you set).
4. Subscribe to the catalog and receive it. Look for `received catalog hang bbb {video: Object, audio: Object}`.
5. Subscribe to the video + audio rendition tracks (`subscribe ok: id=N broadcast=bbb track=N.hang`).
6. Either render frames during the test window or (under tight pacing) emit `sync[video]: N late frame(s), max Nms behind` lines.
7. Produce zero or one transient errors during the initial connection swap, and zero errors during steady-state.

Failure signatures that are **always** a regression:

- 0 events captured anywhere.
- `Received RESET_STREAM` on the catalog subscribe (means the broadcast isn't actually announced at this relay path; check `relayUrl`/`broadcast` in `config.yml`).
- No `connected via` line at all (transport setup failed).
- Multiple repeated errors during steady-state.

## Per-browser expectations

### `chrome-windows`, `chrome-macos`, `edge-windows`, `chrome-android`

- **Transport**: WebTransport.
- **Codecs**: Full H264 + AAC (Edge / Chrome / Android Chrome ship the proprietary codec stack).
- **`SharedArrayBuffer`**: not guaranteed on cross-origin pages. `[audio] using postMessage audio buffer (SharedArrayBuffer unavailable)` is **expected**, not a regression.
- **Pacing**: desktop should be near zero late frames at steady state; mobile (`chrome-android`) commonly shows multi-frame late events (e.g. `sync[video]: 4 late frame(s), max 140ms behind`). Sustained 5+ late frames per tick is worth investigating.

### `safari-macos`

- **Transport**: **WebSocket fallback**. macOS Safari has not shipped WebTransport yet. `connected via WebSocket` is expected.
- **Codecs**: Full H264 + AAC.

### `safari-ios`

- **Transport**: WebTransport on iOS 17+ Safari (real-device runs). Older iOS would fall back to WebSocket. Flag a transport mismatch if iOS 17+ reports WebSocket.
- **Codecs**: Full H264 + AAC.
- **Pacing**: a small number of late frames is normal under cellular conditions. Sustained late-frame spam at WiFi is worth investigating.

### `firefox-windows`, `firefox-macos`

- **Transport**: WebSocket. Firefox's WebTransport drops incoming bidi streams (see `js/lite/src/connection/connect.ts:42`), so the client forces WebSocket. Look for `[moq] firefox: forcing WebSocket fallback (incoming bidi delivery bug)`.
- **Codecs**: H264/AAC may or may not be available depending on Firefox's bundled OpenH264. Warning lines like `[Source] No supported video renditions found: {0.hang: Object}` (with avc1) are a **codec gap on Firefox**, not a regression on our end. Audio-only or AV1/VP9 catalogs would render.
- **Pacing**: as desktop.
