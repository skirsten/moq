import { z } from "zod";
import type { Config, ProviderName, Target } from "./config.ts";

// biome-ignore lint/suspicious/noExplicitAny: caps are loosely typed JSON
export type Caps = Record<string, any>;

// One automation backend: Sauce Labs, BrowserStack, or a local browser. Each adapter
// translates a provider-agnostic Target into the capabilities shape its endpoint expects.
export interface Provider {
	// Empty hostname signals "use the local driver" to wdio's remote(): no remote endpoint.
	hostname: string;
	port: number;
	protocol: "https" | "http";
	path: string;
	credentials(): { user: string; key: string } | undefined;
	supports(t: Target): boolean;
	capsFor(t: Target, sessionName: string): Caps;
	// Per-session dashboard + video URLs, fetched after the session ends so the recording
	// has a chance to finalize. Both can be undefined if the provider doesn't expose them.
	urls(sessionId: string): Promise<{ dashboardUrl?: string; videoUrl?: string }>;
}

// The BrowserStack session REST response, validated as it crosses the network boundary.
const BrowserStackSessionSchema = z.object({
	automation_session: z.object({ public_url: z.string().optional(), video_url: z.string().optional() }).optional(),
});

function makeSauce(region: string, build: string): Provider {
	function credentials() {
		const user = process.env.SAUCE_USERNAME ?? "";
		const key = process.env.SAUCE_ACCESS_KEY ?? "";
		if (!user || !key) throw new Error("set SAUCE_USERNAME and SAUCE_ACCESS_KEY");
		return { user, key };
	}
	return {
		hostname: `ondemand.${region}.saucelabs.com`,
		port: 443,
		protocol: "https",
		path: "/wd/hub",
		credentials,
		supports() {
			return true;
		},
		async urls(sessionId) {
			const c = credentials();
			return {
				dashboardUrl: `https://app.${region}.saucelabs.com/tests/${sessionId}`,
				videoUrl: c
					? `https://api.${region}.saucelabs.com/rest/v1/${c.user}/jobs/${sessionId}/assets/video.mp4`
					: undefined,
			};
		},
		capsFor(t, sessionName) {
			const sauceOpts: Caps = {
				name: sessionName,
				build,
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
}

function makeBrowserStack(build: string): Provider {
	function credentials() {
		const user = process.env.BROWSERSTACK_USERNAME ?? "";
		const key = process.env.BROWSERSTACK_ACCESS_KEY ?? "";
		if (!user || !key) throw new Error("set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY");
		return { user, key };
	}
	return {
		hostname: "hub-cloud.browserstack.com",
		port: 443,
		protocol: "https",
		path: "/wd/hub",
		credentials,
		supports() {
			return true;
		},
		async urls(sessionId) {
			const c = credentials();
			const dashboardUrl = `https://automate.browserstack.com/dashboard/v2/sessions/${sessionId}`;
			if (!c) return { dashboardUrl };
			const auth = `Basic ${Buffer.from(`${c.user}:${c.key}`).toString("base64")}`;
			try {
				const r = await fetch(`https://api.browserstack.com/automate/sessions/${sessionId}.json`, {
					headers: { Authorization: auth },
				});
				if (!r.ok) return { dashboardUrl };
				const data = BrowserStackSessionSchema.parse(await r.json());
				return {
					dashboardUrl: data.automation_session?.public_url ?? dashboardUrl,
					videoUrl: data.automation_session?.video_url,
				};
			} catch {
				return { dashboardUrl };
			}
		},
		capsFor(t, sessionName) {
			const bstackOpts: Caps = {
				sessionName,
				buildName: build,
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
}

function makeLocal(): Provider {
	return {
		// Empty hostname tells the run loop to omit the remote endpoint entirely; wdio's
		// remote() then auto-launches the matching browser driver from $PATH or via its
		// bundled driver-manager.
		hostname: "",
		port: 0,
		protocol: "http",
		path: "/",
		credentials() {
			return undefined;
		},
		supports(t) {
			// No Appium here; mobile targets need real-device infrastructure.
			return t.kind === "desktop";
		},
		async urls() {
			return {};
		},
		capsFor(t, sessionName) {
			if (t.kind !== "desktop") throw new Error("local provider supports only desktop targets");
			return {
				browserName: t.browser === "edge" ? "MicrosoftEdge" : t.browser,
				// No platformName / sauce:options / bstack:options; runs on the host OS.
				"goog:chromeOptions": t.browser === "chrome" ? { args: ["--headless=new"] } : undefined,
				"moz:firefoxOptions": t.browser === "firefox" ? { args: ["-headless"] } : undefined,
				"ms:edgeOptions": t.browser === "edge" ? { args: ["--headless=new"] } : undefined,
				"sauce:options": undefined, // silence any stray reads
				_sessionName: sessionName,
			};
		},
	};
}

// Build the provider adapters for this run, wiring in the per-provider config from config.yaml.
export function createProviders(config: Config): Record<ProviderName, Provider> {
	return {
		sauce: makeSauce(config.providers.sauce.region, config.build),
		browserstack: makeBrowserStack(config.build),
		local: makeLocal(),
	};
}
