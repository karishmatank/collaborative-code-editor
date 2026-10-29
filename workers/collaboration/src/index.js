import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
// import { DurableObject } from "cloudflare:workers";

const GENERATION_CLEAR_DELAY_MS = 20 * 1000; // 20s grace so a blip can reconnect to the same generation

// While a room has sockets, we re-count them this often. A close that leaves other
// sockets behind never triggers the clear on its own, and sockets the runtime
// later drops silently never trigger a close event at all, so without this a room
// could keep its generation (and the container) forever.
const CLEANUP_RECHECK_INTERVAL_MS = 60 * 1000;
const CLEANUP_RETRY_DELAY_MS = 30 * 1000; // if clearing the generation in D1 failed

// Sent to an older socket when the same client (same `_pk`) opens a newer one
const REPLACED_CLOSE_CODE = 4001;

// Heartbeat. Clients send HEARTBEAT_PING on a timer (see ConnectionManager in
// src/js/collaboration.js). Cloudflare answers it with HEARTBEAT_PONG without waking
// the Durable Object, and remembers when it last did so for each socket. The
// recheck alarm closes sockets that have gone quiet for too long, which is how we
// notice dead connections (closed laptop, dropped Wi-Fi) that never send a close.
// The timeout must stay well above the client's ping interval, because browsers
// slow timers in background tabs to about once a minute.
const HEARTBEAT_PING = "ping";
const HEARTBEAT_PONG = "pong";
const SOCKET_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const IDLE_CLOSE_CODE = 4003;

// Per-socket values saved in the connection state. The token lets a new socket tell
// itself apart from older sockets that share its connection id. connectedAt is the
// fallback "last heard from" time for a socket that has never sent a ping.
const SOCKET_TOKEN_KEY = "__spotSocketToken";
const CONNECTED_AT_KEY = "__spotConnectedAt";
// Set once we have closed a socket ourselves and already removed its awareness state.
// The platform's own close event for it can arrive many minutes later (a dead client
// never answers the close frame), and by then a reconnected client may be using the
// same Yjs client id, so that late event must not remove awareness a second time.
const RETIRED_KEY = "__spotRetired";

// Rooms are named room-<padId>-<generationId>, where generationId is a UUID
const ROOM_NAME_PATTERN =
  /^room-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function parseRoomName(name) {
  const match = name.match(ROOM_NAME_PATTERN);
  return match ? { padId: match[1], generationId: match[2] } : null;
}

// Yjs queryAwareness (message type 3). After hibernation the in-memory awareness
// map is empty, so ask connected clients to send names and cursors again.
const AWARENESS_QUERY = new Uint8Array([3]);

