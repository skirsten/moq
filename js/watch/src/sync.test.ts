import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Time } from "@moq/net";
import { Sync } from "./sync.ts";

const ms = (n: number) => n as Time.Milli;

let clock = 0;
const realNow = performance.now;
const opened: Sync[] = [];

beforeEach(() => {
	clock = 0;
	performance.now = () => clock;
});

afterEach(() => {
	performance.now = realNow;
	for (const s of opened.splice(0)) s.close();
});

// Fixed latency keeps the jitter buffer deterministic (buffer === latency).
function sync(latency = 0): Sync {
	const s = new Sync({ latency: ms(latency) });
	opened.push(s);
	return s;
}

test("now() tracks the live edge on a single stream", () => {
	const s = sync();

	clock = 1000;
	s.received(ms(0), "video");
	expect(s.now()).toBe(ms(0));

	clock = 2000;
	s.received(ms(1000), "video");
	expect(s.now()).toBe(ms(1000));
});

test("re-baselines the reference when the stream restarts with a fresh PTS epoch", () => {
	const s = sync();

	// First stream: a few seconds of playback establishes the reference.
	clock = 1000;
	s.received(ms(0), "video");
	clock = 6000;
	s.received(ms(5000), "video");
	expect(s.now()).toBe(ms(5000));

	// Publisher restarts much later: PTS resets toward zero. Without a
	// re-baseline now() would stay pinned to the old epoch (~54000).
	clock = 60000;
	s.received(ms(0), "video");
	expect(s.now()).toBe(ms(0));

	clock = 61000;
	s.received(ms(1000), "video");
	expect(s.now()).toBe(ms(1000));
});

test("does not re-baseline on small backward reordering", () => {
	const s = sync();

	clock = 1000;
	s.received(ms(0), "video");
	clock = 1100;
	s.received(ms(100), "video");

	// A frame a little out of order (within the discontinuity threshold) must
	// not reset the reference.
	clock = 1120;
	s.received(ms(80), "video");
	expect(s.now()).toBe(ms(120));
});
