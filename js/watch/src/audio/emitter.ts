import { Effect, Signal } from "@moq/signals";
import type { Decoder } from "./decoder";

const MIN_GAIN = 0.001;
const FADE_TIME = 0.2;

export type EmitterProps = {
	volume?: number | Signal<number>;
	muted?: boolean | Signal<boolean>;
	paused?: boolean | Signal<boolean>;
};

// A helper that emits audio directly to the speakers.
export class Emitter {
	source: Decoder;
	volume: Signal<number>;
	muted: Signal<boolean>;

	// Similar to muted, but controls whether we download audio at all.
	// That way we can be "muted" but also download audio for visualizations.
	paused: Signal<boolean>;

	#signals = new Effect();

	// The volume to use when unmuted.
	#unmuteVolume = 0.5;

	// The gain node used to adjust the volume.
	#gain = new Signal<GainNode | undefined>(undefined);

	constructor(source: Decoder, props?: EmitterProps) {
		this.source = source;
		this.volume = Signal.from(props?.volume ?? 0.5);
		this.muted = Signal.from(props?.muted ?? false);
		this.paused = Signal.from(props?.paused ?? props?.muted ?? false);

		// Set the volume to 0 when muted.
		this.#signals.run((effect) => {
			const muted = effect.get(this.muted);
			if (muted) {
				this.#unmuteVolume = this.volume.peek() || 0.5;
				this.volume.set(0);
			} else {
				this.volume.set(this.#unmuteVolume);
			}
		});

		this.#signals.run((effect) => {
			const enabled = !effect.get(this.paused) && !effect.get(this.muted);
			this.source.enabled.set(enabled);
		});

		// Set unmute when the volume is non-zero.
		this.#signals.run((effect) => {
			const volume = effect.get(this.volume);
			this.muted.set(volume === 0);
		});

		this.#signals.run((effect) => {
			const root = effect.get(this.source.root);
			if (!root) return;

			// Peek so this effect doesn't re-run (recreating the node) on volume
			// changes. The ramp effect below owns every volume transition, which is
			// what makes mute/unmute a smooth fade instead of an instant jump to the
			// new gain.
			const gain = new GainNode(root.context, { gain: this.volume.peek() });
			root.connect(gain);

			// Stay connected to the speakers for the node's lifetime, even while muted
			// or paused. Disconnecting stops the worklet being pulled, which freezes the
			// ring's declick reference, so resume ramps from a stale sample and clicks.
			// It's silent regardless: gain is 0 when muted, the ring is empty when paused.
			gain.connect(root.context.destination);
			effect.cleanup(() => gain.disconnect());

			effect.set(this.#gain, gain);
		});

		this.#signals.run((effect) => {
			const gain = effect.get(this.#gain);
			if (!gain) return;

			const now = gain.context.currentTime;
			// Anchor at the current gain, floored above zero so the exponential ramp
			// is valid even coming out of a full mute, then ramp to the target.
			gain.gain.cancelScheduledValues(now);
			gain.gain.setValueAtTime(Math.max(gain.gain.value, MIN_GAIN), now);

			const volume = effect.get(this.volume);
			if (volume < MIN_GAIN) {
				gain.gain.exponentialRampToValueAtTime(MIN_GAIN, now + FADE_TIME);
				gain.gain.setValueAtTime(0, now + FADE_TIME);
			} else {
				gain.gain.exponentialRampToValueAtTime(volume, now + FADE_TIME);
			}
		});
	}

	close() {
		this.#signals.close();
	}
}
