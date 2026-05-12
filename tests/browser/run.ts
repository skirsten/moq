import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { remote } from "webdriverio";

// Drive Sauce Labs or BrowserStack browser sessions via WebDriverIO's library API.
// The @wdio/cli test-runner has an IPC issue under Node 24 (process.send EINVAL when
// forking workers); the library API has no such trouble and for a single playback
// session per device, mocha buys us nothing.

const HELP = `\
Usage: bun run.ts [options] [device-tag...]

Runs a 20s playback session per device against Sauce Labs or BrowserStack and
writes per-session console.ndjson + summary.json under test-results/.

Device tags (omit to run all):
  chrome-windows   firefox-windows   edge-windows
  safari-macos     chrome-macos      firefox-macos
  safari-ios       chrome-android

Options:
      --provider <p>     sauce | browserstack [default sauce]
  -p, --page <url>       Watch page URL [default https://moq.dev/watch/]
  -u, --url <url>        Relay URL      [default https://cdn.moq.dev/demo]
  -n, --name <name>      Broadcast name [default bbb]
  -t, --duration <ms>    Playback duration in ms [default 20000]
      --tunnel <id>      Local-tunnel identifier (Sauce Connect or BrowserStackLocal)
      --region <region>  Sauce data center [default eu-central-1] (Sauce only)
      --build <name>     Build label for grouping runs in the provider dashboard
  -l, --local            Shorthand: --page http://localhost:5273/index.html
  -h, --help             Show this help

Credentials (required, env only — never put secrets on the command line):
  SAUCE_USERNAME  SAUCE_ACCESS_KEY            (when --provider sauce)
  BROWSERSTACK_USERNAME  BROWSERSTACK_ACCESS_KEY  (when --provider browserstack)

Examples:
  bun run.ts                                  # all 8 on sauce
  bun run.ts --provider browserstack          # all 8 on browserstack
  bun run.ts safari-ios chrome-android        # real-mobile pair on sauce
  bun run.ts -l --tunnel moq-local            # whole matrix vs local dev
`;

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		provider: { type: "string" },
		page: { type: "string", short: "p" },
		url: { type: "string", short: "u" },
		name: { type: "string", short: "n" },
		duration: { type: "string", short: "t" },
		tunnel: { type: "string" },
		region: { type: "string" },
		build: { type: "string" },
		local: { type: "boolean", short: "l" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

type ProviderName = "sauce" | "browserstack";
const PROVIDER: ProviderName = (values.provider ?? "sauce") as ProviderName;
if (PROVIDER !== "sauce" && PROVIDER !== "browserstack") {
	console.error(`error: --provider must be 'sauce' or 'browserstack', got '${PROVIDER}'`);
	process.exit(2);
}

const BUILD = values.build ?? `local-${new Date().toISOString().slice(0, 10)}`;
const TUNNEL = values.tunnel;

const RELAY_URL = values.url ?? "https://cdn.moq.dev/demo";
const BROADCAST = values.name ?? "bbb";
const PAGE = values.local ? "http://localhost:5273/index.html" : (values.page ?? "https://moq.dev/watch/");
const PLAYBACK_MS = Number.parseInt(values.duration ?? "20000", 10);

// === Logical target definitions (provider-agnostic) ============================================

type DesktopBrowser = "chrome" | "firefox" | "edge" | "safari";
type DesktopOs = "windows" | "macos";

type DesktopTarget = {
	tag: string;
	name: string;
	kind: "desktop";
	browser: DesktopBrowser;
	os: DesktopOs;
	osVersion: string; // "11", "13", etc.
};

type MobileTarget = {
	tag: string;
	name: string;
	kind: "mobile";
	platform: "iOS" | "Android";
	browser: "safari" | "chrome";
	device: string; // device-name pattern
	osVersion: string;
};

type Target = DesktopTarget | MobileTarget;

// Fleet defaults reflect Sauce's trial catalog (iPhone 15 / iOS 26, Samsung S23 FE / Android 16)
// and BrowserStack's commonly available real devices. Edit inline if your account's fleet
// rotates; the provider error message will list matching candidates.
const TARGETS: Target[] = [
	{
		tag: "chrome-windows",
		name: "Chrome / Windows 11",
		kind: "desktop",
		browser: "chrome",
		os: "windows",
		osVersion: "11",
	},
	{
		tag: "firefox-windows",
		name: "Firefox / Windows 11",
		kind: "desktop",
		browser: "firefox",
		os: "windows",
		osVersion: "11",
	},
	{
		tag: "edge-windows",
		name: "Edge / Windows 11",
		kind: "desktop",
		browser: "edge",
		os: "windows",
		osVersion: "11",
	},
	{
		tag: "safari-macos",
		name: "Safari / macOS 13",
		kind: "desktop",
		browser: "safari",
		os: "macos",
		osVersion: "13",
	},
	{
		tag: "chrome-macos",
		name: "Chrome / macOS 13",
		kind: "desktop",
		browser: "chrome",
		os: "macos",
		osVersion: "13",
	},
	{
		tag: "firefox-macos",
		name: "Firefox / macOS 13",
		kind: "desktop",
		browser: "firefox",
		os: "macos",
		osVersion: "13",
	},
	{
		tag: "safari-ios",
		name: "Safari / iOS (real device)",
		kind: "mobile",
		platform: "iOS",
		browser: "safari",
		device: "iPhone.*",
		osVersion: "26",
	},
	{
		tag: "chrome-android",
		name: "Chrome / Android (real device)",
		kind: "mobile",
		platform: "Android",
		browser: "chrome",
		device: ".*",
		osVersion: "16",
	},
];

// === Provider adapters ==========================================================================

// biome-ignore lint/suspicious/noExplicitAny: caps are loosely typed JSON
type Caps = Record<string, any>;

interface Provider {
	hostname: string;
	port: number;
	protocol: "https";
	path: string;
	credentials(): { user: string; key: string };
	capsFor(t: Target, sessionName: string): Caps;
}

const SAUCE: Provider = {
	hostname: `ondemand.${values.region ?? "eu-central-1"}.saucelabs.com`,
	port: 443,
	protocol: "https",
	path: "/wd/hub",
	credentials() {
		const user = process.env.SAUCE_USERNAME ?? "";
		const key = process.env.SAUCE_ACCESS_KEY ?? "";
		if (!user || !key) throw new Error("set SAUCE_USERNAME and SAUCE_ACCESS_KEY");
		return { user, key };
	},
	capsFor(t, sessionName) {
		const sauceOpts: Caps = {
			name: sessionName,
			build: BUILD,
			...(TUNNEL ? { tunnelIdentifier: TUNNEL } : {}),
		};
		if (t.kind === "desktop") {
			return {
				browserName: t.browser === "edge" ? "MicrosoftEdge" : t.browser,
				browserVersion: "latest",
				platformName: t.os === "windows" ? `Windows ${t.osVersion}` : `macOS ${t.osVersion}`,
				"sauce:options": sauceOpts,
			};
		}
		return {
			platformName: t.platform,
			browserName: t.browser === "safari" ? "Safari" : "Chrome",
			"appium:automationName": t.platform === "iOS" ? "XCUITest" : "UiAutomator2",
			"appium:deviceName": t.device,
			"appium:platformVersion": t.osVersion,
			"sauce:options": { ...sauceOpts, deviceOrientation: "PORTRAIT", appiumVersion: "latest" },
		};
	},
};

const BROWSERSTACK: Provider = {
	hostname: "hub-cloud.browserstack.com",
	port: 443,
	protocol: "https",
	path: "/wd/hub",
	credentials() {
		const user = process.env.BROWSERSTACK_USERNAME ?? "";
		const key = process.env.BROWSERSTACK_ACCESS_KEY ?? "";
		if (!user || !key) throw new Error("set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY");
		return { user, key };
	},
	capsFor(t, sessionName) {
		const bstackOpts: Caps = {
			sessionName,
			buildName: BUILD,
			...(TUNNEL ? { local: true, localIdentifier: TUNNEL } : {}),
		};
		if (t.kind === "desktop") {
			return {
				browserName: t.browser === "edge" ? "Edge" : t.browser,
				browserVersion: "latest",
				"bstack:options": {
					...bstackOpts,
					os: t.os === "windows" ? "Windows" : "OS X",
					osVersion: t.osVersion,
				},
			};
		}
		return {
			browserName: t.browser,
			"bstack:options": {
				...bstackOpts,
				deviceName: t.device,
				osVersion: t.osVersion,
				realMobile: true,
			},
		};
	},
};

const PROVIDERS: Record<ProviderName, Provider> = { sauce: SAUCE, browserstack: BROWSERSTACK };
const provider = PROVIDERS[PROVIDER];

// === Console capture shim =======================================================================

function SHIM_FN(): void {
	// biome-ignore lint/suspicious/noExplicitAny: shim installed in browser context
	const w = window as any;
	if (w.__moqLogs) return;
	const buf: Array<{ t: number; level: string; args: unknown[] }> = [];
	w.__moqLogs = buf;
	const levels = ["log", "info", "warn", "error", "debug"] as const;
	for (const level of levels) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic console wrap
		const orig = (console as any)[level];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic console wrap
		(console as any)[level] = (...rawArgs: unknown[]) => {
			try {
				buf.push({
					t: Date.now(),
					level,
					args: rawArgs.map((a) => {
						try {
							return typeof a === "string" ? a : JSON.parse(JSON.stringify(a));
						} catch {
							return String(a);
						}
					}),
				});
			} catch {}
			if (orig) orig.apply(console, rawArgs);
		};
	}
	window.addEventListener("error", (e) => {
		buf.push({ t: Date.now(), level: "error", args: [`[pageerror] ${e.message || e}`] });
	});
	window.addEventListener("unhandledrejection", (e) => {
		const reason = e.reason as { message?: string } | undefined;
		buf.push({
			t: Date.now(),
			level: "error",
			args: [`[unhandledrejection] ${reason?.message ?? String(e.reason)}`],
		});
	});
}

