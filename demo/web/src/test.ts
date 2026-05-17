import * as Util from "@moq/hang/util";
import "@moq/watch/element";
import type MoqWatch from "@moq/watch/element";

// Echo env + features to the console so headless test runs capture them in console.ndjson.
Util.Hacks.dumpEnv();

const watch = document.getElementById("watch") as MoqWatch | null;
if (!watch) throw new Error("missing <moq-watch>");

const params = new URLSearchParams(window.location.search);
const url = params.get("url");
const name = params.get("name") ?? params.get("broadcast");
if (url) watch.url = url;
if (name) watch.name = name;

function set(id: string, items: Record<string, unknown>) {
	const dl = document.getElementById(id);
	if (!dl) return;
	dl.innerHTML = "";
	for (const [k, v] of Object.entries(items)) {
		const dt = document.createElement("dt");
		dt.textContent = k;
		const dd = document.createElement("dd");
		dd.textContent = v === undefined || v === null ? "-" : String(v);
		if (typeof v === "boolean") dd.className = v ? "ok" : "bad";
		dl.appendChild(dt);
		dl.appendChild(dd);
	}
}

set("env", {
	userAgent: navigator.userAgent,
	platform: Util.Hacks.platform,
	engine: Util.Hacks.engine,
	isMobile: Util.Hacks.isMobile,
	isIOS: Util.Hacks.isIOS,
	isAndroid: Util.Hacks.isAndroid,
	isFirefox: Util.Hacks.isFirefox,
	isSafari: Util.Hacks.isSafari,
	isChrome: Util.Hacks.isChrome,
	hardwareConcurrency: navigator.hardwareConcurrency,
	// biome-ignore lint/suspicious/noExplicitAny: deviceMemory not in TS lib
	deviceMemory: (navigator as any).deviceMemory,
	language: navigator.language,
	online: navigator.onLine,
	devicePixelRatio: window.devicePixelRatio,
});

set("features", {
	WebTransport: typeof WebTransport !== "undefined",
	VideoDecoder: typeof VideoDecoder !== "undefined",
	VideoEncoder: typeof VideoEncoder !== "undefined",
	AudioDecoder: typeof AudioDecoder !== "undefined",
	AudioEncoder: typeof AudioEncoder !== "undefined",
	// biome-ignore lint/suspicious/noExplicitAny: probe global without types
	MediaStreamTrackProcessor: typeof (globalThis as any).MediaStreamTrackProcessor !== "undefined",
	OffscreenCanvas: typeof OffscreenCanvas !== "undefined",
	AudioWorkletNode: typeof AudioWorkletNode !== "undefined",
	SharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
	requestVideoFrameCallback:
		typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype,
});

// Poll the watch element's reactive signals every 500ms. Cheaper than wiring an Effect
// (which would pull @moq/signals into demo/web's dep graph) and plenty for a debug page.
function refresh() {
	const ctx = watch?.backend.audio.context.peek();
	const cfg = watch?.backend.audio.source.config.peek();
	set("audio", {
		state: ctx?.state ?? "none",
		sampleRate: ctx?.sampleRate ?? "-",
		baseLatency: ctx?.baseLatency ?? "-",
		outputLatency: ctx?.outputLatency ?? "-",
		channels: cfg?.numberOfChannels ?? "-",
		codec: cfg?.codec ?? "-",
	});

	const v = watch?.backend.video.stats.peek();
	const a = watch?.backend.audio.stats.peek();
	const ts = watch?.backend.video.timestamp.peek();
	const stalled = watch?.backend.video.stalled.peek();
	set("stats", {
		videoFrames: v?.frameCount ?? 0,
		videoBytes: v?.bytesReceived ?? 0,
		audioBytes: a?.bytesReceived ?? 0,
		videoTimestampMs: ts ?? 0,
		stalled,
	});
}

refresh();
const handle = window.setInterval(refresh, 500);
window.addEventListener("pagehide", () => window.clearInterval(handle));
