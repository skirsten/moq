// Browser / OS / engine detection used by branching code paths across the watch + publish
// packages. Test harnesses can call dumpEnv() to log a one-line environment trace; nothing
// inside @moq calls it automatically.

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const uaLower = ua.toLowerCase();

// https://issues.chromium.org/issues/40504498
// Matches any Chromium-based browser (Chrome, Edge, Opera, Brave, ...).
export const isChrome = uaLower.includes("chrome");

// https://bugzilla.mozilla.org/show_bug.cgi?id=1967793
export const isFirefox = uaLower.includes("firefox");

// Desktop Safari only. iOS browsers are all WebKit; check isIOS when that's what you mean.
export const isSafari =
	uaLower.includes("safari") &&
	!uaLower.includes("chrome") &&
	!uaLower.includes("android") &&
	!uaLower.includes("firefox");

const hasTouch = typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 1;

export const isAndroid = uaLower.includes("android");

// iPad on iPadOS 13+ reports as MacIntel; disambiguate via touch points.
export const isIOS = /iphone|ipad|ipod/.test(uaLower) || (uaLower.includes("mac") && hasTouch);

export const isMobile = isIOS || isAndroid;

export type Platform = "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
export const platform: Platform = isIOS
	? "ios"
	: isAndroid
		? "android"
		: uaLower.includes("mac")
			? "macos"
			: uaLower.includes("win")
				? "windows"
				: uaLower.includes("linux")
					? "linux"
					: "unknown";

export type Engine = "blink" | "gecko" | "webkit" | "unknown";
export const engine: Engine = isFirefox ? "gecko" : isSafari || isIOS ? "webkit" : isChrome ? "blink" : "unknown";

// One-shot env trace. Safe to call from any entry point; subsequent calls are no-ops.
let dumped = false;
export function dumpEnv(): void {
	if (dumped) return;
	dumped = true;
	if (typeof navigator === "undefined") return;
	console.info("[moq] env", { userAgent: ua, platform, engine, isMobile });
}
