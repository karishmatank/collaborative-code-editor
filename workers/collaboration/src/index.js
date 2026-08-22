import { routePartykitRequest } from "partyserver";
// import { DurableObject } from "cloudflare:workers";


/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/**
 * Env provides a mechanism to reference bindings declared in wrangler.jsonc within JavaScript
 *
 * @typedef {Object} Env
 * @property {DurableObjectNamespace} MY_DURABLE_OBJECT - The Durable Object namespace binding
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
// export class MyDurableObject extends DurableObject {
// 	/**
// 	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
// 	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
// 	 *
// 	 * @param {DurableObjectState} ctx - The interface for interacting with Durable Object state
// 	 * @param {Env} env - The interface to reference bindings declared in wrangler.jsonc
// 	 */
// 	constructor(ctx, env) {
// 		super(ctx, env);
// 	}

// 	/**
// 	 * The Durable Object exposes an RPC method sayHello which will be invoked when a Durable
// 	 *  Object instance receives a request from a Worker via the same method invocation on the stub
// 	 *
// 	 * @param {string} name - The name provided to a Durable Object instance from a Worker
// 	 * @returns {Promise<string>} The greeting to be sent back to the Worker
// 	 */
// 	async sayHello(name) {
// 		return `Hello, ${name}!`;
// 	}
// }

// PartyKit provides a server for Yjs so that we don't have to implement our own
export { YServer as MyYServer } from "y-partyserver";

async function isExistingPad(db, padId) {
  // Check to make sure pad ID exists in the database
  const result = await db
    .prepare("SELECT * FROM pads WHERE id = ?")
    .bind(padId)
    .first();
  return result !== null;
}

function padIdFromPartykitUrl(request) {
  const { pathname } = new URL(request.url);
  // /parties/my-y-server/room-<padId>
  const match = pathname.match(/^\/parties\/[^/]+\/room-([^/]+)$/);
  return match ? match[1] : null;
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
    const padId = padIdFromPartykitUrl(request);

    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
    }

		return (
      (await routePartykitRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
	},
};
