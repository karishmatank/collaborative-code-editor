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
		return getContainer(env.MY_CONTAINER, padId).fetch(request);
	},
};
