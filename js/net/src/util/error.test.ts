import { expect, test } from "bun:test";
import { isCleanStop } from "./error.ts";

test("isCleanStop matches qmux code-0 stop/reset", () => {
	expect(isCleanStop(new Error("STOP_SENDING: 0"))).toBe(true);
	expect(isCleanStop(new Error("RESET_STREAM: 0"))).toBe(true);
});

test("isCleanStop matches polyfill code-0 stop/reset", () => {
	expect(isCleanStop(new Error("StopSending with code:0"))).toBe(true);
	expect(isCleanStop(new Error("Resetstream with code:0"))).toBe(true);
});

test("isCleanStop matches native WebTransport stream errors with code 0 or null", () => {
	expect(isCleanStop({ source: "stream", streamErrorCode: 0 })).toBe(true);
	expect(isCleanStop({ source: "stream", streamErrorCode: null })).toBe(true);
	expect(isCleanStop({ source: "stream" })).toBe(true);
});

test("isCleanStop ignores non-zero codes", () => {
	expect(isCleanStop(new Error("STOP_SENDING: 5"))).toBe(false);
	expect(isCleanStop(new Error("RESET_STREAM: 12"))).toBe(false);
	expect(isCleanStop(new Error("StopSending with code:5"))).toBe(false);
	expect(isCleanStop({ source: "stream", streamErrorCode: 5 })).toBe(false);
});

test("isCleanStop ignores session-scoped and unrelated errors", () => {
	expect(isCleanStop({ source: "session", streamErrorCode: 0 })).toBe(false);
	expect(isCleanStop(new Error("unexpected end of stream"))).toBe(false);
	expect(isCleanStop(new Error("STOP_SENDING: 0 trailing"))).toBe(false);
	expect(isCleanStop(undefined)).toBe(false);
	expect(isCleanStop("STOP_SENDING: 0")).toBe(false);
});
