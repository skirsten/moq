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
