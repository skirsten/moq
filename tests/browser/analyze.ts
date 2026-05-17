import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Post-process per-session video.mp4 files into Claude-ready visual artifacts:
//   - frames/    sample frames at --fps (default 1)
//   - waveform.png    single-image waveform of the full session audio
//   - spectrogram.png frequency-vs-time view of the audio
//   - audio.wav  (only with --audio) extracted audio for offline analysis
//
// Send the waveform + spectrogram + a couple of frames + EXPECTED.md to Claude and ask it
// to compare across browsers. Vision-capable Claude can spot silent stretches, frequency
// dropouts, frozen frames, etc. that show up visually but never make it into console logs.

const HELP = `\
Usage: bun analyze.ts [options] [session-dir...]

Walks test-results/ (or just the given session directories) and runs ffmpeg on
each session's video.mp4, writing analysis artifacts to <session>/analyze/.

Options:
      --fps <n>          Frames per second to extract [default 1]
      --no-frames        Skip frame extraction
      --no-waveform      Skip waveform.png
      --no-spectrogram   Skip spectrogram.png
      --audio            Also extract audio.wav (off by default; regenerable from video.mp4)
      --root <dir>       Sessions root [default test-results]
  -h, --help             Show this help

Requires ffmpeg in $PATH. Install on macOS: 'brew install ffmpeg'.
On Ubuntu/Debian: 'sudo apt install ffmpeg'.
`;

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		fps: { type: "string" },
		"no-frames": { type: "boolean" },
		"no-waveform": { type: "boolean" },
		"no-spectrogram": { type: "boolean" },
		audio: { type: "boolean" },
		root: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

// Preflight: bail clearly if ffmpeg is missing.
const probe = spawnSync("ffmpeg", ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
if (probe.status !== 0) {
	console.error("error: ffmpeg not found in $PATH");
	console.error("  macOS:        brew install ffmpeg");
	console.error("  Ubuntu/Deb:   sudo apt install ffmpeg");
	process.exit(2);
}

const FPS = values.fps ?? "1";
const ROOT = values.root ?? "test-results";

function ffmpeg(args: string[]): boolean {
	const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (r.status !== 0) {
		process.stderr.write(r.stderr ?? Buffer.from(""));
		return false;
	}
	return true;
}

interface Result {
	frames?: string;
	waveform?: string;
	spectrogram?: string;
	audio?: string;
}

function analyze(sessionDir: string): Result | undefined {
	const video = join(sessionDir, "video.mp4");
	if (!existsSync(video)) {
		console.warn(`  no video.mp4 in ${sessionDir}, skipping`);
		return;
	}
	const outDir = join(sessionDir, "analyze");
	mkdirSync(outDir, { recursive: true });
	const result: Result = {};

	if (!values["no-frames"]) {
		const framesDir = join(outDir, "frames");
		mkdirSync(framesDir, { recursive: true });
		const out = join(framesDir, "frame_%03d.png");
		if (ffmpeg(["-i", video, "-vf", `fps=${FPS}`, out])) result.frames = framesDir;
	}

	if (!values["no-waveform"]) {
		const out = join(outDir, "waveform.png");
		const filter = "showwavespic=s=1280x240:colors=cyan|magenta:split_channels=1";
		if (ffmpeg(["-i", video, "-filter_complex", filter, "-frames:v", "1", out])) result.waveform = out;
	}

	if (!values["no-spectrogram"]) {
		const out = join(outDir, "spectrogram.png");
		const filter = "showspectrumpic=s=1280x720:mode=combined:color=intensity:scale=log";
		if (ffmpeg(["-i", video, "-lavfi", filter, out])) result.spectrogram = out;
	}

	if (values.audio) {
		const out = join(outDir, "audio.wav");
		if (ffmpeg(["-i", video, "-vn", "-ac", "2", "-ar", "48000", out])) result.audio = out;
	}

	return result;
}

// Resolve targets. Positional args can be either bare session names ("foo-bar") or full
// paths ("test-results/foo-bar"); only join with ROOT if the bare name doesn't resolve.
function resolve(arg: string): string {
	if (existsSync(join(arg, "video.mp4"))) return arg;
	const rooted = join(ROOT, arg);
	if (existsSync(join(rooted, "video.mp4"))) return rooted;
	return arg;
}

const targets =
	positionals.length > 0
		? positionals.map(resolve)
		: readdirSync(ROOT, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => join(ROOT, d.name));

let processed = 0;
for (const sessionDir of targets) {
	console.log(`\n=== ${sessionDir} ===`);
	const r = analyze(sessionDir);
	if (r) {
		processed++;
		for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(11)} ${v}`);
	}
}

console.log(`\n${processed} session(s) analyzed.`);
