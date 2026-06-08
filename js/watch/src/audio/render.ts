import type { Time } from "@moq/net";
import type { SharedRingBufferInit } from "./shared-ring-buffer";

export type Message = InitShared | InitPost | Data | Latency | Flush;
export type ToMain = State;

/** Init message when SharedArrayBuffer is available. */
export interface InitShared extends SharedRingBufferInit {
	type: "init-shared";
}

/** Init message for the postMessage fallback path. */
export interface InitPost {
	type: "init-post";
	channels: number;
	rate: number;
	latency: Time.Milli;
}

/** Audio samples sent via postMessage (fallback path only). */
export interface Data {
	type: "data";
	data: Float32Array[];
	timestamp: Time.Micro;
}

/** Latency update sent via postMessage (fallback path only). */
export interface Latency {
	type: "latency";
	latency: Time.Milli;
}

/** Flush the buffer to the live edge (fallback path only). */
export interface Flush {
	type: "flush";
}

/** State update from the worklet back to main thread (fallback path only). */
export interface State {
	type: "state";
	timestamp: Time.Micro;
	stalled: boolean;
}
