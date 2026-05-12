# tests/browser

Cross-browser playback tests for `@moq/watch`, driven by **WebdriverIO** against **Sauce Labs** or **BrowserStack** (pick with `--provider`). Eight targets, one stack:

| Tag | Tier | OS | Browser |
|---|---|---|---|
| `chrome-windows`  | VDC | Windows 11 | Chrome (latest) |
| `firefox-windows` | VDC | Windows 11 | Firefox (latest) |
| `edge-windows`    | VDC | Windows 11 | Edge (latest) |
| `safari-macos`    | VDC | macOS 13   | Safari (latest) |
| `chrome-macos`    | VDC | macOS 13   | Chrome (latest) |
| `firefox-macos`   | VDC | macOS 13   | Firefox (latest) |
| `safari-ios`      | RDC | iOS 26+    | Safari on real iPhone |
| `chrome-android`  | RDC | Android 16 | Chrome on real device |

VDC = Sauce Virtual Device Cloud (desktop VMs). RDC = Sauce Real Device Cloud (Appium 2).

## Setup

```bash
bun install
cp .env.example .env.local
# fill in credentials in .env.local
```

`.env.local` is `.gitignore`d. Bun loads `.env`, `.env.{NODE_ENV}`, and `.env.local` automatically before `run.ts` starts; shell env still wins over file vars if both are set.

Credentials are env-only on purpose — keep secrets out of your shell history *and* out of CLI flags (process listings, screen-share). Everything else is a CLI flag.

## CLI

```
bun run.ts --help
```

```
Usage: bun run.ts [options] [device-tag...]

Options:
      --provider <p>     sauce | browserstack [default sauce]
  -p, --page <url>       Watch page URL [default https://moq.dev/watch/]
  -u, --url <url>        Relay URL      [default https://cdn.moq.dev/demo]
  -n, --name <name>      Broadcast name [default bbb]
  -t, --duration <ms>    Playback duration in ms [default 20000]
      --tunnel <id>      Local-tunnel identifier (Sauce Connect or BrowserStackLocal)
      --region <region>  Sauce data center [default eu-central-1] (Sauce only)
      --build <name>     Build label for grouping runs
  -l, --local            Shorthand: --page http://localhost:5273/index.html
  -h, --help             Show help
```

Examples:

```bash
bun run.ts                                       # all 8 on sauce
bun run.ts --provider browserstack               # all 8 on browserstack
bun run.ts safari-ios chrome-android             # real-mobile pair (sauce)
bun run.ts --provider browserstack safari-ios    # iOS real device on browserstack
bun run.ts -l safari-macos                       # macOS Safari against local dev
bun run.ts --tunnel moq-local -l                 # whole matrix vs local via tunnel
bun run.ts -t 30000 -n bigbuck chrome-windows
```

## Targeting your local branch

`https://moq.dev/watch/` runs whatever's published, not this branch's logs. To validate against real Sauce/BrowserStack browsers, expose `demo/web` via the provider's local tunnel:

**Sauce Connect:**

```bash
# Download once: https://docs.saucelabs.com/secure-connections/sauce-connect-5/installation/
sc-5 -u "$SAUCE_USERNAME" -k "$SAUCE_ACCESS_KEY" --region eu-central -i moq-local
bun run --cwd demo/web dev -- --port 5273 --strictPort
bun run --cwd tests/browser test -- --tunnel moq-local -l
```

**BrowserStackLocal:**

```bash
# Download once: https://www.browserstack.com/local-testing/automate
BrowserStackLocal --key "$BROWSERSTACK_ACCESS_KEY" --local-identifier moq-local
bun run --cwd demo/web dev -- --port 5273 --strictPort
bun run --cwd tests/browser test -- --provider browserstack --tunnel moq-local -l
```

With `--tunnel <id>`, the runner sets `tunnelIdentifier` (Sauce) or `local: true, localIdentifier: <id>` (BrowserStack) on every session's options block so the provider routes localhost back through your tunnel.

## Manual + Claude review workflow

After a run, build a digest from the per-session artifacts and paste it into Claude alongside `EXPECTED.md`:

```bash
cd tests/browser
# One-line table of session counts
for d in test-results/*/; do
  jq -r '[.tag, .userAgent, .totalEvents, .errors] | @tsv' "$d/summary.json"
done | column -t

# All errors and warnings across every session
find test-results -name console.ndjson -exec jq -c 'select(.level=="error" or .level=="warning")' {} \;

# Filter to [moq] lines from this branch's instrumentation
find test-results -name console.ndjson -exec jq -c 'select(.text | startswith("[moq]"))' {} \;
```

Drop those outputs and `EXPECTED.md` into a Claude conversation and ask:

> Compare observed behavior against EXPECTED.md. For each session list match/mismatch points, flag regressions, distinguish known issues from new findings.

Automate the comparison once we have enough runs to know what's worth checking.

## What's captured per session

WebDriver's `getLogs('browser')` is unreliable on iOS Safari, so the runner injects a small JS shim into the page that wraps `console.{log,info,warn,error,debug}` and captures `error` + `unhandledrejection` events into `window.__moqLogs`. The shim is installed after navigation, so first-render logs are occasionally missed on Android Chrome but the steady-state stream lands cleanly.

Per-session artifacts under `tests/browser/test-results/<tag>-<sessionId>/`:

- `console.ndjson` — per-event NDJSON: `{ t, level, text, args }`.
- `summary.json` — counts + metadata (tag, sessionId, userAgent, relay/broadcast/page, duration).

Sauce-side artifacts (session video, Appium logs, network HAR) are accessible from the Sauce dashboard build link printed at the end of every run.

## Fleet versions

The iOS/Android `platformVersion` and the macOS/Windows `platformName` are hardcoded in `run.ts` to match Sauce's trial catalog at the time of writing (iPhone 15 / iOS 26, Samsung Galaxy S23 FE / Android 16, macOS 13, Windows 11). When Sauce rotates its trial fleet, the test will fail with `"couldn't find a matching device"` listing the actual candidates — edit the values inline.

## Why no Linux

Sauce retired Linux desktop VMs years ago and BrowserStack doesn't ship Linux desktop VMs in their automate fleet either. If a Linux-only bug surfaces, run wdio locally against a system Chrome/Firefox.
