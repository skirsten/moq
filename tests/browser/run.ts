// Cross-browser playback runner for @moq/watch. Drives Sauce Labs, BrowserStack, or a local
// browser via WebdriverIO's library API. The @wdio/cli test-runner has an IPC issue under
// Node 24 (process.send EINVAL when forking workers); the library API has no such trouble,
// and for a single playback session per device, mocha buys us nothing.
//
// There are no CLI flags. The entire run is described by a YAML config file:
//   bun run.ts              -> runs ./config.yml  (one command, whole matrix)
//   bun run.ts other.yml    -> runs a different config

import { loadConfig } from "./config.ts";
import { createProviders } from "./providers.ts";
import { preparePage } from "./serve.ts";
import { runTarget } from "./session.ts";

const config = loadConfig();
const providers = createProviders(config);

// Fail fast if a provider this run uses is missing its credentials.
for (const name of new Set(config.targets.map((t) => t.provider))) {
	try {
		providers[name].credentials();
	} catch (err) {
		console.error(`error: ${err instanceof Error ? err.message : err}`);
		process.exit(2);
	}
}

// config.yml's `targets` is the exact run list. Drop ones their provider can't run
// (e.g. a mobile target pinned to `provider: local`).
const targets = config.targets.filter((t) => providers[t.provider].supports(t));
for (const t of config.targets.filter((t) => !providers[t.provider].supports(t))) {
	console.warn(`  skipping ${t.tag}: provider '${t.provider}' can't run ${t.kind} targets`);
}
if (targets.length === 0) {
	console.error("no runnable targets after the provider-support filter");
	process.exit(2);
}

// Build/serve/tunnel the page under test, then run every target against it.
const page = await preparePage(config, targets);
console.log(`relay: ${config.relayUrl}  broadcast: ${config.broadcast}  targets: ${targets.length}\n`);

let exitCode = 0;
for (const target of targets) {
	const ok = await runTarget(target, providers[target.provider], { config, pageFor: page.pageFor });
	if (!ok) exitCode = 1;
}

page.cleanup();
process.exit(exitCode);
