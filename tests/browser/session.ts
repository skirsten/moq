import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remote } from "webdriverio";
import { z } from "zod";
import type { Config, Target } from "./config.ts";
import type { Provider } from "./providers.ts";
import { LogEventSchema, SHIM_FN } from "./shim.ts";

// Values returned from browser.execute(), validated as they cross the WebDriver bridge.
const ProbeSchema = z.object({ ua: z.string(), href: z.string(), readyState: z.string() });
const AudioStateSchema = z.object({ state: z.string(), sampleRate: z.number(), baseLatency: z.number() }).nullable();

// Render one captured console arg as human-readable text for the ndjson `text` field.
// Strings pass through; Error-shaped objects (the shim serializes errors to
// {name, message, stack}) render as "name: message"; anything else is compact JSON.
function argText(a: unknown): string {
	if (typeof a === "string") return a;
	if (a && typeof a === "object") {
		const o = a as Record<string, unknown>;
		if (typeof o.message === "string") {
			return typeof o.name === "string" && o.name ? `${o.name}: ${o.message}` : o.message;
		}
		try {
			return JSON.stringify(a);
		} catch {
			return String(a);
		}
	}
	return String(a);
}

// Download a remote artifact with a few retries. Sauce in particular needs a few seconds
// after the session ends to finalize the video file.
async function downloadFile(
	url: string,
	dest: string,
	auth?: { user: string; key: string },
	retries = 4,
): Promise<boolean> {
	const headers: Record<string, string> = {};
	if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.key}`).toString("base64")}`;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const r = await fetch(url, { headers });
			if (r.ok) {
				writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
				return true;
			}
		} catch {}
		if (attempt < retries - 1) await new Promise((res) => setTimeout(res, 5000));
	}
	return false;
}

// What a session needs from the surrounding run: the validated config and the per-target
// page resolver from preparePage().
export interface SessionContext {
	config: Config;
	pageFor(target: Target): string;
}

