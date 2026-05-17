# tests/browser

Cross-browser playback tests for `@moq/watch`, driven by **WebdriverIO** against **Sauce Labs**, **BrowserStack**, or your **local** browsers.

## One command

```bash
bun run --cwd tests/browser test
```

That runs **the whole matrix**. There are no CLI flags. The entire invocation lives in `config.yaml`. To run a different configuration, copy the file and pass its path:

```bash
bun run --cwd tests/browser test ./config.local.yaml
```

## Setup

```bash
bun install
cp .env.example .env.local      # then fill in credentials
```

`.env.local` is `.gitignore`d. Bun loads `.env` / `.env.local` automatically before `run.ts` starts. Credentials are env-only, never in `config.yaml`, never on the command line:

| Provider       | Env vars                                           |
| -------------- | -------------------------------------------------- |
| `sauce`        | `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`               |
| `browserstack` | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| `local`        | none (uses system browsers)                        |

## config.yaml

The whole run is described by `config.yaml`, validated with zod on load:

```yaml
page: local # "local" -> build+serve+tunnel demo/web; or a URL
relayUrl: https://cdn.moq.dev/demo
broadcast: bbb
playbackMs: 20000
providers: # per-provider settings, one section each
  sauce:
    region: eu-central-1
build: "" # dashboard label; "" -> local-YYYY-MM-DD
downloadVideo: true
targets: # the exact device matrix this run executes
  - tag: chrome-windows
    name: Chrome / Windows 11
    provider: sauce # sauce | browserstack | local, per target
    kind: desktop
    browser: chrome
    os: windows
    osVersion: "11"
  # ... 7 more
```

`targets` is the run list. To run a subset, trim the list (or keep a second config file).

**Each target picks its own `provider`**, so one run can mix clouds, the same Chrome/Windows on Sauce and BrowserStack, iOS on one and Android on the other, etc. Only the providers actually used need credentials; the run fails fast if any are missing. Artifact directories are prefixed with the provider (`sauce-chrome-windows-…`, `browserstack-chrome-windows-…`), so a tag may repeat across providers without colliding.

Each target is otherwise provider-agnostic. The provider adapter in `providers.ts` translates it (`platformName` + `sauce:options` for Sauce, `bstack:options` for BrowserStack, bare `browserName` for local).

## Providers

- **`sauce` / `browserstack`**: same `remote()` API, different endpoints and caps shape. Both support all 8 targets.
- **`local`**: runs the matching browser via WebdriverIO's auto-managed, auto-downloaded driver (chromedriver, geckodriver, msedgedriver, safaridriver). No credentials. Desktop only: mobile targets (`safari-ios`, `chrome-android`) are skipped with a warning. Headless. The OS suffix on desktop tags is informational locally. `chrome-windows` just means "the local Chrome".

Neither Sauce nor BrowserStack offers Linux desktop VMs; use `provider: local` on a Linux box for Linux coverage.

## `page: local`: testing your branch

`https://moq.dev/watch/` runs the _published_ `@moq/watch`. Set `page: local` to test this branch's code instead. The runner is fully self-contained. It:

1. **Builds** `demo/web` (`vite build`) to a temp dir. Tests the built output.
2. **Serves** it over a static server (sirv) on a random local port.
3. For remote providers, **tunnels** it via `cloudflared` (`https://*.trycloudflare.com`). The [`cloudflared`](https://www.npmjs.com/package/cloudflared) npm package downloads the binary on first use; `--protocol http2` so it works where QUIC/UDP is blocked.
4. Runs the matrix, then **tears it all down**: stops the tunnel + server, deletes the temp dir.

The page is `test.html`, a minimal `<moq-watch>` + debug panel (env, feature flags, AudioContext state, live stats).

## Artifacts

Per session under `tests/browser/test-results/<provider>-<tag>-<sessionId>/`:

- `console.ndjson`: every console event as `{ t, level, text, args }`. A JS shim wraps `console.*` + `error`/`unhandledrejection` (WebDriver's `getLogs` is unreliable on iOS Safari).
- `summary.json`: counts + metadata + `dashboardUrl` / `videoUrl` / `videoFile`.
- `video.mp4`: the provider's session recording (screen + audio), downloaded automatically (`downloadVideo: false` to skip). The runner clicks + unmutes the page so audio actually plays in the recording.

## AI-assisted video analysis

Console logs miss audio/video issues: silent stretches, frozen frames, distortion show up visually. `analyze.ts` post-processes the videos via ffmpeg:

```bash
# needs ffmpeg in PATH (brew install ffmpeg / sudo apt install ffmpeg)
bun run --cwd tests/browser analyze                       # every session
bun run --cwd tests/browser analyze sauce-chrome-windows-...  # one session
bun run --cwd tests/browser analyze -- --fps 2 --audio    # higher fps + extract audio.wav
```

Per-session `<session>/analyze/`:

| File                    | Shows                                                     |
| ----------------------- | --------------------------------------------------------- |
| `frames/frame_NNN.png`  | one frame/second. Frozen frames stand out                 |
| `waveform.png`          | stereo waveform. Silent regions are flat lines            |
| `spectrogram.png`       | frequency vs time. Pitch shift / dropouts / missing bands |
| `audio.wav` (`--audio`) | raw audio for offline FFT/comparison                      |

## Manual + Claude review

```bash
cd tests/browser
# session table
for d in test-results/*/; do jq -r '[.tag,.userAgent,.totalEvents,.errors]|@tsv' "$d/summary.json"; done | column -t
# errors + warnings everywhere
find test-results -name console.ndjson -exec jq -c 'select(.level=="error" or .level=="warning")' {} \;
# [moq] instrumentation lines
find test-results -name console.ndjson -exec jq -c 'select(.text | startswith("[moq]"))' {} \;
```

Paste those + `EXPECTED.md` (the per-browser oracle) + the `analyze/` images into a Claude conversation and ask it to compare observed vs expected, flag regressions, and distinguish known issues from new findings.

> Compare observed against expected, list each session's match-or-mismatch, surface any regressions worth investigating, and tell me which observations are previously-known issues vs new.

## Fleet versions

`osVersion` / `device` in `config.yaml` match Sauce's trial catalog at the time of writing (iPhone / iOS 26, Samsung S23 FE / Android 16). When a provider rotates its fleet a run fails with the available candidates listed. Update `config.yaml`.
