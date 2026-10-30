import { Container, getContainer } from "@cloudflare/containers";

export class MyContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "20s";
  envVars = {
    WS_PORT: '8080'
  }
  enableInternet = false;

  // The Container class automatically supports proxying WebSocket connections to your container
  // so we don't need to do it ourselves

  // DIAGNOSTICS: log the container SDK's count of open proxied requests. sleepAfter never
  // starts while this is above zero, so if a container stays up after everyone has left,
  // these lines show whether the count is stuck. The activity check logs about every
  // 20s while a container is running; delete these three methods to silence them.
  // (These SDK methods are private in the TypeScript types but exist at runtime.)
  async containerFetch(...args) {
    const response = await super.containerFetch(...args);
    console.log("inflight after proxied request opened:", this.inflightRequests);
    return response;
  }

  decrementInflight() {
    super.decrementInflight();
    console.log("inflight after a proxied request ended:", this.inflightRequests);
  }

  // The SDK calls this on each of its ~20s alarms to decide whether to stop the container
  isActivityExpired() {
    const expired = super.isActivityExpired();
    console.log("activity check: inflight =", this.inflightRequests, "expired =", expired);
    return expired;
  }

  async onStop(...args) {
    await super.onStop(...args);
    
    // Same idea as the Yjs room: this generation's isolate should not
    // keep SQLite after the VM has stopped (sleep or last disconnect).
    await this.ctx.storage.deleteAlarm?.();
    await this.ctx.storage.deleteAll();
  }
}

// Tier 1 rate limiting: throttles new WebSocket connection attempts (i.e. new
// container starts) before they reach getContainer(). This cannot see, and is
// not meant to see, messages sent over an already-open socket - those never
// re-enter this fetch handler, so they're rate limited separately inside the
// container itself (see server.js).

// simple rate-limit bindings already count separately per Cloudflare location,
// so a constant key is a ceiling for every client at that location.
const LOCATION_LIMIT_KEY = "all";

async function isWithinLocationLimit(limiter) {
  const { success } = await limiter.limit({ key: LOCATION_LIMIT_KEY });
  return success;
}

async function isWithinIpLimit(limiter, ip) {
  const { success } = await limiter.limit({ key: ip });
  return success;
}

async function isWithinPadLimit(limiter, padId) {
  const { success } = await limiter.limit({ key: padId });
  return success;
}

async function isExistingPad(db, padId) {
  // Check to make sure pad ID exists in the database
  const result = await db
    .prepare("SELECT * FROM pads WHERE id = ?")
    .bind(padId)
    .first();
  return result !== null;
}

// How long to wait for the collaboration Worker to create the generation. The
// browser opens this connection and the collaboration one at about the same time,
// so on a pad's first join we can arrive a moment before it.
const GENERATION_POLL_ATTEMPTS = 10;
const GENERATION_POLL_INTERVAL_MS = 250;

async function getGenerationId(db, padId) {
  // This Worker only READS the generation, it never creates one. The collaboration
  // Worker creates it, and its Durable Object is what clears it again once the room
  // empties. A generation created here could exist with no collaboration room to ever
  // clear it (and a late reconnect could even bring back one that was just cleared),
  // which left the generation set and the container running.
  for (let attempt = 0; attempt < GENERATION_POLL_ATTEMPTS; attempt += 1) {
    const generationId = await db
      .prepare("SELECT generation FROM pads WHERE id = ?")
      .bind(padId)
      .first("generation");
    if (generationId) return generationId;

    await new Promise((resolve) => setTimeout(resolve, GENERATION_POLL_INTERVAL_MS));
  }
  return null;
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param {Request} request - The request submitted to the Worker from the client
	 * @param {Env} env - The interface to reference bindings declared in wrangler.jsonc
	 * @param {ExecutionContext} ctx - The execution context of the Worker
	 * @returns {Promise<Response>} The response to be sent back to the client
	 */
	async fetch(request, env, ctx) {
    // Shared ceiling for every client at this Cloudflare location, before we
    // touch D1. Many IPs guessing pad IDs still share this one budget.
    if (!(await isWithinLocationLimit(env.EXEC_LOCATION_LIMITER))) {
      return new Response("Too many requests", { status: 429 });
    }

    // One IP opening too many connections, across any pad.
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await isWithinIpLimit(env.EXEC_IP_LIMITER, ip))) {
      return new Response("Too many requests", { status: 429 });
    }

    const url = new URL(request.url);
    const padId = url.searchParams.get('padId');

    // Make sure the padId exists and is valid
    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
    }

    // Second check: one real pad being connected to too often, regardless of
    // how many different IPs are doing it. Only spent on pads confirmed to
    // exist, since that's the only case that reaches the expensive part below.
    if (!(await isWithinPadLimit(env.EXEC_PAD_LIMITER, padId))) {
      return new Response("Too many requests", { status: 429 });
    }

    // Get generation ID (created by the collaboration Worker, see getGenerationId)
    const generationId = await getGenerationId(env.collab_pads, padId);
    if (!generationId) {
      // Not an error in the pad itself. The browser treats a failed connection as a
      // disconnect and retries shortly.
      return new Response("Session not ready, please retry", { status: 503 });
    }

    // Append generation ID onto the request
    const newPadId = `${padId}-${generationId}`;

		return getContainer(env.MY_CONTAINER, newPadId).fetch(request);
	},
};