// Run one target end-to-end: open the page on its provider, drive playback, capture the
// console output + session video, and write artifacts under test-results/. Returns false
// if the session failed (the run continues with the next target).
export async function runTarget(target: Target, provider: Provider, ctx: SessionContext): Promise<boolean> {
	const { config, pageFor } = ctx;
	console.log(`\n=== [${target.provider}] ${target.name} ===`);
	let browser: WebdriverIO.Browser | undefined;
	try {
		const creds = provider.credentials();
		const remoteOpts = provider.hostname
			? {
					hostname: provider.hostname,
					port: provider.port,
					protocol: provider.protocol,
					path: provider.path,
					user: creds?.user,
					key: creds?.key,
					logLevel: "warn" as const,
				}
			: { logLevel: "warn" as const };
		browser = await remote({
			...remoteOpts,
			capabilities: provider.capsFor(target, `moq ${target.tag}`) as WebdriverIO.Capabilities,
		});

		const url = `${pageFor(target)}?url=${encodeURIComponent(config.relayUrl)}&name=${encodeURIComponent(config.broadcast)}`;
		console.log(`navigating to ${url}`);

		// `browser.url()` on Sauce real iOS Safari often returns while the document is still
		// about:blank. Driving location.href from JS as a fallback gets us past it.
		await browser.url(url);
		await browser.execute(
			// biome-ignore lint/suspicious/noExplicitAny: passing a string arg into the browser
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

		const probe = ProbeSchema.parse(
			await browser.execute(() => ({
				ua: navigator.userAgent,
				href: location.href,
				readyState: document.readyState,
			})),
		);
		console.log(`  navigated: ${probe.readyState} ${probe.href}`);
		console.log(`  browser: ${probe.ua}`);

		// Install the console-capture shim before the click so we record everything the
		// click + early playback emit. Anything that fired during the page's initial render
		// (connection setup, first announces) is still missed; that's a known caveat.
		await browser.execute(SHIM_FN);

		// dumpEnv() in the page logs the environment during initial render, before the shim
		// is installed, so it never reaches console.ndjson. Log it here, where the shim
		// captures it: userAgent pins the browser version and the WebCodecs flags pin which
		// decoders the engine exposes.
		await browser.execute(() => {
			console.info("[moq] env", {
				userAgent: navigator.userAgent,
				webTransport: typeof WebTransport !== "undefined",
				videoDecoder: typeof VideoDecoder !== "undefined",
				audioDecoder: typeof AudioDecoder !== "undefined",
				audioEncoder: typeof AudioEncoder !== "undefined",
			});
		});

		// Synthesize a user gesture so the AudioContext can leave 'suspended' state.
		// Without this, audio never plays in the session recording even when video does.
		// WebDriver clicks are isTrusted, which is what the autoplay policy requires.
		try {
			await browser.$("body").click();
		} catch (err) {
			console.warn(`  could not click to unlock audio: ${err instanceof Error ? err.message : err}`);
		}

		// Unmute every <moq-watch>: the deployed moq.dev/watch page defaults to muted=true
		// (matches demo/web's index.html). Without removing it, audio stays at gain=0 even
		// with the AudioContext unlocked. Both the property and the attribute are wiped so
		// it works for both Web Components and Solid-wrapped variants.
		try {
			await browser.execute(() => {
				for (const el of Array.from(document.querySelectorAll("moq-watch"))) {
					try {
						el.removeAttribute("muted");
					} catch {}
					try {
						// biome-ignore lint/suspicious/noExplicitAny: probing the custom element at runtime
						(el as any).muted = false;
					} catch {}
				}
			});
		} catch {}

		await browser.pause(config.playbackMs);

		// Diagnostic: report AudioContext state so the artifact tells you whether the
		// click actually unlocked playback. Anything other than "running" is the bug.
		const audio = AudioStateSchema.parse(
			await browser.execute(() => {
				// biome-ignore lint/suspicious/noExplicitAny: probing the watch element at runtime
				const el = document.getElementById("watch") as any;
				const ctx = el?.backend?.audio?.context?.peek?.();
				return ctx ? { state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency } : null;
			}),
		);
		if (audio) console.log(`  audio context: ${audio.state} @ ${audio.sampleRate}Hz`);

		const logs = z
			.array(LogEventSchema)
			.parse(
				await browser.execute(
					() =>
						(window as unknown as { __moqLogs?: Array<{ t: number; level: string; args: unknown[] }> })
							.__moqLogs ?? [],
				),
			);

		const outDir = join(
			process.cwd(),
			"test-results",
			`${target.provider}-${target.tag}-${browser.sessionId ?? "session"}`,
		);
		mkdirSync(outDir, { recursive: true });

		writeFileSync(
			join(outDir, "console.ndjson"),
			logs
				.map((l) =>
					JSON.stringify({ t: l.t, level: l.level, text: l.args.map(argText).join(" "), args: l.args }),
				)
				.join("\n"),
		);

		const moqEvents = logs.filter((l) => String(l.args[0]).includes("[moq]"));
		const sessionId = browser.sessionId ?? "session";

		// End the session before fetching URLs so the provider can finalize the video.
		try {
			await browser.deleteSession();
		} catch {}
		browser = undefined;

		const sessionUrls: { dashboardUrl?: string; videoUrl?: string } = await provider
			.urls(sessionId)
			.catch(() => ({}));

		// Download the session video so future analysis doesn't depend on the provider's
		// retention window. Sauce requires Basic auth; BrowserStack's URL has an embedded token.
		let videoFile: string | undefined;
		if (config.downloadVideo && sessionUrls.videoUrl) {
			const dest = join(outDir, "video.mp4");
			const auth = target.provider === "sauce" ? creds : undefined;
			if (await downloadFile(sessionUrls.videoUrl, dest, auth)) {
				videoFile = "video.mp4";
				const size = (statSync(dest).size / 1024 / 1024).toFixed(1);
				console.log(`  saved video: ${dest} (${size}MB)`);
			} else {
				console.warn(`  video download failed; URL remains in summary.json`);
			}
		}

		const summary = {
			provider: target.provider,
			device: target.name,
			tag: target.tag,
			sessionId,
			userAgent: probe.ua,
			relayUrl: config.relayUrl,
			broadcast: config.broadcast,
			page: pageFor(target),
			durationMs: config.playbackMs,
			totalEvents: logs.length,
			moqEvents: moqEvents.length,
			errors: logs.filter((l) => l.level === "error").length,
			audioContext: audio,
			...sessionUrls,
			videoFile,
		};
		writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

		console.log(
			`  ✓ ${target.tag}: ${summary.totalEvents} events, ${summary.moqEvents} [moq], ${summary.errors} errors`,
		);
		console.log(`  artifacts: ${outDir}`);
		if (sessionUrls.dashboardUrl) console.log(`  dashboard: ${sessionUrls.dashboardUrl}`);
		if (sessionUrls.videoUrl) console.log(`  video:     ${sessionUrls.videoUrl}`);
		return true;
	} catch (err) {
		console.error(`  ✗ ${target.tag} failed:`, err instanceof Error ? err.message : err);
		return false;
	} finally {
		if (browser) {
			try {
				await browser.deleteSession();
			} catch {}
		}
	}
}
