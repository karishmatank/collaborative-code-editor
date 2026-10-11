"use strict";

/**
 * Tier 2 of execution rate limiting: per-message throttling inside the
 * container itself.
 *
 * Cloudflare's rate limit binding (used in src/index.js) only sees the
 * initial WebSocket upgrade request. Every message sent after that - input,
 * run, reset, languageChange, ping - goes straight to this process over the
 * already-open socket and never touches the Worker again, so it needs its
 * own, independent throttle.
 *
 * This is a simple sliding-window counter. It lives entirely in memory,
 * which is fine here because Cloudflare already gives us one Node process
 * per pad (one PadSession, see server.js) - there is nothing to share across
 * processes the way the Worker's rate limit binding has to.
 */
export class RateLimiter {
  constructor(maxEvents, windowMs) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  /**
   * Records the event and returns true if it is allowed, or returns false
   * without recording it if the caller is already at the limit for the
   * current window.
   */
  tryConsume() {
    const now = Date.now();

    // Drop anything that's aged out of the window. The array only ever
    // holds up to maxEvents entries, so this stays cheap.
    while (this.timestamps.length && now - this.timestamps[0] > this.windowMs) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxEvents) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}
