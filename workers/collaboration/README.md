# Collaboration Worker

Yjs WebSocket server for The SPOT Editor. A Cloudflare Worker accepts the connection, checks that the pad exists, then routes it to a Durable Object that runs [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver).

One live pad session maps to one Durable Object. The Worker does not implement the Yjs protocol itself.

For the design (why Durable Objects, generation IDs, hibernation on), see [`ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com/) + [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| Yjs on the object | [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver) / [partyserver](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) |
| Pad lookup | Same [D1](https://developers.cloudflare.com/d1/) database as persistence (`collab-pads`) |
| Frontend client | `YProvider` from `y-partyserver/provider` |

---

## Local Setup

**Prerequisites:** Node.js, Wrangler authenticated (`npx wrangler login`). This Worker reads `collab-pads`. Create that database and apply the schema from [`workers/persistence/README.md`](../persistence/README.md) first.

```bash
npm install
npx wrangler dev --persist-to ../../.wrangler/state --port 8787
```

`--persist-to ../../.wrangler/state` is the same directory persistence uses, so this Worker sees pads created there. If persistence is already using 8787, pick another port and point `VITE_WS_URL` at it.

---

## Deploying

```bash
npm run deploy
```

The remote `collab-pads` database (same `database_id` as persistence and execution) must already exist and have the schema applied.

---

## Connecting from the client

The frontend uses:

```js
new YProvider(host, `room-${padId}`, ydoc, { party: "my-y-server" })
```

| Piece | Value |
|---|---|
| Host | `VITE_WS_URL` (no `ws://` prefix in production; the provider adds the scheme) |
| Party | `my-y-server` (PartyKit name for the `MyYServer` class) |
| Room the client sends | `room-<padId>` |

The Worker rewrites the room to `room-<padId>-<generationId>` before `routePartykitRequest`, so a new study group can get a new Durable Object placed near them. Clients never deal with the generation ID directly.

Unknown pad IDs receive `404 Pad not found`.

---

## What this Worker does on connect

1. Parse the pad ID from `/parties/<party>/room-<padId>`.
2. Reject the request if that row is missing from D1.
3. Load or create `pads.generation` (`UPDATE … WHERE generation IS NULL`, then `SELECT`) so two first joiners share one ID.
4. Record `(pad_id, generation_id, connection_id)` in `pad_connections`, where `connection_id` is the `_pk` query param `YProvider` sends on every connect *and* reconnect. Only increment `pads.join_count` if that row didn't already exist — this keeps PartySocket/YProvider reconnects (network blips) from inflating the count. Requests without a `_pk` (e.g. an older client) always count.
5. Forward the WebSocket to the Durable Object for `room-<padId>-<generationId>`.

`MyYServer` extends `YServer` and leaves Yjs sync, awareness, and the in-memory `Y.Doc` to PartyKit.

When the last client disconnects, the object sets a Durable Object alarm for **20 seconds** instead of clearing generation immediately. `alarm()` always re-counts open sockets itself, so an alarm left over from before someone reconnected does nothing harmful. If the room is still empty when `alarm()` runs, the object:

- Sets `pads.generation` back to `NULL`, but only if the pad is still on *this room's* generation, so an old room can't wipe a newer live one
- Deletes Durable Object storage (and any alarm) so generation-scoped objects do not accumulate

If the D1 write fails, the alarm is re-armed (30 s) and storage is kept, so the clear is retried instead of lost. `alarm()` wraps the cleanup in `blockConcurrencyWhile` so a D1 write cannot interleave with a new connection.

**Recheck while the room has sockets.** Closing a socket only triggers the cleanup when it leaves zero sockets behind, and a dead socket that the runtime later drops silently never produces a close event. So whenever the room has sockets, one alarm is kept pending (every **60 seconds**). If `alarm()` finds sockets still open it just schedules the next check; once the count reaches zero it clears the generation as above.

**Heartbeat.** `y-partyserver` sends nothing while the editor is idle, so a dead connection (closed laptop, dropped Wi-Fi) looks the same as a quiet one. The client sends the text `ping` every 20 s (and right after each connect). The Durable Object registers `setWebSocketAutoResponse("ping" → "pong")`, so Cloudflare answers without waking the object and records the time per socket (`getWebSocketAutoResponseTimestamp`). The recheck alarm closes any socket with no ping for **3 minutes** (close code `4003`, logged as `closing idle socket`), using the connect time for a socket that never pinged. If that empties the room, the usual 20 s grace period applies before the generation is cleared. Old-build tabs don't ping, so until they refresh they get recycled about every 3 minutes (they reconnect on their own).

**Reconnects replace the old socket.** A reconnecting client reuses its `_pk`, but the server can hold on to the client's previous socket for minutes. `onConnect` closes any older socket with the same connection ID (close code `4001`), so ghost sockets don't inflate the socket count or keep the room alive.

**Logging.** `join` (Worker, with new/reconnect), `onConnect` and `onClose` (Durable Object, with connection ID, close code, socket count and, for connects, how many older sockets were replaced), and `alarm cleared`.

**Carriage-return check.** Clients force Monaco to `\n` line endings. `onSave` (debounced by `y-partyserver`) logs a warning once per room if `\r` ever appears in a shared `monaco-*` text, which would mean an out-of-date client or a new bug is causing Windows-style line endings.

Hibernation is **on** (`static options = { hibernate: true }`). We included additional logic to ask all connections to send awareness details (query message `3`) when the Durable Object wakes up (`onStart`) and when a new socket connects to the Durable Object (`onConnect`) so that all users have up-to-date awareness. `y-partyserver` already handles syncing the `Y.Doc` on Durable Object wake.

---

## Rate limiting

WebSocket messages never pass back through the Worker's `fetch` handler after the initial upgrade - they go straight to the Durable Object's `onMessage` - so, like the execution Worker, new connection attempts are rate limited in `src/index.js`, before `routePartykitRequest` (and the D1 generation/join-count writes that precede it) ever runs:

| Binding | Key | Limit | Catches |
|---|---|---|---|
| `COLLAB_LOCATION_LIMITER` | `"all"` (constant) | 40 / min | Many sources guessing pad IDs or opening connections at one Cloudflare location |
| `COLLAB_IP_LIMITER` | `cf-connecting-ip` | 10 / min | One source opening connections across many pads |
| `COLLAB_PAD_LIMITER` | `padId` (only once the pad is confirmed to exist) | 25 / min | Repeated connection churn against one pad, from any number of sources |

All three are Cloudflare's native [rate limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (`simple`, so each count is per Cloudflare location rather than fully global) and mirror `EXEC_LOCATION_LIMITER` / `EXEC_IP_LIMITER` / `EXEC_PAD_LIMITER` in [`workers/execution/`](../execution/README.md#rate-limiting). The location limiter uses a constant key because the binding already keeps a separate counter at each location; it runs first, so a flooded location returns `429` before any D1 access or Durable Object routing. Pads are used by groups of about 3–5 people. 40 attempts per minute covers one group reconnecting plus another group joining at the same location.

---

## Bindings

| Binding | Name | Purpose |
|---|---|---|
| Durable Object | `MY_Y_SERVER` → `MyYServer` | One Yjs room per live session |
| D1 | `collab_pads` | Pad existence, generation ID, join count, per-generation connection dedup |
| Rate limit | `COLLAB_LOCATION_LIMITER` | New connections per Cloudflare location, see [Rate limiting](#rate-limiting) |
| Rate limit | `COLLAB_IP_LIMITER` | New connections per IP, see [Rate limiting](#rate-limiting) |
| Rate limit | `COLLAB_PAD_LIMITER` | New connections per pad, see [Rate limiting](#rate-limiting) |

No secrets. CORS is not configured here; the browser talks WebSocket, not this Worker’s HTTP JSON API.
