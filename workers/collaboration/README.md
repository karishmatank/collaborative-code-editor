# Collaboration Worker

Yjs WebSocket server for The SPOT Editor. A Cloudflare Worker accepts the connection, checks that the pad exists, then routes it to a Durable Object that runs [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver).

One live pad session maps to one Durable Object. The Worker does not implement the Yjs protocol itself.

For the design (why Durable Objects, generation IDs, hibernation off), see [`ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

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

**Prerequisites:** Node.js, Wrangler authenticated (`npx wrangler login`). This Worker reads `collab-pads`; create and migrate that database from [`workers/persistence/README.md`](../persistence/README.md) first.

Wrangler keeps a **local** D1 per project directory. Apply the schema here too, even if you already applied it under `workers/persistence/`:

```bash
npm install
npx wrangler d1 execute collab-pads --local --file=../persistence/schema.sql
npx wrangler dev --port 8787
```

If persistence is already using 8787, pick another port and point `VITE_WS_URL` at it.

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
3. Increment `pads.join_count`.
4. Load or create `pads.generation` (`UPDATE … WHERE generation IS NULL`, then `SELECT`) so two first joiners share one ID.
5. Forward the WebSocket to the Durable Object for `room-<padId>-<generationId>`.

`MyYServer` extends `YServer` and leaves Yjs sync, awareness, and the in-memory `Y.Doc` to PartyKit.

When the last client disconnects, the object sets a Durable Object alarm for **20 seconds** instead of clearing generation immediately. `onConnect` deletes that alarm if someone returns (PartySocket retry, network blip). If the room is still empty when `alarm()` runs, the object:

- Sets `pads.generation` back to `NULL`
- Deletes Durable Object storage (and any alarm) so generation-scoped objects do not accumulate

`alarm()` wraps that cleanup in `blockConcurrencyWhile` so a D1 write cannot interleave with a new connection.

Hibernation is **off** (`static options = { hibernate: false }`). With it on, rooms drifted out of sync across browsers after the idle window.

---

## Bindings

| Binding | Name | Purpose |
|---|---|---|
| Durable Object | `MY_Y_SERVER` → `MyYServer` | One Yjs room per live session |
| D1 | `collab_pads` | Pad existence, generation ID, join count |

No secrets. CORS is not configured here; the browser talks WebSocket, not this Worker’s HTTP JSON API.
