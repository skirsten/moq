import { Time } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
import type { Decoder } from "./decoder";

// A custom paint hook. Receives the 2D context and the frame to draw. The
// canvas is already sized to the element's device pixels (not the video's
// native size), so callers paint in the same coordinate space the user sees.
export type DrawFrame = (ctx: CanvasRenderingContext2D, frame: VideoFrame) => void;

export type RendererProps = {
	canvas?: HTMLCanvasElement | Signal<HTMLCanvasElement | undefined>;
	paused?: boolean | Signal<boolean>;
	// When set, the renderer sizes the canvas backing store to the element's
	// device pixels instead of the video's native size, and calls this for every
	// painted frame instead of the built-in draw. Lets callers implement effects
	// like letterboxing or reflections that need to paint outside the video rect.
	draw?: DrawFrame | Signal<DrawFrame | undefined>;
};

// A component to render a video to a canvas.
export class Renderer {
	decoder: Decoder;

	// The canvas to render the video to.
	canvas: Signal<HTMLCanvasElement | undefined>;

	// Whether the video is paused.
	paused: Signal<boolean>;

	// Optional custom paint hook. See RendererProps.draw.
	draw: Signal<DrawFrame | undefined>;

	// The most recently rendered frame, updated after each rAF paint.
	readonly frame = new Signal<VideoFrame | undefined>(undefined);

	// The media timestamp of the most recently rendered frame.
	readonly timestamp = new Signal<Time.Milli | undefined>(undefined);

	#ctx = new Signal<CanvasRenderingContext2D | undefined>(undefined);
	#visible = new Signal(false);
	#signals = new Effect();

	constructor(decoder: Decoder, props?: RendererProps) {
		this.decoder = decoder;
		this.canvas = Signal.from(props?.canvas);
		this.paused = Signal.from(props?.paused ?? false);
		this.draw = Signal.from(props?.draw);

		this.#signals.run((effect) => {
			const canvas = effect.get(this.canvas);
			this.#ctx.set(canvas?.getContext("2d") ?? undefined);
		});

		this.#signals.run(this.#runVisible.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runRender.bind(this));
		this.#signals.run(this.#runResize.bind(this));
	}

	#runResize(effect: Effect) {
		const canvas = effect.get(this.canvas);
		if (!canvas) return;

		// With a custom draw hook the backing store tracks the element's device
		// pixels (so the hook paints 1:1 with what's on screen), not the video.
		if (effect.get(this.draw)) {
			this.#runResizeElement(effect, canvas);
			return;
		}

		const display = effect.get(this.decoder.display);
		if (!display) return; // Keep current canvas size until we have new dimensions

		// Only update if dimensions actually changed (setting canvas.width/height clears the canvas)
		// TODO I thought the signals library would prevent this, but I'm too lazy to investigate.
		if (canvas.width !== display.width || canvas.height !== display.height) {
			canvas.width = display.width;
			canvas.height = display.height;

			// Setting width/height blanks the canvas. Repaint the cached frame so a
			// resize while paused (decoder off, no new frames coming) doesn't leave
			// the canvas black.
			const ctx = this.#ctx.peek();
			const frame = this.frame.peek();
			if (ctx && frame) this.#paint(ctx, frame);
		}
	}

	// Size the backing store to the element's rendered device pixels. Used only
	// when a custom draw hook is set, so effects like a reflection have room to
	// paint below the video rect.
	#runResizeElement(effect: Effect, canvas: HTMLCanvasElement) {
		const apply = (width: number, height: number) => {
			if (!width || !height) return;
			if (canvas.width === width && canvas.height === height) return;
			canvas.width = width;
			canvas.height = height;

			const ctx = this.#ctx.peek();
			const frame = this.frame.peek();
			if (ctx && frame) this.#paint(ctx, frame);
		};

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			const box = entry.devicePixelContentBoxSize?.[0];
			if (box) {
				apply(box.inlineSize, box.blockSize);
			} else {
				// Safari lacks device-pixel-content-box; approximate from CSS px.
				const dpr = globalThis.devicePixelRatio || 1;
				apply(Math.round(entry.contentRect.width * dpr), Math.round(entry.contentRect.height * dpr));
			}
		});

		try {
			observer.observe(canvas, { box: "device-pixel-content-box" });
		} catch {
			observer.observe(canvas);
		}
		effect.cleanup(() => observer.disconnect());
	}

	// Track whether the canvas is visible in the viewport and the tab is focused.
	#runVisible(effect: Effect): void {
		const canvas = effect.get(this.canvas);
		if (!canvas) {
			this.#visible.set(false);
			return;
		}

		let intersecting = false;

		const update = () => {
			this.#visible.set(intersecting && !document.hidden);
		};

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					intersecting = entry.isIntersecting;
					update();
				}
			},
			{ threshold: 0.01 },
		);

		effect.event(document, "visibilitychange", update);

		observer.observe(canvas);
		effect.cleanup(() => observer.disconnect());
		effect.cleanup(() => this.#visible.set(false));
	}

	// Detect when video should be downloaded.
	#runEnabled(effect: Effect): void {
		const paused = effect.get(this.paused);
		const visible = effect.get(this.#visible);

		effect.cleanup(() => this.decoder.enabled.set(false));

		if (!paused) {
			this.decoder.enabled.set(visible);
			return;
		}

		// When paused, fetch a single preview frame then disable.
		const frame = effect.get(this.frame);
		this.decoder.enabled.set(!frame);
	}

	#runRender(effect: Effect) {
		const ctx = effect.get(this.#ctx);
		if (!ctx) return;

		// When the canvas (and therefore ctx) is replaced, the new canvas starts
		// blank. Paint the cached frame once so a swap while paused isn't black
		// until playback resumes.
		const cached = this.frame.peek();
		if (cached) this.#paint(ctx, cached);

		let rafId: number | undefined;

		const tick = () => {
			const frame = this.decoder.consume();
			if (frame) {
				this.#paint(ctx, frame);
				this.frame.update((old) => {
					old?.close();
					return frame; // transfer ownership from consume()
				});
				this.timestamp.set(Time.Milli.fromMicro(frame.timestamp as Time.Micro));
			}

			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);

		effect.cleanup(() => {
			if (rafId !== undefined) cancelAnimationFrame(rafId);
		});
	}

	#paint(ctx: CanvasRenderingContext2D, frame: VideoFrame) {
		const draw = this.draw.peek();
		if (draw) draw(ctx, frame);
		else this.#draw(ctx, frame);
	}

	#draw(ctx: CanvasRenderingContext2D, frame: VideoFrame) {
		ctx.save();
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

		// Apply horizontal flip if specified in the video config
		const flip = this.decoder.source.catalog.peek()?.flip;
		if (flip) {
			ctx.scale(-1, 1);
			ctx.translate(-ctx.canvas.width, 0);
		}

		ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}

	// Close the track and all associated resources.
	close() {
		this.frame.update((current) => {
			current?.close();
			return undefined;
		});
		this.timestamp.set(undefined);
		this.#signals.close();
	}
}
