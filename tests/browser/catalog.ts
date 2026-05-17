import { parseArgs } from "node:util";
import { z } from "zod";

// Print the browser + real-device catalogs that Sauce Labs and BrowserStack
// currently expose, grouped the way config.yml `targets` are written. This is a
// browse tool: it only prints, it never validates a config or runs a test. Skim
// the output, then copy the browser / os / osVersion / device values you want
// into config.yml by hand.
//
//   bun catalog.ts                 -> both providers
//   bun catalog.ts sauce           -> just Sauce Labs
//   bun catalog.ts browserstack    -> just BrowserStack
//   bun catalog.ts --region us-west-1
//
// Sauce desktop browsers are a public endpoint. Sauce real devices and the whole
// BrowserStack catalog need credentials (the same env vars run.ts uses, loaded
// from .env / .env.local by bun). A section whose credentials are missing is
// skipped with a note instead of failing the whole run.

const HELP = `\
Usage: bun catalog.ts [provider] [options]

Prints the browser + real-device catalogs that Sauce Labs and BrowserStack
currently expose, grouped the way config.yml 'targets' are written. Browse
only: it never validates a config or runs a test.

Arguments:
  provider           Limit output to one provider: sauce | browserstack

Options:
      --region <dc>  Sauce data center for the lookups [default eu-central-1]
  -h, --help         Show this help

Credentials come from the environment (same vars as run.ts, auto-loaded from
.env / .env.local). Sauce desktop browsers are public; Sauce real devices need
SAUCE_USERNAME / SAUCE_ACCESS_KEY and the BrowserStack catalog needs
BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY. A section with missing
credentials is skipped with a note.
`;

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		region: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

const REGION = values.region ?? "eu-central-1";
const only = positionals[0];
if (only && only !== "sauce" && only !== "browserstack") {
	console.error(`error: unknown provider '${only}' (expected: sauce | browserstack)`);
	process.exit(2);
}

// ---- helpers ----------------------------------------------------------------

function authHeader(user: string, key: string): string {
	return `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;
}

async function getJson<T>(url: string, schema: z.ZodType<T>, auth?: string): Promise<T> {
	const r = await fetch(url, { headers: auth ? { Authorization: auth } : {} });
	if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
	return schema.parse(await r.json());
}

// Compare two version strings: numerically when both look numeric, else lexically.
function byVersion(a: string, b: string): number {
	const na = Number.parseFloat(a);
	const nb = Number.parseFloat(b);
	if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
	if (Number.isNaN(na)) return 1;
	if (Number.isNaN(nb)) return -1;
	return na - nb;
}

// Sort device model names so "iPhone 9" comes before "iPhone 14".
function byName(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

// A desktop grid is browser -> os -> set of osVersions. Adding the same triple
// twice is harmless; the Set dedupes and keeps first-insertion (catalog) order.
type Grid = Map<string, Map<string, Set<string>>>;

function gridAdd(grid: Grid, browser: string, os: string, osVersion: string): void {
	let byOs = grid.get(browser);
	if (!byOs) {
		byOs = new Map();
		grid.set(browser, byOs);
	}
	let versions = byOs.get(os);
	if (!versions) {
		versions = new Set();
		byOs.set(os, versions);
	}
	versions.add(osVersion);
}

const BROWSER_ORDER = ["chrome", "firefox", "edge", "safari"];
const OS_ORDER = ["windows", "macos"];

// Print a desktop grid as an aligned browser / os / osVersion table. With
// `sortVersions` each version list is sorted numerically; without it the catalog
// order is kept, which is what we want for the named macOS releases BrowserStack
// reports (Ventura, Sonoma, ...) since those have no numeric order.
function printGrid(grid: Grid, sortVersions: boolean): void {
	const rows: { browser: string; os: string; versions: string }[] = [];
	for (const browser of BROWSER_ORDER) {
		const byOs = grid.get(browser);
		if (!byOs) continue;
		for (const os of OS_ORDER) {
			const set = byOs.get(os);
			if (!set) continue;
			const list = [...set];
			if (sortVersions) list.sort(byVersion);
			rows.push({ browser, os, versions: list.join(", ") });
		}
	}
	if (rows.length === 0) {
		console.log("  (nothing returned)");
		return;
	}
	const bw = Math.max(...rows.map((r) => r.browser.length), "browser".length);
	const ow = Math.max(...rows.map((r) => r.os.length), "os".length);
	console.log(`  ${"browser".padEnd(bw)}  ${"os".padEnd(ow)}  osVersion`);
	for (const r of rows) console.log(`  ${r.browser.padEnd(bw)}  ${r.os.padEnd(ow)}  ${r.versions}`);
}

// Devices are grouped platform -> device model name -> set of osVersions.
type Devices = Map<string, Map<string, Set<string>>>;

function deviceAdd(devices: Devices, platform: string, name: string, osVersion: string): void {
	let models = devices.get(platform);
	if (!models) {
		models = new Map();
		devices.set(platform, models);
	}
	let versions = models.get(name);
	if (!versions) {
		versions = new Set();
		models.set(name, versions);
	}
	versions.add(osVersion);
}

// Print real devices grouped by platform, one line per device model.
function printDevices(devices: Devices): void {
	for (const [platform, models] of devices) {
		if (models.size === 0) continue;
		const sorted = [...models.entries()].sort((a, b) => byName(a[0], b[0]));
		console.log(`  ${platform}: ${sorted.length} device model(s)`);
		const nw = Math.max(...sorted.map(([name]) => name.length));
		for (const [name, set] of sorted) {
			const versions = [...set].sort(byVersion).join(", ");
			console.log(`    ${name.padEnd(nw)}  osVersion: ${versions}`);
		}
	}
}

// ---- Sauce Labs -------------------------------------------------------------

const SaucePlatformsSchema = z.array(
	z.object({
		api_name: z.string(),
		os: z.string(),
		automation_backend: z.string(),
	}),
);

const SauceDevicesSchema = z.array(
	z.object({
		name: z.string(),
		os: z.string(),
		osVersion: z.string(),
	}),
);

// Sauce `api_name` -> the harness `browser` value. Anything absent here (electron,
// internet explorer, the iphone/ipad simulators) is not a harness desktop target.
const SAUCE_BROWSER: Record<string, string> = {
	chrome: "chrome",
	firefox: "firefox",
	MicrosoftEdge: "edge",
	safari: "safari",
};

async function printSauce(): Promise<void> {
	console.log(`\n===== Sauce Labs =====  region ${REGION}\n`);

	// Desktop browsers: public endpoint, no credentials needed.
	console.log("desktop targets (provider: sauce, kind: desktop)");
	const platformsUrl = `https://api.${REGION}.saucelabs.com/rest/v1/info/platforms/all`;
	console.log(`  source: ${platformsUrl}`);
	try {
		const platforms = await getJson(platformsUrl, SaucePlatformsSchema);
		const grid: Grid = new Map();
		for (const p of platforms) {
			if (p.automation_backend !== "webdriver") continue;
			const browser = SAUCE_BROWSER[p.api_name];
			if (!browser) continue;
			const m = /^(Windows|Mac) (.+)$/.exec(p.os);
			if (!m) continue; // Linux / ChromiumOS: not a harness `os`
			gridAdd(grid, browser, m[1] === "Windows" ? "windows" : "macos", m[2]);
		}
		printGrid(grid, true);
	} catch (err) {
		console.log(`  error: ${err instanceof Error ? err.message : err}`);
	}

	// Real devices: need credentials.
	console.log("\nmobile targets (provider: sauce, kind: mobile)");
	const user = process.env.SAUCE_USERNAME;
	const key = process.env.SAUCE_ACCESS_KEY;
	if (!user || !key) {
		console.log("  skipped: set SAUCE_USERNAME and SAUCE_ACCESS_KEY to list real devices");
		return;
	}
	const devicesUrl = `https://api.${REGION}.saucelabs.com/v1/rdc/devices`;
	console.log(`  source: ${devicesUrl}`);
	try {
		const list = await getJson(devicesUrl, SauceDevicesSchema, authHeader(user, key));
		const devices: Devices = new Map([
			["iOS", new Map()],
			["Android", new Map()],
		]);
		for (const d of list) {
			const platform = d.os === "IOS" ? "iOS" : d.os === "ANDROID" ? "Android" : undefined;
			if (platform) deviceAdd(devices, platform, d.name, d.osVersion);
		}
		printDevices(devices);
	} catch (err) {
		console.log(`  error: ${err instanceof Error ? err.message : err}`);
	}
}

