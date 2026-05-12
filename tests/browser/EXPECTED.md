# Expected behavior per browser

This document is the oracle for `run.ts` output. Pair it with `report.md` (produced by `bun report.ts`) when sending a run to Claude for analysis: Claude should compare each session's observed events against the expectations here and flag anything that doesn't match.

## Universal expectations

Every target should, in order:

1. Connect to the relay (default `https://cdn.moq.dev/demo`). Look for `connected via WebTransport` or `connected via WebSocket`.
2. Negotiate ALPN. Expect `negotiated ALPN: moq-lite-04` (or whatever the relay currently runs).
3. Receive the announce stream and see `announced: broadcast=bbb active=true` (or whichever broadcast name you set).
4. Subscribe to the catalog and receive it. Look for `received catalog hang bbb {video: Object, audio: Object}`.
5. Subscribe to the video + audio rendition tracks (`subscribe ok: id=N broadcast=bbb track=N.hang`).
6. Either render frames during the test window or — under tight pacing — emit `sync[video]: N late frame(s), max Nms behind` lines.
7. Produce zero or one transient errors during the initial connection swap (see "Reload swap" below), and zero errors during steady-state.

Failure signatures that are **always** a regression:

- 0 events captured anywhere.
- `Received RESET_STREAM` on the catalog subscribe (means the broadcast isn't actually announced at this relay path; check `MOQ_URL`/`MOQ_BROADCAST`).
- No `connected via` line at all (transport setup failed).
- Multiple repeated errors during steady-state.

## Per-browser expectations

### `chrome-windows`, `chrome-macos`, `edge-windows`, `chrome-android`

- **Transport**: WebTransport.
- **Codecs**: Full H264 + AAC (Edge / Chrome / Android Chrome ship the proprietary codec stack).
- **`SharedArrayBuffer`**: not guaranteed on cross-origin pages. `[audio] using postMessage audio buffer (SharedArrayBuffer unavailable)` is **expected**, not a regression.
- **Pacing**: desktop should be near zero late frames at steady state; mobile (`chrome-android`) commonly shows multi-frame late events (e.g. `sync[video]: 4 late frame(s), max 140ms behind`). Sustained 5+ late frames per tick is worth investigating.

### `safari-macos`

- **Transport**: **WebSocket fallback** — macOS Safari has not shipped WebTransport yet. `connected via WebSocket` is expected.
- **Codecs**: Full H264 + AAC.
- **Known intermittent**: `Unhandled Promise Rejection: TypeError: ReadableStreamDefaultController is not in a state where chunk can be enqueued`. This fires during the initial reload-swap when the first WebSocket is closed; one occurrence is the known pattern. **Multiple occurrences** during steady-state are a regression.

### `safari-ios`

- **Transport**: WebTransport on iOS 17+ Safari (real-device runs). Older iOS would fall back to WebSocket — flag a transport mismatch if iOS 17+ reports WebSocket.
- **Codecs**: Full H264 + AAC.
- **Pacing**: a small number of late frames is normal under cellular conditions. Sustained late-frame spam at WiFi is worth investigating.
- **No `ReadableStreamDefaultController` error** is expected. If it shows up, it's not the macOS-Safari pattern — investigate.

### `firefox-windows`, `firefox-macos`

- **Transport**: WebSocket. Firefox's WebTransport drops incoming bidi streams (see `js/lite/src/connection/connect.ts:42`), so the client forces WebSocket. If this branch's logs are deployed, look for `[moq] firefox: forcing WebSocket fallback (incoming bidi delivery bug)`.
- **Codecs**: H264/AAC may or may not be available depending on Firefox's bundled OpenH264. Warning lines like `[Source] No supported video renditions found: {0.hang: Object}` (with avc1) are a **codec gap on Firefox**, not a regression on our end. Audio-only or AV1/VP9 catalogs would render.
- **Pacing**: as desktop.

## Logs from this branch (`test/browser-tracing`)

When the test points at the local dev server (via `SAUCE_TUNNEL_ID` + `MOQ_PAGE_URL=http://localhost:5273/index.html`), the workaround sites log `[moq] ...`. Each only fires when its branch is taken:

- `[moq] firefox: forcing WebSocket fallback (incoming bidi delivery bug)` — only on Firefox.
- `[moq] audio context created { ... }` — fires once when the `AudioContext` is first instantiated.
- `[moq] audio: clamping decoded channels { decoded: N, ring: M }` — only fires when Firefox's Opus decoder emits more channels than requested.
- `[moq] safari workaround: rewriting codec { from: avc3.*, to: avc1.* }` — only fires on Safari when the catalog uses `avc3.*`.
- `[moq] encoder: selected { codec, mode }` — only on the publish side; not expected in the watch-only playback test.
- `[moq] capture: using native MediaStreamTrackProcessor { zeroOffsetUs }` — only on publish.

The `dumpEnv()` helper in `js/hang/src/util/hacks.ts` is exported but not auto-called; the test harness can fire it via `browser.execute()` if a one-shot `[moq] env { userAgent, platform, engine, isMobile }` line is wanted. When the test points at `https://moq.dev/watch/` (the default), **no `[moq]` events fire** because the deployed build predates this branch — `moqEvents == 0` is expected there.

## Reload swap log

You'll see this once per connection on most browsers:

```
log     connected via WebTransport (or WebSocket)
debug   negotiated ALPN: moq-lite-04
error   fatal error running connection WebTransportError: The session is closed.  (or just "undefined")
log     connected via WebTransport
debug   negotiated ALPN: moq-lite-04
```

This is the `Reload` wrapper doing its initial connection swap (close the first, open the second so the resulting connection is the long-lived one). One pair is normal. Repeated swaps mid-session are a regression.

## How to use this with Claude

1. Run the matrix: `bun run --cwd tests/browser test` (after exporting Sauce credentials).
2. Build a digest from `tests/browser/test-results/` using the `jq` snippets in `README.md`.
3. Paste this `EXPECTED.md` plus the digest into a Claude conversation, then ask "compare observed against expected, list each session's match-or-mismatch, surface any regressions worth investigating, and tell me which observations are previously-known issues vs new."
