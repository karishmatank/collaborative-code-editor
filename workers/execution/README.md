# Execution Worker

Sandboxed REPL and one-off code execution for The SPOT Editor. A Cloudflare Worker validates the pad, then proxies the browser WebSocket to a [Cloudflare Container](https://developers.cloudflare.com/containers/) keyed by pad + generation.

The Worker does not run student code. A Node.js server inside the container owns the PTY, editor runs, and shared terminal output.

For the design (why Containers, why `node-pty` inside the image, idle billing), see [`ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Cloudflare Worker + Container (the Container class extends a Durable Object) |
| Image | `container/Dockerfile` (Ubuntu with Python, Ruby, Node, TypeScript, PostgreSQL) |
| In-container server | Node.js + [ws](https://github.com/websockets/ws) + [node-pty](https://github.com/microsoft/node-pty) |
| Pad lookup | Same D1 database as persistence (`collab-pads`) |
| Frontend client | `WebSocket` in `src/js/terminal.js` |

---

## Local Setup

**Prerequisites:** Node.js, Docker, Wrangler authenticated (`npx wrangler login`). Create and migrate `collab-pads` from [`workers/persistence/README.md`](../persistence/README.md) first.

Local D1 is per Wrangler project, so apply the schema here as well:

```bash
npm install
cd container && npm install && cd ..
npx wrangler d1 execute collab-pads --local --file=../persistence/schema.sql
npx wrangler dev --port 8789
```

Wrangler builds the image from `container/Dockerfile` on first run. Point `VITE_EXECUTION_WS_URL` at `ws://localhost:8789`.

---

## Deploying

```bash
npm run deploy
```

Wrangler uploads the container image and the Worker together. Remote D1 must already have the schema. `max_instances` is 20 (`wrangler.jsonc`); that is why pads are minted only through the authenticated persistence API.

---

## Connecting from the client

```
GET wss://<this-worker>/?padId=<padId>&language=<language>
```

| Query | Required | Notes |
|---|---|---|
| `padId` | Yes | Must exist in D1 or the Worker returns `404 Pad not found` |
| `language` | Yes | `python`, `ruby`, `javascript`, `typescript`, `html`, or `sql`. Invalid values are ignored by the inner server (the socket is accepted, then dropped). |

The Worker loads or creates the same `pads.generation` column the collaboration Worker uses, then calls `getContainer(env.MY_CONTAINER, "<padId>-<generationId>")`. The Container class proxies the WebSocket to port 8080 inside the image.

---

## Inside the container

```
container/
├── Dockerfile      # PID 1 is `node /app/server.js`
├── server.js       # ReplServer + PadSession (one pad per VM)
└── pty.js          # node-pty for both the REPL and Run, exec for Postgres
```

Cloudflare starts and stops the VM. `ReplServer` holds a single `PadSession`. Concurrent first joiners await the same setup Promise so the PTY is not created twice.

| Concern | Implementation |
|---|---|
| REPL | `node-pty` as user `sandbox` (`python3`, `node`, `irb`, `ts-node`, `psql`), fixed at 80 cols × 40 rows |
| Run button | A second, disposable `node-pty` process (`python3 -c`, `node -e`, …), same fixed size, killed when the run ends. Has its own stdin, so `input`/`gets` work like they do in the REPL |
| HTML | No PTY |
| SQL first use | `pg_ctlcluster 18 main start`, `pg_isready`, then `student` / `studentdb` |
| Health | `GET /ping` → `200 ok` (Cloudflare) |

---

## WebSocket protocol

JSON text frames. The inner server broadcasts to every connected client in that container.

### Client → server

| `type` | Fields | Effect |
|---|---|---|
| `input` | `data` (string) | Write to whichever PTY is currently live — the run's, if one is in progress, the main REPL's otherwise. Echo comes back as `output`. |
| `languageChange` | `language` | Kill the current PTY, clear the output log, start a new PTY (no-op for `html`). |
| `run` | `code`, `preMessage` | One-off process; REPL output suppressed until it finishes. |
| `stop` | — | Kill the current one-off process. |
| `reset` | — | Clear the log, restart the PTY for the current language. |
| `ping` | — | Heartbeat. Keeps the edge connection alive; does **not** reset the idle timer. |

### Server → client

| `type` | Fields | Effect |
|---|---|---|
| `ready` | — | Session (and PTY, if any) is up. |
| `output` | `data` | Incremental terminal bytes. Late joiners get the full log as one `output` first. |
| `runTriggered` | — | Show Stop, hide Run. |
| `stopTriggered` | — | Show Run, hide Stop. |
| `runFinished` | — | Same UI as stop; run completed on its own. |
| `reset` | — | Client should clear the xterm buffer. |
| `error` | `data` | Display a highlighted error string. |

The client (`src/js/terminal.js`) pings every 30 seconds while the socket is open.

On unexpected close, it retries up to three times (resetting xterm on `open` so the server's output replay is not duplicated). Tab close (`disconnect()`) and idle close code `4000` do not retry. After failed retries, or on idle, the terminal shows a refresh message.

---

## Limits and lifecycle

| Limit | Value |
|---|---|
| One-off run timeout | 15 seconds |
| One-off output cap | 512 KB incremental |
| Idle disconnect | 20 minutes with no REPL message (`ping` does not count); close code `4000` |
| `sleepAfter` | `20s` after **all** sockets are closed |
| Last-socket teardown | PTY/`PadSession` kept until `SIGTERM` so a reconnect can reuse the REPL |
| Outbound network | `enableInternet = false` |
| Instance size | `lite` |
| Concurrent containers | `max_instances: 20` |

`sleepAfter` does not start while a tab still holds a WebSocket. The 20-minute timer closes those sockets (code `4000`) so Cloudflare can stop the VM. Last socket close does not destroy the PTY; `SIGTERM` / `SIGINT` do that and let Node exit. `onStop` deletes Durable Object storage for that generation.

User code runs as `sandbox` (`uid` on `node-pty` and `spawn`). Isolation of the VM itself is Cloudflare’s.

---

## Bindings

| Binding | Name | Purpose |
|---|---|---|
| Container / Durable Object | `MY_CONTAINER` → `MyContainer` | One sandbox per live session |
| D1 | `collab_pads` | Pad existence and generation ID |

No secrets. Language runtimes are in the image, not in Worker env vars (`WS_PORT=8080` is set on the Container class).
