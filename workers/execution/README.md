# Execution Worker

Sandboxed REPL and one-off code execution for The SPOT Editor. A Cloudflare Worker validates the pad, then proxies the browser WebSocket to a [Cloudflare Container](https://developers.cloudflare.com/containers/) keyed by pad + generation.

The Worker does not run student code. A Node.js server inside the container owns the PTY, editor runs, and shared terminal output.

For the design (why Containers, why `node-pty` inside the image, idle billing), see [`ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Cloudflare Worker + Container (the Container class extends a Durable Object) |
| Image | `container/Dockerfile` (Ubuntu with Python, Ruby, Node, PostgreSQL) |
| In-container server | Node.js + [ws](https://github.com/websockets/ws) + [node-pty](https://github.com/microsoft/node-pty) |
| Pad lookup | Same D1 database as persistence (`collab-pads`) |
| Frontend client | `WebSocket` in `src/js/terminal.js` |

---

## Local Setup

**Prerequisites:** Node.js, Docker, Wrangler authenticated (`npx wrangler login`). Create and migrate `collab-pads` from [`workers/persistence/README.md`](../persistence/README.md) first.

```bash
npm install
cd container && npm install && cd ..
npx wrangler dev --persist-to ../../.wrangler/state --port 8789
```

`--persist-to ../../.wrangler/state` is the same directory persistence uses, so this Worker sees pads created there. Wrangler builds the image from `container/Dockerfile` on first run. Point `VITE_EXECUTION_WS_URL` at `ws://localhost:8789`.

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
| `language` | Yes | `python`, `ruby`, `javascript`, `html`, or `sql`. Invalid values are ignored by the inner server (the socket is accepted, then dropped). |

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

All of the above are rate limited; see [Rate limiting](#rate-limiting) below.

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

## Rate limiting

WebSocket messages never pass back through the Worker's `fetch` handler after the initial upgrade, so rate limiting happens in two independent places.

**Tier 1- new connections (`src/index.js`, before a container is started):**

| Binding | Key | Limit | Catches |
|---|---|---|---|
| `EXEC_LOCATION_LIMITER` | `"all"` (constant) | 40 / min | Many sources guessing pad IDs or opening connections at one Cloudflare location |
| `EXEC_IP_LIMITER` | `cf-connecting-ip` | 10 / min | One source opening connections across many pads |
| `EXEC_PAD_LIMITER` | `padId` (only once the pad is confirmed to exist) | 25 / min | Repeated connection churn against one pad, from any number of sources |

All three are Cloudflare's native [rate limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), so each count is per Cloudflare location rather than fully global — see [`ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#code-execution-layer) for why that matters for a pad whose users aren't all in one place. The location limiter uses a constant key because the binding already keeps a separate counter at each location; it runs first, so a flooded location returns `429` before a container is ever touched. Pads are used by groups of about 3–5 people. 40 attempts per minute covers one group reconnecting plus another group joining at the same location.

**Tier 2- messages on an already-open socket (`container/server.js`, `container/rateLimiter.js`):** an in-memory sliding-window limiter inside the container itself, since Tier 1 can't see these.

| Message | Scope | Limit | Why |
|---|---|---|---|
| `ping` | per socket | 2 / sec | Real client sends one every 30s |
| `input` | per socket | 40 / sec | Generous- fast typing and paste are legitimate bursts |
| `stop` | per socket | 5 / sec | Cheap, but still bounded |
| `run` | per pad (shared) | 6 / min, plus no new run while one is in flight | Each run costs up to 15s of CPU and a process slot; also closes off a loop of instantly-failing runs |
| `reset` / `languageChange` | per pad (shared), one combined budget | 6 / min | Each kills and respawns the shared PTY — every connected client feels it |

`run`/`reset`/`languageChange` are budgeted per `PadSession`, not per socket, because the PTY they affect is shared by the whole room. Budgeting them per socket would let one abuser just open more sockets to the same pad to multiply their allowance. A socket that keeps tripping any Tier 2 limit is disconnected with close code `4002`, which the client treats like the idle close code `4000`: no auto-reconnect.

---

## Limits and lifecycle

| Limit | Value |
|---|---|
| One-off run timeout | 15 seconds |
| One-off output cap | 512 KB incremental |
| Idle disconnect | 25 minutes with no REPL message (`ping` does not count); close code `4000` |
| `sleepAfter` | `20s` after **all** sockets are closed |
| Last-socket teardown | PTY/`PadSession` kept until `SIGTERM` so a reconnect can reuse the REPL |
| Outbound network | `enableInternet = false` |
| Process count per sandbox user | 50 (`prlimit --nproc`, shared by the REPL and any one-off run) |
| Instance size | `lite` |
| Concurrent containers | `max_instances: 20` |

`sleepAfter` does not start while a tab still holds a WebSocket. The 25-minute timer closes those sockets (code `4000`) so Cloudflare can stop the VM. Last socket close does not destroy the PTY; `SIGTERM` / `SIGINT` do that and let Node exit. `onStop` deletes Durable Object storage for that generation.

User code runs as `sandbox` (`uid` on `node-pty` and `spawn`). Isolation of the VM itself is Cloudflare’s.

---

## Bindings

| Binding | Name | Purpose |
|---|---|---|
| Container / Durable Object | `MY_CONTAINER` → `MyContainer` | One sandbox per live session |
| D1 | `collab_pads` | Pad existence and generation ID |
| Rate limit | `EXEC_LOCATION_LIMITER` | New connections per Cloudflare location, see [Rate limiting](#rate-limiting) |
| Rate limit | `EXEC_IP_LIMITER` | New connections per IP, see [Rate limiting](#rate-limiting) |
| Rate limit | `EXEC_PAD_LIMITER` | New connections per pad, see [Rate limiting](#rate-limiting) |

No secrets. Language runtimes are in the image, not in Worker env vars (`WS_PORT=8080` is set on the Container class).
