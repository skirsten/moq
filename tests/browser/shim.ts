import { z } from "zod";

// One captured console event. Produced by SHIM_FN inside the browser and validated here as
// it crosses back over the WebDriver bridge.
export const LogEventSchema = z.object({ t: z.number(), level: z.string(), args: z.array(z.unknown()) });

// Installed in the browser via browser.execute() before playback. Wraps console.* plus the
// error / unhandledrejection events into window.__moqLogs. We capture this ourselves because
// WebDriver's getLogs is unreliable on iOS Safari.
export function SHIM_FN(): void {
	// biome-ignore lint/suspicious/noExplicitAny: shim installed in browser context
	const w = window as any;
	if (w.__moqLogs) return;
	const buf: Array<{ t: number; level: string; args: unknown[] }> = [];
	w.__moqLogs = buf;

	// Error and DOMException carry name/message/stack as NON-enumerable properties, so a
	// plain JSON.stringify(err) yields "{}" and the real failure is lost. This replacer pulls
	// those out explicitly. It runs as the JSON.stringify replacer so it also catches errors
	// nested inside other objects, including .cause chains (visited recursively).
	const errorReplacer = (_key: string, value: unknown): unknown => {
		const isError =
			value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException);
		if (!isError) return value;
		// biome-ignore lint/suspicious/noExplicitAny: narrowed to Error-like above
		const e = value as any;
		const out: Record<string, unknown> = { name: e.name, message: e.message };
		if (e.stack) out.stack = e.stack;
		if (e.code !== undefined) out.code = e.code;
		if (e.cause !== undefined) out.cause = e.cause;
		return out;
	};

	// Turn one console argument into a JSON-safe, bridge-safe value.
	const serialize = (a: unknown): unknown => {
		if (typeof a === "string") return a;
		try {
			return JSON.parse(JSON.stringify(a, errorReplacer));
		} catch {
			return String(a);
		}
	};

	const levels = ["log", "info", "warn", "error", "debug"] as const;
	for (const level of levels) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic console wrap
		const orig = (console as any)[level];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic console wrap
		(console as any)[level] = (...rawArgs: unknown[]) => {
			try {
				buf.push({ t: Date.now(), level, args: rawArgs.map(serialize) });
			} catch {}
			if (orig) orig.apply(console, rawArgs);
		};
	}

	window.addEventListener("error", (e) => {
		buf.push({ t: Date.now(), level: "error", args: ["[pageerror]", serialize(e.error ?? e.message ?? e)] });
	});
	window.addEventListener("unhandledrejection", (e) => {
		buf.push({ t: Date.now(), level: "error", args: ["[unhandledrejection]", serialize(e.reason)] });
	});
}
