/**
 * Relay capability quirks detected from the connection URL.
 *
 * @module
 */

// Cloudflare's MoQ relay does not support announce-based discovery.
const ANNOUNCE_LESS_SUFFIX = "mediaoverquic.com";

/**
 * Whether the relay at `url` lacks announce support, so consumers must
 * subscribe by exact path and poll instead of waiting for announcements.
 */
export function isAnnounceLess(url: URL): boolean {
	const host = url.hostname;
	return host === ANNOUNCE_LESS_SUFFIX || host.endsWith(`.${ANNOUNCE_LESS_SUFFIX}`);
}
