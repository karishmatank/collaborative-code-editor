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

async function getGenerationId(db, padId) {
  // Sets a generation only if this pad has no live session
  // Then read whatever is stored whether it was just stored or not
  //  so two first joiners share one ID
  const updatedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  await db
    .prepare("UPDATE pads SET generation = ?, updated_at = ? WHERE id = ? AND generation IS NULL")
    .bind(crypto.randomUUID(), updatedAt, padId)
    .run();

  return db
    .prepare("SELECT generation FROM pads WHERE id = ?")
    .bind(padId)
    .first("generation");
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
    // Cheapest check first: one IP opening too many connections, across any
    // pad, before we ever touch D1.
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

    // Get generation ID
    const generationId = await getGenerationId(env.collab_pads, padId);
    if (!generationId) {
      return new Response("Pad not found", { status: 404 });
    }

    // Append generation ID onto the request
    const newPadId = `${padId}-${generationId}`;

		return getContainer(env.MY_CONTAINER, newPadId).fetch(request);
	},
};