// === Run loop ===================================================================================

const wanted = positionals.length > 0 ? positionals.map((s) => s.toLowerCase()) : TARGETS.map((t) => t.tag);
const targets = TARGETS.filter((t) => wanted.includes(t.tag));
if (targets.length === 0) {
	console.error(`no targets matched ${positionals.join(", ")}. Available tags:`);
	for (const t of TARGETS) console.error(`  ${t.tag.padEnd(18)} ${t.name}`);
	process.exit(2);
}

const { user, key } = provider.credentials();
const remoteOpts = {
	hostname: provider.hostname,
	port: provider.port,
	protocol: provider.protocol,
	path: provider.path,
	user,
	key,
	logLevel: "warn",
} as const;

console.log(`provider: ${PROVIDER}  page: ${PAGE}  url: ${RELAY_URL}  name: ${BROADCAST}\n`);

let exitCode = 0;
for (const target of targets) {
	console.log(`\n=== ${target.name} ===`);
	let browser: WebdriverIO.Browser | undefined;
	try {
		browser = await remote({
			...remoteOpts,
			capabilities: provider.capsFor(target, `moq ${target.tag}`) as WebdriverIO.Capabilities,
		});

		const url = `${PAGE}?url=${encodeURIComponent(RELAY_URL)}&name=${encodeURIComponent(BROADCAST)}`;
		console.log(`navigating to ${url}`);

		// `browser.url()` on Sauce real iOS Safari often returns while the document is still
		// about:blank. Driving location.href from JS as a fallback gets us past it.
		await browser.url(url);
		// biome-ignore lint/suspicious/noExplicitAny: passing a string arg into the browser
		await browser.execute(
			((u: any) => {
				window.location.href = u;
			}) as unknown as () => void,
			url,
		);
		const b = browser;
		await b.waitUntil(
			async () => {
				const href = (await b.execute(() => location.href)) as string;
				return Boolean(href) && !href.startsWith("about:");
			},
			{ timeout: 30_000, interval: 500, timeoutMsg: "page never left about:blank" },
		);

		const probe = (await browser.execute(() => ({
			ua: navigator.userAgent,
			href: location.href,
			readyState: document.readyState,
		}))) as { ua: string; href: string; readyState: string };
		console.log(`  navigated: ${probe.readyState} ${probe.href}`);

		await browser.execute(SHIM_FN);
		await browser.pause(PLAYBACK_MS);

		const logs = (await browser.execute(
			() =>
				(window as unknown as { __moqLogs?: Array<{ t: number; level: string; args: unknown[] }> }).__moqLogs ??
				[],
		)) as Array<{ t: number; level: string; args: unknown[] }>;

		const outDir = join(
			process.cwd(),
			"test-results",
			`${PROVIDER}-${target.tag}-${browser.sessionId ?? "session"}`,
		);
		mkdirSync(outDir, { recursive: true });

		writeFileSync(
			join(outDir, "console.ndjson"),
			logs
				.map((l) => JSON.stringify({ t: l.t, level: l.level, text: String(l.args[0]), args: l.args }))
				.join("\n"),
		);

		const moqEvents = logs.filter((l) => String(l.args[0]).includes("[moq]"));
		const summary = {
			provider: PROVIDER,
			device: target.name,
			tag: target.tag,
			sessionId: browser.sessionId,
			userAgent: probe.ua,
			relayUrl: RELAY_URL,
			broadcast: BROADCAST,
			page: PAGE,
			durationMs: PLAYBACK_MS,
			totalEvents: logs.length,
			moqEvents: moqEvents.length,
			errors: logs.filter((l) => l.level === "error").length,
		};
		writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

		console.log(
			`  ✓ ${target.tag}: ${summary.totalEvents} events, ${summary.moqEvents} [moq], ${summary.errors} errors`,
		);
		console.log(`  artifacts: ${outDir}`);
	} catch (err) {
		exitCode = 1;
		console.error(`  ✗ ${target.tag} failed:`, err instanceof Error ? err.message : err);
	} finally {
		if (browser) {
			try {
				await browser.deleteSession();
			} catch {}
		}
	}
}

process.exit(exitCode);
