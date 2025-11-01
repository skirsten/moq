import * as Moq from "@kixelated/moq";
import { Effect, type Getter, Signal } from "@kixelated/signals";
import * as Catalog from "../../catalog";
import { u53 } from "../../catalog/integers";
import * as Frame from "../../frame";
import * as Time from "../../time";
import * as libav from "../../util/libav";
import { PRIORITY } from "../priority";
import { Captions, type CaptionsProps } from "./captions";
import type * as Capture from "./capture";
import type { Source } from "./types";
import { Speaking, type SpeakingProps } from "./speaking";
import { loadAudioWorklet } from "../../util/hacks";

const GAIN_MIN = 0.001;
const FADE_TIME = 0.2;

// The initial values for our signals.
export type EncoderProps = {
	enabled?: boolean | Signal<boolean>;
	source?: Source | Signal<Source | undefined>;

	muted?: boolean | Signal<boolean>;
	volume?: number | Signal<number>;
	captions?: CaptionsProps;
	speaking?: SpeakingProps;

	// The size of each group. Larger groups mean fewer drops but the viewer can fall further behind.
	// NOTE: Each frame is always flushed to the network immediately.
	maxLatency?: Time.Milli;
};

export class Encoder {
	static readonly TRACK = "audio/data";
	static readonly PRIORITY = PRIORITY.audio;

	enabled: Signal<boolean>;

	muted: Signal<boolean>;
	volume: Signal<number>;
	captions: Captions;
	speaking: Speaking;
	maxLatency: Time.Milli;

	source: Signal<Source | undefined>;

	#catalog = new Signal<Catalog.Audio | undefined>(undefined);
	readonly catalog: Getter<Catalog.Audio | undefined> = this.#catalog;

	#config = new Signal<Catalog.AudioConfig | undefined>(undefined);
	readonly config: Getter<Catalog.AudioConfig | undefined> = this.#config;

	#worklet = new Signal<AudioWorkletNode | undefined>(undefined);

	#gain = new Signal<GainNode | undefined>(undefined);
	readonly root: Getter<AudioNode | undefined> = this.#gain;

	active = new Signal<boolean>(false);

	#signals = new Effect();

	constructor(props?: EncoderProps) {
		this.source = Signal.from(props?.source);
		this.enabled = Signal.from(props?.enabled ?? false);
		this.speaking = new Speaking(this.source, props?.speaking);
		this.captions = new Captions(this.speaking, props?.captions);
		this.muted = Signal.from(props?.muted ?? false);
		this.volume = Signal.from(props?.volume ?? 1);
		this.maxLatency = props?.maxLatency ?? (100 as Time.Milli); // Default is a group every 100ms

		this.#signals.effect(this.#runSource.bind(this));
		this.#signals.effect(this.#runConfig.bind(this));
		this.#signals.effect(this.#runGain.bind(this));
		this.#signals.effect(this.#runCatalog.bind(this));
	}

	#runSource(effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		const source = effect.get(this.source);
		if (!source) return;

		const settings = source.getSettings();

		const context = new AudioContext({
			latencyHint: "interactive",
			sampleRate: settings.sampleRate,
		});
		effect.cleanup(() => context.close());

		const root = new MediaStreamAudioSourceNode(context, {
			mediaStream: new MediaStream([source]),
		});
		effect.cleanup(() => root.disconnect());

		const gain = new GainNode(context, {
			gain: this.volume.peek(),
		});
		root.connect(gain);
		effect.cleanup(() => gain.disconnect());

