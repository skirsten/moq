import * as Catalog from "@moq/hang/catalog";
import * as Container from "@moq/hang/container";
import * as Util from "@moq/hang/util";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Effect, type Getter, Signal } from "@moq/signals";
import { base64ToBytes } from "../base64";
import type { BufferedRanges } from "../buffered";
import { retryTrackEnd } from "../resubscribe";
import type { Backend, Stats } from "./backend";
import type { Source } from "./source";

// The amount of time to wait before considering the video to be buffering.
const BUFFERING = 500 as Time.Milli;
const SWITCH = 100 as Time.Milli;

// Cap on decoded frames + decoder input queue. Each decoded VideoFrame
// pins a GPU surface, so without a cap this would grow to latency * fps.
// Backpressuring decoder.decode() pushes the wait upstream into
// Container.Consumer, where it costs encoded bytes instead. Written by Claude.
const QUEUE_CAP = 8;

export type DecoderProps = {
	enabled?: boolean | Signal<boolean>;
};

// The types in VideoDecoderConfig that cause a hard reload.
// ex. codedWidth/Height are optional and can be changed in-band, so we don't want to trigger a reload.
// This way we can keep the current subscription active.
type RequiredDecoderConfig = Omit<Catalog.VideoConfig, "codedWidth" | "codedHeight">;

export class Decoder implements Backend {
	enabled: Signal<boolean>; // Don't download any longer
	source: Source;

	// The current track running, held so we can cancel it when the new track is ready.
	#active = new Signal<DecoderTrack | undefined>(undefined);

	// The timestamp of the most recently consumed frame.
	#timestamp = new Signal<Time.Milli | undefined>(undefined);
	readonly timestamp: Getter<Time.Milli | undefined> = this.#timestamp;

	// The display size of the video in pixels, ideally sourced from the catalog.
	#display = new Signal<{ width: number; height: number } | undefined>(undefined);
	readonly display: Getter<{ width: number; height: number } | undefined> = this.#display;

	#stalled = new Signal<boolean>(false);
	readonly stalled: Getter<boolean> = this.#stalled;

	#stats = new Signal<Stats | undefined>(undefined);
	readonly stats: Getter<Stats | undefined> = this.#stats;

	// Combined buffered ranges (network jitter + decode buffer)
	#buffered = new Signal<BufferedRanges>([]);
	readonly buffered: Getter<BufferedRanges> = this.#buffered;

	#signals = new Effect();

	// Pop the newest decoded frame whose PTS is at or before sync.now(), closing
	// any older queued frames. The caller takes ownership of the returned frame
	// and is responsible for closing it. Returns undefined if no frame is ready.
	consume(): VideoFrame | undefined {
		const active = this.#active.peek();
		if (!active) return undefined;

		const now = this.source.sync.now();
		if (now === undefined) return undefined;

		return active.consume(now);
	}

	constructor(source: Source, props?: DecoderProps) {
		this.enabled = Signal.from(props?.enabled ?? false);

		this.source = source;
		this.source.supported.set(supported); // super hacky

		this.#signals.run(this.#runPending.bind(this));
		this.#signals.run(this.#runActive.bind(this));
		this.#signals.run(this.#runDisplay.bind(this));
		this.#signals.run(this.#runBuffering.bind(this));
	}

	#runPending(effect: Effect): void {
		const values = effect.getAll([this.enabled, this.source.broadcast, this.source.track, this.source.config]);
		if (!values) {
			// Close the active track when disabled (e.g. paused or not visible).
			// The pending cleanup won't do this because it was already promoted to #active.
			this.#active.set(undefined);
			return;
		}
		const [_, source, track, config] = values;

		const broadcast: Moq.Broadcast | undefined = effect.get(source.active);
		if (!broadcast) {
			// Going offline should clear the last rendered timestamp so the
			// buffering overlay logic in #runBuffering treats us as stalled.
			this.#active.set(undefined);
			this.#timestamp.set(undefined);
			this.#buffered.set([]);
			return;
		}

		// Start a new pending effect.
		let pending: DecoderTrack | undefined = new DecoderTrack({
			source: this.source,
			broadcast,
			track,
			config,
			stats: this.#stats,
		});

		effect.cleanup(() => pending?.close());

