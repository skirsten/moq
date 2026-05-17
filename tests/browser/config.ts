import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The whole cross-browser test invocation is described by a YAML config file (no CLI flags).
// All types below are derived from zod schemas; the schemas double as runtime validation.

// Each target carries its own `provider`, so one run can mix Sauce + BrowserStack + local.
const ProviderEnum = z.enum(["sauce", "browserstack", "local"]);

const DesktopTargetSchema = z.object({
	tag: z.string(),
	name: z.string(),
	provider: ProviderEnum,
	kind: z.literal("desktop"),
	browser: z.enum(["chrome", "firefox", "edge", "safari"]),
	os: z.enum(["windows", "macos"]),
	osVersion: z.coerce.string(), // coerce so unquoted YAML numbers (osVersion: 11) still work
});

const MobileTargetSchema = z.object({
	tag: z.string(),
	name: z.string(),
	provider: ProviderEnum,
	kind: z.literal("mobile"),
	platform: z.enum(["iOS", "Android"]),
	browser: z.enum(["safari", "chrome"]),
	device: z.string(), // device-name pattern
	osVersion: z.coerce.string(),
});

const TargetSchema = z.discriminatedUnion("kind", [DesktopTargetSchema, MobileTargetSchema]);

// Provider-specific settings live under `providers`, one section per provider. Only `sauce`
// has settings today; an absent `providers` block (or section) falls back to the defaults.
const ProvidersConfigSchema = z
	.object({
		sauce: z
			.object({
				// Sauce data center; used by sauce targets only.
				region: z.string().default("eu-central-1"),
			})
			.prefault({}),
	})
	.prefault({});

const ConfigSchema = z.object({
	// "local" -> build demo/web, serve it, tunnel it. Otherwise a page URL to open directly.
	page: z.string(),
	relayUrl: z.string(),
	broadcast: z.string(),
	playbackMs: z.number(),
	// Provider-specific settings, grouped by provider name.
	providers: ProvidersConfigSchema,
	// Build label shown in the provider dashboard; empty -> local-YYYY-MM-DD.
	build: z.string().default(""),
	// Download each session's video.mp4 into its artifact dir.
	downloadVideo: z.boolean().default(true),
	// The exact device matrix this run executes. Add/remove entries to change the run.
	targets: z.array(TargetSchema).min(1),
});

export type Target = z.infer<typeof TargetSchema>;
export type ProviderName = z.infer<typeof ProviderEnum>;
export type Config = z.infer<typeof ConfigSchema>;

// Read and validate the run config. Defaults to ./config.yml; pass a path as the sole CLI
// argument to run a different one. Exits with code 2 if the config is invalid.
export function loadConfig(): Config {
	const configPath = process.argv[2]
		? resolvePath(process.argv[2])
		: fileURLToPath(new URL("./config.yml", import.meta.url));
	const parsed = ConfigSchema.safeParse(parseYaml(readFileSync(configPath, "utf8")));
	if (!parsed.success) {
		console.error(`error: invalid ${configPath}\n${z.prettifyError(parsed.error)}`);
		process.exit(2);
	}
	// An empty build label becomes a dated local label so dashboards always show something.
	parsed.data.build ||= `local-${new Date().toISOString().slice(0, 10)}`;
	return parsed.data;
}
