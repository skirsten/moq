import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import type { Time } from "@moq/net";
import { Sync } from "./sync";

const ms = (n: number) => n as Time.Milli;

// Effects in @moq/signals flush on a microtask, so let pending updates drain before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("latency range", () => {
	it("is collapsed by default", async () => {
		const sync = new Sync();
		await flush();
		expect(sync.buffered.peek()).toBe(false);
		sync.close();
	});

	it("stays collapsed for a scalar latency", async () => {
		const sync = new Sync({ latency: 100 as Time.Milli });
		await flush();
		expect(sync.buffered.peek()).toBe(false);
		expect(sync.maxBuffer.peek()).toBe(100 as Time.Milli);
		sync.close();
	});

	it("enters buffered mode when the ceiling is above the floor", async () => {
		const sync = new Sync({ latency: { max: 30_000 as Time.Milli } });
		await flush();
		expect(sync.buffered.peek()).toBe(true);
		expect(sync.maxBuffer.peek()).toBe(30_000 as Time.Milli);
		sync.close();
	});

	it("stays collapsed when the ceiling is at or below the floor", async () => {
		// Fixed 200ms floor sits above the 100ms ceiling, so there's no room to buffer.
		const sync = new Sync({ latency: { min: 200 as Time.Milli, max: 100 as Time.Milli } });
		await flush();
		expect(sync.buffered.peek()).toBe(false);
		sync.close();
	});

	it("reacts to a ceiling set after construction", async () => {
		const sync = new Sync();
		await flush();
		expect(sync.buffered.peek()).toBe(false);

		sync.latency.set({ max: 30_000 as Time.Milli });
		await flush();
		expect(sync.buffered.peek()).toBe(true);
		sync.close();
	});

	it("stays collapsed for an explicit real-time ceiling", async () => {
		const sync = new Sync({ latency: { max: "real-time" } });
		await flush();
		expect(sync.buffered.peek()).toBe(false);
		sync.close();
	});
});
