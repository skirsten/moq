import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bin as cloudflaredBin, install as installCloudflared, Tunnel } from "cloudflared";
import sirv from "sirv";
import type { Config, Target } from "./config.ts";

// Build demo/web to a fresh temp dir. Tests the *built* output (not unbundled dev modules)
// and means the runner is self-contained: no separate `vite dev` process to start.
function buildDemoWeb(): string {
	const outDir = mkdtempSync(join(tmpdir(), "moq-browsertest-"));
	console.log(`building demo/web -> ${outDir} ...`);
	const r = spawnSync("bun", ["run", "--cwd", "../../demo/web", "build", "--", "--outDir", outDir, "--emptyOutDir"], {
		stdio: "inherit",
	});
	if (r.status !== 0) throw new Error("demo/web build failed");
	return outDir;
}

// Serve the built demo/web via sirv. A plain static server (no framework) means no
// Host-header allow-listing, so the cloudflared tunnel's *.trycloudflare.com host just works.
function serveStatic(dir: string): Promise<{ url: string; stop: () => void }> {
	const handler = sirv(dir, { dev: false, etag: true });
	const server = createServer((req, res) => {
		handler(req, res, () => {
			res.statusCode = 404;
			res.end("not found");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ url: `http://localhost:${port}`, stop: () => server.close() });
		});
	});
}

// Open a quick cloudflared tunnel to a local URL, resolving once it is both named
// (a trycloudflare.com URL) and connected to Cloudflare's edge. This is how remote
// providers reach a local dev server: no account, no per-provider tunnel daemon.
//
// Uses the `cloudflared` npm package. It downloads the binary on first use and gives
// an event API. We pass --protocol http2 because cloudflared defaults to QUIC (UDP/7844),
// which is blocked on many networks; http2 rides plain TCP/443.
async function startCloudflared(localUrl: string): Promise<{ url: string; stop: () => void }> {
	if (!existsSync(cloudflaredBin)) {
		console.log("downloading cloudflared binary ...");
		await installCloudflared(cloudflaredBin);
	}

	const tunnel = Tunnel.quick(localUrl, { "--protocol": "http2", "--no-autoupdate": true });

	return new Promise((resolve, reject) => {
		let url: string | undefined;
		let connected = false;
		const timer = setTimeout(() => {
			tunnel.stop();
			reject(new Error("timed out waiting 45s for the cloudflared tunnel"));
		}, 45_000);
		timer.unref();
		const ready = () => {
			if (url && connected) {
				clearTimeout(timer);
				resolve({ url, stop: () => tunnel.stop() });
			}
		};
		tunnel.once("url", (u) => {
			url = u;
			ready();
		});
		tunnel.once("connected", () => {
			connected = true;
			ready();
		});
		tunnel.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		tunnel.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`cloudflared exited with code ${code}`));
		});
	});
}

// The page each target opens, plus a teardown for whatever was started to serve it.
export interface PreparedPage {
	// localhost direct for local targets, the tunnel for remote ones, or the configured URL.
	pageFor(target: Target): string;
	// Stop the static server + tunnel and delete the temp build dir.
	cleanup(): void;
}

// Resolve how each target reaches the page under test. `page: local` (or a localhost URL)
// builds + serves demo/web ourselves; when remote providers are involved it also opens a
// cloudflared tunnel so they can reach the localhost server.
export async function preparePage(config: Config, targets: Target[]): Promise<PreparedPage> {
	const cleanups: Array<() => void> = [];

	// `localPage` is the localhost URL that local-provider targets hit directly.
	let localPage: string | undefined;
	if (config.page === "local") {
		const outDir = buildDemoWeb();
		cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
		const served = await serveStatic(outDir);
		cleanups.push(served.stop);
		localPage = `${served.url}/test.html`;
		console.log(`serving demo/web build at ${served.url}`);
	} else {
		const u = new URL(config.page);
		if (u.hostname === "localhost" || u.hostname === "127.0.0.1") localPage = config.page;
	}

	// Remote providers can't reach localhost, so expose it once via a cloudflared tunnel.
	let tunnelPage: string | undefined;
	if (localPage && targets.some((t) => t.provider !== "local")) {
		const u = new URL(localPage);
		console.log(`page is localhost; starting cloudflared tunnel for ${u.protocol}//${u.host} ...`);
		const tunnel = await startCloudflared(`${u.protocol}//${u.host}`);
		const t = new URL(tunnel.url);
		t.pathname = u.pathname;
		t.search = u.search;
		tunnelPage = t.toString();
		cleanups.push(tunnel.stop);
		console.log(`cloudflared tunnel connected: ${tunnel.url}`);
	}

	return {
		pageFor(target) {
			if (!localPage) return config.page;
			return target.provider === "local" ? localPage : (tunnelPage ?? localPage);
		},
		cleanup() {
			for (const fn of cleanups) {
				try {
					fn();
				} catch {}
			}
		},
	};
}