		effect.run((effect) => {
			if (!pending) return;

			const active = effect.get(this.#active);
			if (active) {
				// Compare the pending track's decode frontier against the active
				// playhead: a pending track is never consumed, so its `timestamp`
				// stays undefined. `decoded` tracks how far it has buffered.
				const pendingDecoded = effect.get(pending.decoded);
				const activeTimestamp = effect.get(active.timestamp);

				// Switch to the new track if it's ready and we've caught up enough.
				if (!pendingDecoded) return;
				if (activeTimestamp && activeTimestamp > pendingDecoded + SWITCH) return;
			}

			// Upgrade the pending track to active.
			// #runActive will be in charge of it now.
			pending.promote();
			this.#active.set(pending);
			pending = undefined;

			// This effect is done; close it to avoid a useless re-run.
			effect.close();
		});
	}

	#runActive(effect: Effect): void {
		const active = effect.get(this.#active);
		if (!active) {
			// Clear stale data when disabled (e.g. paused or not visible).
			this.#buffered.set([]);
			return;
		}

		effect.cleanup(() => active.close());

		effect.proxy(this.#timestamp, active.timestamp);
		effect.proxy(this.#buffered, active.buffered);
	}

	#runDisplay(effect: Effect): void {
		const catalog = effect.get(this.source.catalog);
		if (!catalog) return;

		const display = catalog.display;
		if (display) {
			effect.set(this.#display, {
				width: display.width,
				height: display.height,
			});
			return;
		}

		const active = effect.get(this.#active);
		if (!active) return;

		const dims = effect.get(active.display);
		if (!dims) return;

		effect.set(this.#display, dims);
	}

	#runBuffering(effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		const timestamp = effect.get(this.#timestamp);
		if (timestamp === undefined) {
			this.#stalled.set(true);
			return;
		}

		this.#stalled.set(false);

		effect.timer(() => {
			this.#stalled.set(true);
		}, BUFFERING);
	}

	close() {
		this.#signals.close();
	}
}

interface DecoderTrackProps {
	source: Source;
	broadcast: Moq.Broadcast;
	track: string;
	config: Catalog.VideoConfig;

	stats: Signal<Stats | undefined>;
}

class DecoderTrack {
	source: Source;
	broadcast: Moq.Broadcast;
	track: string;
	config: RequiredDecoderConfig;
	stats: Signal<Stats | undefined>;

	// The PTS of the most recently consumed (painted) frame.
	timestamp = new Signal<Time.Milli | undefined>(undefined);

	// The PTS of the newest decoded frame, set at queue time. Reflects how far a
	// track has buffered even before it becomes active, so #runPending can decide
	// when a pending track is ready to take over.
	decoded = new Signal<Time.Milli | undefined>(undefined);

	// Display dimensions taken from the first decoded frame, used as a fallback
	// when the catalog doesn't carry display metadata.
	display = new Signal<{ width: number; height: number } | undefined>(undefined);

	// Network jitter + decode buffer.
	buffered = new Signal<BufferedRanges>([]);

	// Decoded frames waiting to be rendered.
	#buffered = new Signal<BufferedRanges>([]);

	// The last discontinuity count seen from the container consumer. A change means
	// the publisher rewound the timeline, so we flush the decode queue and re-anchor.
	#discontinuity = 0;

	// Decoded frames awaiting paint, in PTS-ascending order. VideoDecoder
	// emits in display order, so push order is already monotonic.
	#queue: VideoFrame[] = [];

	#queueDrain = Promise.withResolvers<void>();

	// Whether this track has been promoted to active. A pending track is never
	// consumed, so while false the output callback drops all but the newest
	// frame to keep decoding (and `decoded`) racing toward the live edge instead
	// of stalling at QUEUE_CAP.
	#promoted = false;

	// Bumped when the subscription ends mid-broadcast so #run resubscribes.
	#resubscribe = new Signal(0);

	signals = new Effect();

