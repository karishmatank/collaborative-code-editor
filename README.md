# The SPOT Editor

A real-time collaborative code editor built for [Launch School](https://launchschool.com/) students to study and work through problems together.

Pads are permanent links: create one once, share it, and come back later. Everyone in a pad sees the same editor, cursors, language selection, and terminal output live.

---

## Why

Launch School study sessions previously relied on [Coderpad](https://coderpad.io/). That created two recurring problems: the free-tier limit pushed SPOT moderators to rotate accounts every two weeks to trigger new free trials, and those rotating links had to be manually updated in roughly 40 locations in the shared Gather workspace each time.

This editor solves both. Pads persist, so links never need replacing.

---

## Features

- **Real-time collaborative editing** - See other users' cursors and edits live. Conflict resolution is handled by a CRDT (Yjs).
- **User presence** - Colored name pills in the header; hover a remote cursor to see whose it is.
- **Multi-language support** - Python, JavaScript, TypeScript, Ruby, PostgreSQL, and HTML.
- **Interactive REPL** - An xterm.js terminal per pad, backed by a Cloudflare Container. All users share the same session output in real time, and late joiners receive prior output on connect.
- **Run / Stop / Reset** - Run editor code in a sandboxed one-off process, stop a long-running execution mid-run, or reset the terminal and restart the REPL.
- **HTML live preview** - Edits render immediately in a sandboxed `<iframe>`; Run is disabled for HTML.
- **Persistent pads** - Content and language selection are saved per pad per language and restored on the next visit.
- **Resizable panes** - Drag the divider to adjust the editor/output split; layout stacks top/bottom below 900 px.
- **In-editor name editing** - Click the pencil next to your name pill to update your display name without leaving the pad.
- **Invalid pad handling** - Visiting an unknown pad ID redirects to an error page.

### Future

- Basic IntelliSense for Python, Ruby, and SQL via language server integration
- Multi-file HTML environment (à la Coderpad's Vite mode)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend build and hosting | [Vite](https://vitejs.dev/) on [Cloudflare Pages](https://pages.cloudflare.com/) |
| Editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Collaboration / CRDT | [Yjs](https://yjs.dev/) + [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver) + [y-monaco](https://github.com/yjs/y-monaco) |
| Collaboration server | Cloudflare Worker + Durable Object (one Yjs room per live pad session) |
| Terminal (frontend) | [xterm.js](https://xtermjs.org/) |
| Execution server | Cloudflare Worker + [Cloudflare Container](https://developers.cloudflare.com/containers/) (one container per live pad session) |
| In-container runtime | Node.js + [ws](https://github.com/websockets/ws) + [node-pty](https://github.com/microsoft/node-pty) |
| Persistence API | Cloudflare Worker + [Hono](https://hono.dev/) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| Pad ID generation | [nanoid](https://github.com/ai/nanoid) |

---

## Architecture (short version)

The browser talks to three independent Cloudflare Workers. None of them share a process with each other.

![Architecture diagram of The SPOT Editor on Cloudflare](./docs/architecture.png)

- **Collaboration** syncs editor text, language selection, cursors, and names. PartyKit's `y-partyserver` runs Yjs inside a Durable Object, so I did not implement a Yjs server myself.
- **Persistence** is a small REST API over D1. It does not know about Yjs or terminals.
- **Execution** routes each pad to its own container. A Node server inside the container owns the PTY, one-off runs, and shared terminal output.

Durable Object placement is sticky: Cloudflare pins an object near where it was first created. Pads therefore use a **generation ID** (a per-session UUID stored on the pad row) so a new group of students tomorrow can get a new object near *them*, rather than inheriting yesterday's location forever.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, including why these pieces are separate and the tradeoffs behind D1, Durable Objects, and Containers.

---

## Project Structure

```
collaborative-code-editor/
├── index.html                  # App shell + name modal
├── invalid.html                # Shown when a pad ID is not found
├── src/
│   ├── js/
│   │   ├── main.js             # Entry point - wires all modules together
│   │   ├── editor.js           # Monaco editor + per-language model management
│   │   ├── collaboration.js    # Yjs + y-partyserver + awareness
│   │   ├── persistence.js      # Logic to call persistence API
│   │   ├── terminal.js         # Manages WebSocket connection to execution server + frontend xterm.js
│   │   ├── output.js           # HTML output pane (iframe)
│   │   ├── resizer.js          # Draggable divider logic
│   │   ├── modal.js            # Name prompt modal
│   │   └── username.js         # Username validation helpers
│   └── style.css
└── workers/
    ├── collaboration/          # Yjs WebSocket Worker + Durable Object
    ├── persistence/            # Hono REST API + D1
    └── execution/              # Container Worker + in-container Node/PTY server
        └── container/          # Dockerfile, server.js, pty.js
```

The `development` branch shows an `apis/` directory that holds the earlier local prototype (Flask + PostgreSQL, Node + Dockerode). Production traffic now goes through `workers/`.

---

## Local Setup

### Prerequisites

- Node.js 18+
- Docker (required to build and run the execution container locally)
- A Cloudflare account, with Wrangler authenticated (`npx wrangler login`)

Each Worker defaults to port 8787, so run them on different ports. From three terminals:

### 1. Persistence API

See [`workers/persistence/README.md`](workers/persistence/README.md) for D1 creation, schema, secrets, and tests.

```bash
cd workers/persistence
npm install
npx wrangler d1 execute collab-pads --local --file=schema.sql
npm run dev -- --port 8788
```

### 2. Collaboration Worker

See [`workers/collaboration/README.md`](workers/collaboration/README.md).

```bash
cd workers/collaboration
npm install
npx wrangler d1 execute collab-pads --local --file=../persistence/schema.sql
npx wrangler dev --port 8787
```

### 3. Execution Worker

See [`workers/execution/README.md`](workers/execution/README.md).

```bash
cd workers/execution
npm install
cd container && npm install && cd ..
npx wrangler d1 execute collab-pads --local --file=../persistence/schema.sql
npx wrangler dev --port 8789
```

### 4. Frontend

```bash
npm install
```

Create `.env.development` at the project root:

```
VITE_WS_URL=localhost:8787
VITE_PERSISTENCE_API_URL=http://localhost:8788
VITE_EXECUTION_WS_URL=ws://localhost:8789
```

Then:

```bash
npm run dev
```

You can also point the frontend at already-deployed Workers by using their `*.workers.dev` URLs instead of localhost.

### Creating a pad

Pads are not created by visiting `/`. IDs are issued by an authenticated API call so a refresh loop cannot spawn unbounded containers.

```bash
curl -X POST http://localhost:8788/api/pads \
  -H "Authorization: Bearer <your_auth_token>"
```

The response includes a `pad_id`. Open `/pads/<pad_id>` in the Vite dev server.

---

## Deploying

| Piece | Target |
|---|---|
| Frontend | Cloudflare Pages (on Cloudflare portal, command `npm run build`, then deploy `dist/`) |
| Collaboration, persistence, execution | `npx wrangler deploy` from each `workers/` directory |

Set the same `VITE_*` variables in the Pages project to the deployed Worker URLs. Persistence CORS is controlled by `FRONTEND_URL` in `workers/persistence/wrangler.jsonc`.

Pad URLs like `/pads/<id>` do not need a `_redirects` file. Vite does this locally, and Cloudflare Pages does it in production when there is no top-level `404.html`: unknown paths are served as `index.html`, and the client reads the pad ID from the URL. `invalid.html` is a real file in the build, so `/invalid.html` is still its own page.

Pad creation stays auth-gated in production the same way it is locally.