function requestAwareness(server) {
  for (const connection of server.getConnections()) {
    try {
      connection.send(AWARENESS_QUERY);
    } catch {
      // Socket is already closing.
    }
  }
}


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
    hibernate: true
  };

  constructor(ctx, env) {
    super(ctx, env);
    // Must be set on every wake-up, so it lives in the constructor
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG)
    );
  }

  async onStart() {
    await super.onStart();
    // Existing sockets are already tracked. The joiner that woke us is not
    // accepted yet, so onConnect queries again once they are in the list.
    requestAwareness(this);
  }

  async onConnect(connection, ctx) {
    // A reconnecting client reuses its `_pk`, but the server may still be holding its
    // previous socket (a dead connection is only noticed minutes later). Close those
    // older sockets now so they stop inflating the socket count.
    const replaced = this.closeOlderSocketsFor(connection);

    await super.onConnect(connection, ctx);

    // Make sure this room is being re-checked for emptiness while it has sockets.
    // We deliberately do not cancel a pending alarm: alarm() re-counts sockets
    // itself, so a stale alarm does nothing while someone is connected.
    await this.ensureCleanupCheckScheduled();
    requestAwareness(this);

    const userAgent = ctx?.request?.headers?.get("user-agent")?.slice(0, 120) ?? "-";
    console.log(
      "onConnect",
      this.name,
      [...this.getConnections()].length,
      `id=${connection.id} replaced=${replaced} ua=${userAgent}`
    );
  }

  async onClose(ws, code, reason, wasClean) {
    // A socket we retired already had its awareness state removed. Doing it again
    // now could delete the state of a newer socket from the same client.
    if (!ws.state?.[RETIRED_KEY]) {
      await super.onClose(ws, code, reason, wasClean);
    }

    // ctx.getWebSockets() only lists hibernatable sockets. With
    // hibernate: false, PartyServer uses in-memory connections instead.
    const remaining = [...this.getConnections()].length;
    console.log("onClose", this.name, remaining, `id=${ws.id} code=${code} clean=${wasClean}`);

    if (remaining === 0) {
      // Last client left: wait before clearing generation so a reconnect
      // (network blip, PartySocket retry) can reuse this room and container
      await this.ctx.storage.setAlarm(Date.now() + GENERATION_CLEAR_DELAY_MS);
    } else {
      // Others are still here, as far as we can tell. Re-check later in case some
      // of those sockets are already dead and will never report a close event.
      await this.ensureCleanupCheckScheduled();
    }
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      // Drop sockets that stopped pinging, then count what is left. Counting
      // fresh here rather than trusting whatever scheduled this alarm.
      const idleClosed = await this.closeIdleSockets();
      const live = [...this.getConnections()].length;
      if (live > 0) {
        await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RECHECK_INTERVAL_MS);
        return;
      }

      // We just emptied the room ourselves. Give those clients the usual grace
      // period to reconnect (e.g. a frozen tab waking up) before clearing.
      if (idleClosed > 0) {
        await this.ctx.storage.setAlarm(Date.now() + GENERATION_CLEAR_DELAY_MS);
        return;
      }

      const room = parseRoomName(this.name);
      try {
        if (room) {
          await clearGenerationId(this.env.collab_pads, room.padId, room.generationId);
        }
      } catch (error) {
        // Keep the room and its alarm so the clear is attempted again
        console.error("Failed to clear generation, will retry", this.name, error);
        await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_DELAY_MS);
        return;
      }

      console.log("alarm cleared", this.name);

      // Clear storage so that Cloudflare deletes the Durable Object
      // Otherwise, we'll accumulate a million DOs given all the generation IDs
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  // y-partyserver calls this (debounced) after document updates. We use it only as a
  // cheap hook for a sanity check: shared text should never contain "\r". Monaco is
  // forced to "\n" line endings on the client, so a "\r" means an out-of-date client
  // (or a new bug) is putting 2-character line breaks into the document, which
  // throws off every other user's edit and cursor positions.
  async onSave() {
    if (this.warnedAboutCarriageReturns) return;

    for (const key of this.document.share.keys()) {
      if (!key.startsWith("monaco-")) continue;
      if (this.document.getText(key).toString().includes("\r")) {
        this.warnedAboutCarriageReturns = true;
        console.warn("Carriage return found in shared text", this.name, key);
        return;
      }
    }
  }

  // Closes any other open socket that belongs to the same client (same connection
  // id) as `connection`. Returns how many were closed.
  closeOlderSocketsFor(connection) {
    const token = crypto.randomUUID();
    connection.setState((previous) => ({
      ...previous,
      [SOCKET_TOKEN_KEY]: token,
      [CONNECTED_AT_KEY]: Date.now()
    }));

    let closed = 0;
    for (const other of this.getConnections(connection.id)) {
      if (other.state?.[SOCKET_TOKEN_KEY] === token) continue; // that's the new socket

      try {
        other.close(REPLACED_CLOSE_CODE, "replaced by a newer connection");
        closed += 1;
      } catch {
        // Already closing or closed
      }

      // The old socket may not report its close for many minutes (or ever), so
      // remove its awareness state (name, cursor) now.
      this.retireSocket(other, REPLACED_CLOSE_CODE, "replaced by a newer connection");
    }
    return closed;
  }

  // Removes a socket's awareness state right away and marks it so the platform's
  // eventual close event does not do it again. Safe to call more than once.
  retireSocket(ws, code, reason) {
    if (ws.state?.[RETIRED_KEY]) return;

    // Read the awareness ids before touching state, then flag the socket
    super.onClose(ws, code, reason, false);
    try {
      ws.setState((previous) => ({ ...previous, [RETIRED_KEY]: true }));
    } catch {
      // Socket already gone. The late close event will just repeat the cleanup.
    }
  }

  // Closes sockets we haven't heard a ping from within SOCKET_IDLE_TIMEOUT_MS.
  // Returns how many were closed.
  async closeIdleSockets() {
    const now = Date.now();
    let closed = 0;

    for (const ws of this.getConnections()) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      // Sockets opened before this code existed have no connectedAt: treat them as
      // just seen rather than closing them
      const connectedAt = ws.state?.[CONNECTED_AT_KEY] ?? now;
      const lastHeard = Math.max(lastPing, connectedAt);

      if (now - lastHeard <= SOCKET_IDLE_TIMEOUT_MS) continue;

      console.log(
        "closing idle socket",
        this.name,
        `id=${ws.id} lastPing=${lastPing ? new Date(lastPing).toISOString() : "never"}`,
        `connectedAt=${new Date(connectedAt).toISOString()}`
      );

      try {
        ws.close(IDLE_CLOSE_CODE, "no heartbeat");
      } catch {
        // Already closing or closed
      }
      closed += 1;

      // A dead socket may never deliver a close event, so drop its awareness state now
      this.retireSocket(ws, IDLE_CLOSE_CODE, "no heartbeat");
    }
    return closed;
  }

  // Keeps one alarm pending while the room is alive so we always come back to
  // re-count sockets. Never pushes back an alarm that is already scheduled.
  async ensureCleanupCheckScheduled() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RECHECK_INTERVAL_MS);
    }
  }
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// Rate limiting: throttles new WebSocket connection attempts (i.e. new
// Durable Object wake-ups) before any D1 access. This cannot see, and is not
// meant to see, messages sent over an already-open socket - those go straight
// to the Durable Object's `onMessage` and never re-enter this fetch handler.
// Mirrors the execution Worker's Tier 1 (see workers/execution/src/index.js).

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

