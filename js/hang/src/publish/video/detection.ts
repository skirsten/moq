import * as Moq from "@kixelated/moq";
import { Effect, type Getter, Signal } from "@kixelated/signals";
import * as Comlink from "comlink";
import * as Catalog from "../../catalog";
import { PRIORITY } from "../priority";
import type { DetectionWorker } from "./detection-worker";

export type DetectionProps = {
	enabled?: boolean | Signal<boolean>;
	interval?: number;
	threshold?: number;
};

export class Detection {
	static readonly TRACK = "video/detection.json";
	static readonly PRIORITY = PRIORITY.detection;

	enabled: Signal<boolean>;
	frame: Getter<VideoFrame | undefined>;
	objects = new Signal<Catalog.DetectionObjects | undefined>(undefined);

	#interval: number;
	#threshold: number;

	#catalog = new Signal<Catalog.Detection | undefined>(undefined);
	readonly catalog: Getter<Catalog.Detection | undefined> = this.#catalog;

	signals = new Effect();

	constructor(frame: Getter<VideoFrame | undefined>, props?: DetectionProps) {
		this.frame = frame;
		this.enabled = Signal.from(props?.enabled ?? false);
		this.#interval = props?.interval ?? 1000;
		this.#threshold = props?.threshold ?? 0.5;
		this.signals.effect(this.#runCatalog.bind(this));
	}

	#runCatalog(effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		this.#catalog.set({
			track: { name: Detection.TRACK, priority: Detection.PRIORITY },
		});
	}

	serve(track: Moq.Track, effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		// Initialize worker
		const worker = new Worker(new URL("./detection-worker", import.meta.url), { type: "module" });
		effect.cleanup(() => worker.terminate());

		const api = Comlink.wrap<DetectionWorker>(worker);

		effect.spawn(async () => {
			const ready = await api.ready();
			if (!ready) return;

			effect.interval(async () => {
				const frame = this.frame.peek();
				if (!frame) return;

				const cloned = frame.clone();
				const result = await api.detect(Comlink.transfer(cloned, [cloned]), this.#threshold);

				this.objects.set(result);
				track.writeJson(result);
			}, this.#interval);
		});

		effect.cleanup(() => this.objects.set(undefined));
	}

	close() {
		this.signals.close();
	}
}
