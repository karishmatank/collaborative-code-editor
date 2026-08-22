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
}

async function isExistingPad(db, padId) {
  // Check to make sure pad ID exists in the database
  const result = await db
    .prepare("SELECT * FROM pads WHERE id = ?")
    .bind(padId)
    .first();
  return result !== null;
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
    const url = new URL(request.url, 'http://localhost');
    const padId = url.searchParams.get('padId');

    // Make sure the padId exists and is valid
    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
    }

		return getContainer(env.MY_CONTAINER, padId).fetch(request);
	},
};