async function getGenerationId(db, padId) {
  // Sets a generation only if this pad has no live session
  // Then read whatever is stored whether it was just stored or not
  //  so two first joiners share one ID
  await db
    .prepare("UPDATE pads SET generation = ?, updated_at = ? WHERE id = ? AND generation IS NULL")
    .bind(crypto.randomUUID(), formatTimestamp(), padId)
    .run();

  return db
    .prepare("SELECT generation FROM pads WHERE id = ?")
    .bind(padId)
    .first("generation");
}

async function clearGenerationId(db, padId, generationId) {
  // Only clear the generation this room belongs to. If the pad has already moved on
  // to a newer generation, an old room must not wipe it out from under live users.
  await db.prepare("UPDATE pads SET generation = NULL, updated_at = ? WHERE id = ? AND generation = ?")
    .bind(formatTimestamp(), padId, generationId)
    .run();
}

async function incrementJoinCount(db, padId) {
  await db
    .prepare("UPDATE pads SET join_count = join_count + 1, updated_at = ? WHERE id = ?")
    .bind(formatTimestamp(), padId)
    .run();
}

async function isNewConnectionForGeneration(db, padId, generationId, connectionId) {
  // Records this (pad, generation, connection) tuple the first time it's seen.
  // PartySocket/YProvider reconnect attempts reuse the same connectionId (`_pk`),
  // so this tells us apart a genuine new joiner from a reconnect within the same
  // generation, since `join_count` should only reflect the former
  if (!connectionId) {
    // No connection id on the request (e.g. an older client) - fall back to counting it
    return true;
  }

  const result = await db
    .prepare(
      `INSERT INTO pad_connections (pad_id, generation_id, connection_id, first_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (pad_id, generation_id, connection_id) DO NOTHING`
    )
    .bind(padId, generationId, connectionId, formatTimestamp())
    .run();

  return result.meta.changes === 1;
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
    // Shared ceiling for every client at this Cloudflare location, before we
    // touch D1. Many IPs guessing pad IDs still share this one budget.
    if (!(await isWithinLocationLimit(env.COLLAB_LOCATION_LIMITER))) {
      return new Response("Too many requests", { status: 429 });
    }

    // One IP opening too many connections, across any pad.
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await isWithinIpLimit(env.COLLAB_IP_LIMITER, ip))) {
      return new Response("Too many requests", { status: 429 });
    }

    // Check padID validity
    const padId = padIdFromPartykitUrl(request);

    if (!padId || !(await isExistingPad(env.collab_pads, padId))) {
      return new Response("Pad not found", { status: 404 });
    }

    // Second check: one real pad being connected to too often, regardless of
    // how many different IPs are doing it. Only spent on pads confirmed to
    // exist, since that's the only case that reaches the generation/join-count
    // writes below.
    if (!(await isWithinPadLimit(env.COLLAB_PAD_LIMITER, padId))) {
      return new Response("Too many requests", { status: 429 });
    }

    // Get generation ID first, since join counting is scoped to a generation
    const generationId = await getGenerationId(env.collab_pads, padId);
    if (!generationId) {
      return new Response("Pad not found", { status: 404 });
    }

    // Only increment join count the first time we see this connection
    // (identified by the `_pk` YProvider sends) for this pad + generation.
    // Reconnects (network blips, PartySocket retries) reuse the same `_pk`
    // and should not inflate the count.
    const connectionId = new URL(request.url).searchParams.get("_pk");
    const isNewConnection = await isNewConnectionForGeneration(env.collab_pads, padId, generationId, connectionId);
    if (isNewConnection) {
      await incrementJoinCount(env.collab_pads, padId);
    }
    console.log("join", padId, generationId, connectionId ?? "-", isNewConnection ? "new" : "reconnect");

    // Append generation ID onto the request
    const url = new URL(request.url);
    url.pathname = url.pathname + `-${generationId}`;

		return (
      (await routePartykitRequest(new Request(url, request), env)) ||
      new Response("Not Found", { status: 404 })
    );
	},
};
