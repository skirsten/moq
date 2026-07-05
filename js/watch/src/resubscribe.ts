import type * as Moq from "@moq/net";
import type { Effect, Signal } from "@moq/signals";

// Delay before resubscribing after a track subscription ends unexpectedly.
const RETRY_MS = 1000;

/**
 * Schedules a rerun of the owning effect (by bumping `retry`) when `track`
 * ends while the effect is still live. A relay can end or reject a live
 * subscription mid-broadcast without any announcement to revive it, so the
 * only recovery is to subscribe again.
 *
 * The effect must read `retry` with `effect.get` before subscribing, and is
 * expected to close `track` in its cleanup: `effect.cancel` settles first on
 * teardown, so that close never schedules a retry against the next run.
 */
export function retryTrackEnd(effect: Effect, track: Moq.Track, retry: Signal<number>): void {
	let cancelled = false;
	void effect.cancel.then(() => {
		cancelled = true;
	});

	void track.closed.then((err) => {
		if (cancelled) return;
		if (err) console.warn(`track subscription failed, retrying: track=${track.name}`, err);
		else console.warn(`track subscription ended, retrying: track=${track.name}`);
		effect.timer(() => retry.update((n) => n + 1), RETRY_MS);
	});
}
