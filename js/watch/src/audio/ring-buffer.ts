import { Time } from "@moq/net";

// Length of the linear ramp used to hide sample discontinuities (overflow,
// resize, gap fills, underrun). ~3ms kills the click without being audible.
const DECLICK_SECONDS = 0.003;

export class AudioRingBuffer {
	#buffer: Float32Array[];
	#writeIndex = 0;
	#readIndex = 0;

	readonly rate: number;
	readonly channels: number;
	#stalled = true;

	// Apply short ramps around sample discontinuities to suppress clicks. On by
	// default; tests turn it off to assert raw sample positioning.
	declick = true;

	// Reader-side declick state, tracking playback continuity across read() calls.
	#fade: number;
	#expectedRead?: number;
	#lastSample: Float32Array;

	constructor(props: { rate: number; channels: number; latency: Time.Milli }) {
		if (props.channels <= 0) throw new Error("invalid channels");
		if (props.rate <= 0) throw new Error("invalid sample rate");
		if (props.latency <= 0) throw new Error("invalid latency");

		const samples = Math.ceil(props.rate * Time.Second.fromMilli(props.latency));
		if (samples === 0) throw new Error("empty buffer");

		this.rate = props.rate;
		this.channels = props.channels;

		this.#buffer = [];
		for (let i = 0; i < this.channels; i++) {
			this.#buffer[i] = new Float32Array(samples);
		}

		this.#fade = Math.max(1, Math.round(this.rate * DECLICK_SECONDS));
		this.#lastSample = new Float32Array(this.channels);
	}

	get stalled(): boolean {
		return this.#stalled;
	}

	get timestamp(): Time.Micro {
		return Time.Micro.fromSecond((this.#readIndex / this.rate) as Time.Second);
	}

	get length(): number {
		return this.#writeIndex - this.#readIndex;
	}

	get capacity(): number {
		return this.#buffer[0]?.length;
	}

	resize(latency: Time.Milli): void {
		const newCapacity = Math.ceil(this.rate * Time.Second.fromMilli(latency));
		if (newCapacity === this.capacity) return;
		if (newCapacity === 0) throw new Error("empty buffer");

		const newBuffer: Float32Array[] = [];
		for (let i = 0; i < this.channels; i++) {
			newBuffer[i] = new Float32Array(newCapacity);
		}

		// Copy existing data, preserving the most recent samples
		const samplesToKeep = Math.min(this.length, newCapacity);
		if (samplesToKeep > 0) {
			// Copy the most recent samples (closest to writeIndex)
			const copyStart = this.#writeIndex - samplesToKeep;
			for (let channel = 0; channel < this.channels; channel++) {
				const src = this.#buffer[channel];
				const dst = newBuffer[channel];
				for (let i = 0; i < samplesToKeep; i++) {
					const srcPos = (copyStart + i) % src.length;
					const dstPos = (copyStart + i) % dst.length;
					dst[dstPos] = src[srcPos];
				}
			}
		}

		// Update state for the new buffer, only stall if empty.
		this.#buffer = newBuffer;
		this.#readIndex = this.#writeIndex - samplesToKeep;
		if (samplesToKeep === 0) this.#stalled = true;
	}

	write(timestamp: Time.Micro, data: Float32Array[]): void {
		if (data.length !== this.channels) throw new Error("wrong number of channels");

		let start = Math.round(Time.Second.fromMicro(timestamp) * this.rate);
		let samples = data[0].length;

		// Ignore samples that are too old (before the read index)
		let offset = this.#readIndex - start;
		if (offset > samples) {
			// All samples are too old, ignore them
			return;
		} else if (offset > 0) {
			// Some samples are too old, skip them
			samples -= offset;
			start += offset;
		} else {
			offset = 0;
		}

		const end = start + samples;

		// Check if we need to discard old samples to prevent overflow
		const overflow = end - this.#readIndex - this.#buffer[0].length;
		if (overflow >= 0) {
			// Discard old samples and exit stalled mode
			this.#stalled = false;
			this.#readIndex += overflow;
		}

		// Fill gaps with zeros if there's a discontinuity
		const hadGap = start > this.#writeIndex;
		if (hadGap) {
			const gapSize = Math.min(start - this.#writeIndex, this.#buffer[0].length);
			if (gapSize === 1) {
				console.warn("floating point inaccuracy detected");
			}

			for (let channel = 0; channel < this.channels; channel++) {
				const dst = this.#buffer[channel];
				for (let i = 0; i < gapSize; i++) {
					const writePos = (this.#writeIndex + i) % dst.length;
					dst[writePos] = 0;
				}
			}
		}

		// Write the actual samples, ramping the leading edge up out of a gap fill so
		// the silence->signal edge doesn't click. (Kept symmetric with the shared
		// buffer, which can't safely fade the committed pre-gap tail.)
		const fadeIn = hadGap && this.declick ? Math.min(this.#fade, samples) : 0;
		for (let channel = 0; channel < this.channels; channel++) {
			let src = data[channel];
			src = src.subarray(src.length - samples);

			const dst = this.#buffer[channel];
			if (src.length !== samples) throw new Error("mismatching number of samples");

			for (let i = 0; i < samples; i++) {
				const writePos = (start + i) % dst.length;
				dst[writePos] = i < fadeIn ? src[i] * ((i + 1) / (fadeIn + 1)) : src[i];
			}
		}

		// Update write index, but only if we're moving forward
		if (end > this.#writeIndex) {
			this.#writeIndex = end;
		}
	}

	read(output: Float32Array[]): number {
		if (output.length !== this.channels) throw new Error("wrong number of channels");
		if (this.#stalled) {
			// Output is silence, so reset the declick reference to 0; otherwise the
			// next read ramps from a stale pre-stall sample and clicks.
			this.#expectedRead = undefined;
			this.#lastSample.fill(0);
			return 0;
		}

		const frames = output[0].length;
		const samples = Math.min(this.#writeIndex - this.#readIndex, frames);
		if (samples === 0) {
			// Underrun: silence out, same reset as the stalled case.
			this.#expectedRead = undefined;
			this.#lastSample.fill(0);
			return 0;
		}

		// Ramp in from the last emitted sample when READ jumped (overflow/resize
		// advanced it between calls), and ramp out into the trailing zeros on an
		// underrun, so neither edge clicks.
		const jumped = this.#expectedRead === undefined || this.#readIndex !== this.#expectedRead;
		const fadeIn = this.declick && jumped ? Math.min(samples, this.#fade) : 0;
		const fadeOut = this.declick && samples < frames ? Math.min(samples, this.#fade) : 0;

		for (let channel = 0; channel < this.channels; channel++) {
			const dst = output[channel];
			const src = this.#buffer[channel];
			const last = this.#lastSample[channel];

			if (dst.length !== frames) throw new Error("mismatching number of samples");

			for (let i = 0; i < samples; i++) {
				let sample = src[(this.#readIndex + i) % src.length];
				if (i < fadeIn) sample = last + (sample - last) * ((i + 1) / (fadeIn + 1));
				if (fadeOut > 0 && i >= samples - fadeOut) sample *= (samples - i) / (fadeOut + 1);
				dst[i] = sample;
			}
			this.#lastSample[channel] = fadeOut > 0 ? 0 : dst[samples - 1];
		}

		this.#readIndex += samples;
		this.#expectedRead = this.#readIndex;
		return samples;
	}
}
