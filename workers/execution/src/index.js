import { Container, getContainer } from "@cloudflare/containers";

export class MyContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "7s";
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
  await db
    .prepare("UPDATE pads SET generation = ? WHERE id = ? AND generation IS NULL")
    .bind(crypto.randomUUID(), padId)
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
    const url = new URL(request.url);
    const padId = url.searchParams.get('padId');

    // Make sure the padId exists and is valid
    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
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