	constructor(props: DecoderTrackProps) {
		// Remove the codedWidth/Height from the config to avoid a hard reload if nothing else has changed.
		const { codedWidth: _, codedHeight: __, ...requiredConfig } = props.config;

		this.source = props.source;
		this.broadcast = props.broadcast;
		this.track = props.track;
		this.config = requiredConfig;
		this.stats = props.stats;

		this.signals.run(this.#run.bind(this));
	}

	#run(effect: Effect): void {
		effect.get(this.#resubscribe);

		const sub = this.broadcast.subscribe(this.track, Catalog.PRIORITY.video);
		effect.cleanup(() => sub.close());
		retryTrackEnd(effect, sub, this.#resubscribe);

		const decoder = new VideoDecoder({
			output: (frame: VideoFrame) => {
				const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);

				// Drop frames that have already been displayed (can happen if the
				// reference resets, e.g. on playback start).
				if (timestamp < (this.timestamp.peek() ?? 0)) {
					frame.close();
					return;
				}

				// Capture display dimensions from the first frame so #runDisplay
				// can fall back to them when the catalog has no display metadata.
				if (this.display.peek() === undefined) {
					this.display.set({ width: frame.displayWidth, height: frame.displayHeight });
				}

				// Queue for the renderer to pick up on its next vsync.
				this.#queue.push(frame);
				this.decoded.set(timestamp);

				// While pending, nothing consumes the queue, so drop everything but
				// the newest frame and release backpressure. This lets the track
				// catch up to live before it takes over (e.g. on a rendition switch).
				if (!this.#promoted) {
					while (this.#queue.length > 1) this.#queue.shift()?.close();
					this.#queueDrain.resolve();
					this.#queueDrain = Promise.withResolvers<void>();
				}
			},
			// TODO bubble up error
			error: (error) => {
				console.error(error);
				effect.close();
			},
		});
		effect.cleanup(() => {
			if (decoder.state !== "closed") decoder.close();
			// Drain any frames the renderer never got to.
			for (const frame of this.#queue) frame.close();
			this.#queue.length = 0;
		});

		// Input processing - depends on container type
		if (this.config.container.kind === "cmaf") {
			this.#runCmaf(effect, sub, decoder);
		} else {
			this.#runLegacy(effect, sub, decoder);
		}
	}

	#runLegacy(effect: Effect, sub: Moq.Track, decoder: VideoDecoder): void {
		const format =
			this.config.container.kind === "loc" ? new Container.Loc.Format() : new Container.Legacy.Format();
		// Create consumer that reorders groups/frames up to the provided latency.
		const consumer = new Container.Consumer(sub, {
			format,
			latency: this.source.sync.buffer,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#buffered);
			this.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		decoder.configure({
			...this.config,
			description: this.config.description ? Util.Hex.toBytes(this.config.description) : undefined,
			optimizeForLatency: this.config.optimizeForLatency ?? true,
			// @ts-expect-error Only supported by Chrome, so the renderer has to flip manually.
			flip: false,
		});

		let previous: { timestamp: Time.Micro; group: number; final: boolean } | undefined;

		effect.spawn(async () => {
			for (;;) {
				const next = await consumer.next();
				if (!next) break;

				// Publisher rewound: flush queued/in-flight video and re-anchor before decoding.
				if (this.#onDiscontinuity(next.discontinuity)) previous = undefined;

				const { frame, group } = next;

				if (!frame) {
					if (previous) {
						previous.final = true;
					}
					// The group is done
					continue;
				}

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
				this.source.sync.received(timestamp, "video");

				const chunk = new EncodedVideoChunk({
					type: frame.keyframe ? "key" : "delta",
					data: frame.data,
					timestamp: frame.timestamp,
				});

				// Track both frame count and bytes received for stats in the UI
				this.stats.update((current) => ({
					frameCount: (current?.frameCount ?? 0) + 1,
					bytesReceived: (current?.bytesReceived ?? 0) + frame.data.byteLength,
				}));

				// Track decode buffer: frames sent to decoder but not yet rendered
				const prior = previous;
				if (prior && (prior.group === group || (prior.final && prior.group + 1 === group))) {
					const start = Time.Milli.fromMicro(prior.timestamp);
					const end = Time.Milli.fromMicro(frame.timestamp);
					this.#addBuffered(start, end);
				}

				previous = {
					timestamp: frame.timestamp,
					group,
					final: false,
				};

				if (!(await this.#awaitQueueSpace(effect, decoder))) return;
				if (decoder.state === "closed") break;
				decoder.decode(chunk);
			}
		});
	}

	#runCmaf(effect: Effect, sub: Moq.Track, decoder: VideoDecoder): void {
		if (this.config.container.kind !== "cmaf") return;

		const initSegment = base64ToBytes(this.config.container.init);
		const init = Container.Cmaf.decodeInitSegment(initSegment);
		const description = this.config.description ? Util.Hex.toBytes(this.config.description) : init.description;

		const consumer = new Container.Consumer(sub, {
			format: new Container.Cmaf.Format(init),
			latency: this.source.sync.buffer,
		});
		effect.cleanup(() => consumer.close());

		// Combine network jitter buffer with decode buffer
		effect.run((inner) => {
			const network = inner.get(consumer.buffered);
			const decode = inner.get(this.#buffered);
			this.buffered.update(() => Container.mergeBufferedRanges(network, decode));
		});

		// Configure decoder with description from catalog
		decoder.configure({
			codec: this.config.codec,
			description,
			optimizeForLatency: this.config.optimizeForLatency ?? true,
			// @ts-expect-error Only supported by Chrome, so the renderer has to flip manually.
			flip: false,
		});

		let previous: { timestamp: Time.Micro; group: number; final: boolean } | undefined;

		effect.spawn(async () => {
			for (;;) {
				const next = await consumer.next();
				if (!next) break;

				// Publisher rewound: flush queued/in-flight video and re-anchor before decoding.
				if (this.#onDiscontinuity(next.discontinuity)) previous = undefined;

				const { frame, group } = next;

				if (!frame) {
					if (previous) {
						previous.final = true;
					}
					continue;
				}

				// Mark that we received this frame right now.
				const timestamp = Time.Milli.fromMicro(frame.timestamp);
				this.source.sync.received(timestamp, "video");

				// Track stats
				this.stats.update((current) => ({
					frameCount: (current?.frameCount ?? 0) + 1,
					bytesReceived: (current?.bytesReceived ?? 0) + frame.data.byteLength,
				}));

				// Track decode buffer
				const prior = previous;
				if (prior && (prior.group === group || (prior.final && prior.group + 1 === group))) {
					const start = Time.Milli.fromMicro(prior.timestamp);
					const end = Time.Milli.fromMicro(frame.timestamp);
					this.#addBuffered(start, end);
				}

				previous = {
					timestamp: frame.timestamp,
					group,
					final: false,
				};

				if (!(await this.#awaitQueueSpace(effect, decoder))) return;
				if (decoder.state === "closed") break;
				decoder.decode(
					new EncodedVideoChunk({
						type: frame.keyframe ? "key" : "delta",
						data: frame.data,
						timestamp: frame.timestamp,
					}),
				);
			}
		});
	}

	// React to the container consumer's discontinuity counter. On a change the publisher has
	// rewound the timeline, so drop the decode queue and re-anchor the shared clock before the
	// new utterance. Clearing `timestamp` is load-bearing: otherwise its stale high value would
	// late-reject the rewound (lower-timestamp) frames at the output guard. Returns true if a
	// rewind was handled.
	#onDiscontinuity(count: number): boolean {
		if (count === this.#discontinuity) return false;
		this.#discontinuity = count;
		this.timestamp.set(undefined);
		this.#buffered.set([]);

		// Drop decoded-but-unpainted frames from the old timeline and release any
		// decode backpressure waiting on queue space.
		for (const frame of this.#queue) frame.close();
		this.#queue.length = 0;
		this.#queueDrain.resolve();
		this.#queueDrain = Promise.withResolvers<void>();

		this.source.sync.reset();
		return true;
	}

	// Add a range to the decode buffer (decoded, waiting to render)
	#addBuffered(start: Time.Milli, end: Time.Milli): void {
		if (start > end) return;

		this.#buffered.mutate((current) => {
			for (const range of current) {
				// Check if there's any overlap, then merge
				if (range.start <= end && range.end >= start) {
					range.start = Time.Milli.min(range.start, start);
					range.end = Time.Milli.max(range.end, end);
					return;
				}
			}

			current.push({ start, end });
			current.sort((a, b) => a.start - b.start);
		});
	}

	// Trim the decode buffer up to the rendered timestamp
	#trimBuffered(timestamp: Time.Milli): void {
		this.#buffered.mutate((current) => {
			while (current.length > 0) {
				if (current[0].end >= timestamp) {
					current[0].start = Time.Milli.max(current[0].start, timestamp);
					break;
				}
				current.shift();
			}
		});
	}

	// Mark this track as active. After this the output callback stops trimming
	// the queue so the render buffer can build up normally.
	promote(): void {
		this.#promoted = true;
	}

	// Pop the newest queued frame whose PTS is <= now, closing any older ones.
	// Caller takes ownership of the returned frame and must close it.
	consume(now: Time.Milli): VideoFrame | undefined {
		const frame = consumeFrame(this.#queue, now);
		if (!frame) return undefined;

		this.#queueDrain.resolve();
		this.#queueDrain = Promise.withResolvers<void>();

		const timestamp = Time.Milli.fromMicro(frame.timestamp as Time.Micro);
		this.timestamp.set(timestamp);
		this.#trimBuffered(timestamp);

		return frame;
	}

	// AbortSignal with explicit removal, not Promise.race against
	// effect.cancel, to avoid leaking a PromiseReaction per iteration onto
	// the long-lived cancel promise (see #1400). Written by Claude.
	async #awaitQueueSpace(effect: Effect, decoder: VideoDecoder): Promise<boolean> {
		const abort = effect.abort;
		while (this.#queue.length + decoder.decodeQueueSize >= QUEUE_CAP) {
			if (abort.aborted) return false;
			const aborted = await new Promise<boolean>((resolve) => {
				const onAbort = () => resolve(true);
				abort.addEventListener("abort", onAbort, { once: true });
				this.#queueDrain.promise.then(() => {
					abort.removeEventListener("abort", onAbort);
					resolve(false);
				});
			});
			if (aborted) return false;
		}
		return true;
	}

	close(): void {
		this.signals.close();
	}
}

export interface ConsumableFrame {
	readonly timestamp: number; // microseconds
	close(): void;
}

// Pop the newest frame in `queue` whose PTS is <= now, closing any older
// entries. Mutates the queue.
export function consumeFrame<F extends ConsumableFrame>(queue: F[], now: Time.Milli): F | undefined {
	let pickIdx = -1;
	for (let i = queue.length - 1; i >= 0; i--) {
		const ts = Time.Milli.fromMicro(queue[i].timestamp as Time.Micro);
		if (ts <= now) {
			pickIdx = i;
			break;
		}
	}
	if (pickIdx < 0) return undefined;

	for (let i = 0; i < pickIdx; i++) {
		queue[i].close();
	}

	const frame = queue[pickIdx];
	queue.splice(0, pickIdx + 1);
	return frame;
}

async function supported(config: Catalog.VideoConfig): Promise<boolean> {
	let description: Uint8Array | undefined;
	if (config.description) {
		description = Util.Hex.toBytes(config.description);
	} else if (config.container.kind === "cmaf") {
		try {
			description = Container.Cmaf.decodeInitSegment(base64ToBytes(config.container.init)).description;
		} catch (err) {
			// A malformed init segment means we can't extract the codec
			// description, so we can't probe support reliably. Reject the
			// track rather than letting isConfigSupported pass on a
			// description-less config and then having runCmaf fail later.
			console.warn(`video: malformed CMAF init segment for codec ${config.codec}`, err);
			return false;
		}
	}
	const { supported } = await VideoDecoder.isConfigSupported({
		codec: config.codec,
		description,
		optimizeForLatency: config.optimizeForLatency ?? true,
	});

	if (supported) return true;

	// Safari rejects `avc3.*` codec strings even though its H.264 decoder handles
	// inline SPS/PPS. Rewrite to `avc1.*` and retry; mutate config.codec so the
	// later `decoder.configure()` call uses the accepted string too.
	if (config.codec.startsWith("avc3.")) {
		const avc1 = `avc1.${config.codec.slice("avc3.".length)}`;
		const retry = await VideoDecoder.isConfigSupported({
			codec: avc1,
			description,
			optimizeForLatency: config.optimizeForLatency ?? true,
		});
		if (retry.supported) {
			config.codec = avc1;
			return true;
		}
	}

	return false;
}
