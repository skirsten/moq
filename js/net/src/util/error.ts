// I hate javascript.
export function error(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

export function unreachable(value: never): never {
	throw new Error(`unreachable: ${value}`);
}

// Matches the code-0 stop/reset messages emitted by the qmux WebSocket shim
// ("STOP_SENDING: 0" / "RESET_STREAM: 0") and the @fails-components polyfill
// ("StopSending with code:0" / "Resetstream with code:0").
const CODE_ZERO_STOP_MESSAGE = /^(?:STOP_SENDING|RESET_STREAM): 0$|^(?:StopSending|Resetstream) with code:0$/;

// True when a rejection reason is a peer stop/cancel carrying application error
// code 0, i.e. a clean unsubscribe rather than a real failure. The peer sends
// STOP_SENDING (or RESET_STREAM) with code 0 when it drops a subscription after
// a delivered group, which must not tear down the shared upstream track.
export function isCleanStop(err: unknown): boolean {
	// Native WebTransport: a stream-scoped WebTransportError. streamErrorCode is
	// the application code (may be null when unavailable), so treat 0 or null as clean.
	const wt = err as { source?: unknown; streamErrorCode?: unknown } | null;
	if (wt && typeof wt === "object" && wt.source === "stream") {
		return wt.streamErrorCode === 0 || wt.streamErrorCode === null || wt.streamErrorCode === undefined;
	}

	// qmux and the polyfill only carry the code in the message string.
	return err instanceof Error && CODE_ZERO_STOP_MESSAGE.test(err.message);
}