		// Async because we need to wait for the worklet to be registered.
		effect.spawn(async () => {
			await context.audioWorklet.addModule(
				await loadAudioWorklet(() =>
					navigator.serviceWorker.register(new URL("./capture-worklet", import.meta.url))
				)
			);
			if (context.state === "closed") return;

			const worklet = new AudioWorkletNode(context, "capture", {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: settings.channelCount ?? root.channelCount,
			});

			effect.set(this.#worklet, worklet);

			gain.connect(worklet);
			effect.cleanup(() => worklet.disconnect());

			// Only set the gain after the worklet is registered.
			effect.set(this.#gain, gain);
		});
	}

	#runConfig(effect: Effect): void {
		const source = effect.get(this.source);
		if (!source) return;

		const worklet = effect.get(this.#worklet);
		if (!worklet) return;

		const config = {
			codec: "opus",
			sampleRate: u53(worklet.context.sampleRate),
			numberOfChannels: u53(worklet.channelCount),
			bitrate: u53(worklet.channelCount * 32_000),
		};

		effect.set(this.#config, config);
	}

	#runGain(effect: Effect): void {
		const gain = effect.get(this.#gain);
		if (!gain) return;

		effect.cleanup(() => gain.gain.cancelScheduledValues(gain.context.currentTime));

		const volume = effect.get(this.muted) ? 0 : effect.get(this.volume);
		if (volume < GAIN_MIN) {
			gain.gain.exponentialRampToValueAtTime(GAIN_MIN, gain.context.currentTime + FADE_TIME);
			gain.gain.setValueAtTime(0, gain.context.currentTime + FADE_TIME + 0.01);
		} else {
			gain.gain.exponentialRampToValueAtTime(volume, gain.context.currentTime + FADE_TIME);
		}
	}

	serve(track: Moq.Track, effect: Effect): void {
		if (!effect.get(this.enabled)) return;

		const source = effect.get(this.source);
		if (!source) return;

		const worklet = effect.get(this.#worklet);
		if (!worklet) return;

		const config = effect.get(this.#config);
		if (!config) return;

		effect.set(this.active, true, false);

		let group: Moq.Group = track.appendGroup();
		effect.cleanup(() => group.close());

		let groupTimestamp: Time.Micro | undefined;

		effect.spawn(async () => {
			// We're using an async polyfill temporarily for Safari support.
			await libav.polyfill();

			const encoder = new AudioEncoder({
				output: (frame) => {
					if (frame.type !== "key") {
						throw new Error("only key frames are supported");
					}

					if (!groupTimestamp) {
						groupTimestamp = frame.timestamp as Time.Micro;
					} else if (frame.timestamp - groupTimestamp >= Time.Micro.fromMilli(this.maxLatency)) {
						group.close();
						group = track.appendGroup();
						groupTimestamp = frame.timestamp as Time.Micro;
					}

					const buffer = Frame.encode(frame, frame.timestamp as Time.Micro);
					group.writeFrame(buffer);
				},
				error: (err) => {
					console.error("encoder error", err);
					group.close(err);
					worklet.port.onmessage = null;
				},
			});
			effect.cleanup(() => encoder.close());

			console.debug("encoding audio", config);
			encoder.configure(config);

			worklet.port.onmessage = ({ data }: { data: Capture.AudioFrame }) => {
				const channels = data.channels.slice(0, worklet.channelCount);
				const joinedLength = channels.reduce((a, b) => a + b.length, 0);
				const joined = new Float32Array(joinedLength);

				channels.reduce((offset: number, channel: Float32Array): number => {
					joined.set(channel, offset);
					return offset + channel.length;
				}, 0);

				const frame = new AudioData({
					format: "f32-planar",
					sampleRate: worklet.context.sampleRate,
					numberOfFrames: channels[0].length,
					numberOfChannels: channels.length,
					timestamp: data.timestamp,
					data: joined,
					transfer: [joined.buffer],
				});

				encoder.encode(frame);
				frame.close();
			};
			effect.cleanup(() => {
				worklet.port.onmessage = null;
			});
		});
	}

	#runCatalog(effect: Effect): void {
		const config = effect.get(this.#config);
		if (!config) return;

		const captions = effect.get(this.captions.catalog);
		const speaking = effect.get(this.speaking.catalog);

		const catalog: Catalog.Audio = {
			renditions: { [Encoder.TRACK]: config },
			priority: Encoder.PRIORITY,
			captions,
			speaking,
		};

		effect.set(this.#catalog, catalog);
	}

	close() {
		this.#signals.close();
		this.captions.close();
		this.speaking.close();
	}
}