// ---- BrowserStack -----------------------------------------------------------

const BrowserStackSchema = z.array(
	z.object({
		os: z.string(),
		os_version: z.string(),
		browser: z.string().nullable(),
		device: z.string().nullable(),
		real_mobile: z.boolean().nullable(),
	}),
);

async function printBrowserStack(): Promise<void> {
	console.log("\n===== BrowserStack =====\n");
	const user = process.env.BROWSERSTACK_USERNAME;
	const key = process.env.BROWSERSTACK_ACCESS_KEY;
	if (!user || !key) {
		console.log("  skipped: set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY");
		return;
	}
	// One endpoint covers both desktop and real mobile.
	const url = "https://api.browserstack.com/automate/browsers.json";
	console.log(`source: ${url}\n`);
	let entries: z.infer<typeof BrowserStackSchema>;
	try {
		entries = await getJson(url, BrowserStackSchema, authHeader(user, key));
	} catch (err) {
		console.log(`  error: ${err instanceof Error ? err.message : err}`);
		return;
	}

	// Desktop entries have `device: null`. osVersion is a release name on macOS
	// and a number on Windows, so it is shown in the catalog's order, not sorted.
	console.log("desktop targets (provider: browserstack, kind: desktop)");
	console.log("  note: osVersion is a release name on macOS (Sonoma, ...), a number on Windows");
	const grid: Grid = new Map();
	for (const e of entries) {
		if (e.device !== null || e.browser === null) continue;
		const browser = e.browser.toLowerCase();
		if (!BROWSER_ORDER.includes(browser)) continue; // skip opera / ie
		const os = e.os === "Windows" ? "windows" : e.os === "OS X" ? "macos" : undefined;
		if (os) gridAdd(grid, browser, os, e.os_version);
	}
	printGrid(grid, false);

	// Real mobile devices have `real_mobile: true`.
	console.log("\nmobile targets (provider: browserstack, kind: mobile)");
	const devices: Devices = new Map([
		["iOS", new Map()],
		["Android", new Map()],
	]);
	for (const e of entries) {
		if (e.real_mobile !== true || e.device === null) continue;
		const platform = e.os === "ios" ? "iOS" : e.os === "android" ? "Android" : undefined;
		if (platform) deviceAdd(devices, platform, e.device, e.os_version);
	}
	printDevices(devices);
}

// ---- run --------------------------------------------------------------------

if (!only || only === "sauce") await printSauce();
if (!only || only === "browserstack") await printBrowserStack();

// The harness pins desktop `browserVersion` to "latest", so only browser / os /
// osVersion above feed config.yml. For mobile, `device` is a regex matched
// against the model names, and `osVersion` may be a major-version prefix.
console.log("\nnote: desktop browserVersion is always pinned to 'latest' by the harness.\n");
