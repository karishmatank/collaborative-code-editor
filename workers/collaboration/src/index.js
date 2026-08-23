import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
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
export class MyYServer extends YServer {
  static options = {
    hibernate: false
  };

  async onClose(ws, code, reason, wasClean) {
    await super.onClose(ws, code, reason, wasClean);

    // ctx.getWebSockets() only lists hibernatable sockets. With
    // hibernate: false, PartyServer uses in-memory connections instead.
    const remaining = [...this.getConnections()].length;
    console.log("onClose", this.name, remaining);

    // If we are the last user, clean up the generation ID
    if (remaining === 0) {
      const padId = this.name.match(/^room-([^-]+)-/)?.[1];
      if (padId) {
        await clearGenerationId(this.env.collab_pads, padId);
      }

      // Clear storage so that Cloudflare deletes the Durable Object
      // Otherwise, we'll accumulate a million DOs given all the generation IDs
      await this.ctx.storage.deleteAlarm?.();
      await this.ctx.storage.deleteAll();
    }
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

async function clearGenerationId(db, padId) {
  await db.prepare("UPDATE pads SET generation = NULL WHERE id = ?")
    .bind(padId)
    .run();
}

async function incrementJoinCount(db, padId) {
  await db
    .prepare("UPDATE pads SET join_count = join_count + 1 WHERE id = ?")
    .bind(padId)
    .run();
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
    // Check padID validity
    const padId = padIdFromPartykitUrl(request);

    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
    }

    // Increment join count
    await incrementJoinCount(env.collab_pads, padId);

    // Get generation ID
    const generationId = await getGenerationId(env.collab_pads, padId);
    if (!generationId) {
      return new Response("Pad not found", { status: 404 });
    }

    // Append generation ID onto the request
    const url = new URL(request.url);
    url.pathname = url.pathname + `-${generationId}`;

		return (
      (await routePartykitRequest(new Request(url, request), env)) ||
      new Response("Not Found", { status: 404 })
    );
	},
};
