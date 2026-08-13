# The SPOT Editor

A real-time collaborative code editor built for [Launch School](https://launchschool.com/) students to study and work through problems together.

---

## Why

Launch School study sessions previously relied on [Coderpad](https://coderpad.io/). That created two recurring problems: the free-tier limit pushed SPOT moderators to rotate accounts every two weeks to trigger new free trials, and those rotating links had to be manually updated in roughly 40 locations in the shared Gather workspace each time. This SPOT Editor solves both. Pads are persistent, so there is no need to replace links.

---

## Features

### Completed

- **Real-time collaborative editing** — See other users' cursors and edits live, with conflict resolution handled by a CRDT
- **User presence** — Colored name pills in the header; hover a remote cursor to see whose it is
- **Multi-language support** — Python, JavaScript, TypeScript, Ruby, SQL, and HTML
- **Interactive REPL** — An xterm.js terminal per pad backed by a Docker-isolated container; all users share the same session output in real time, and late-joining users receive prior output on connect
- **Run / Stop / Reset controls** — Run editor code in a sandboxed one-off exec, stop a long-running execution mid-run, or reset the terminal and restart the REPL
- **HTML live preview** — Edits render immediately in a sandboxed `<iframe>`; the Run button is automatically disabled for HTML
- **Persistent pads** — Content and language selection are saved per pad per language and restored on the next visit
- **Resizable panes** — Drag the divider to adjust the editor/output split; layout switches to top/bottom stacking below 900 px viewport width
- **In-editor name editing** — Click the pencil icon next to your name pill to update your display name without leaving the pad
- **Invalid pad handling** — Visiting an unknown pad ID redirects to an error page

### Planned (v2)

- Basic IntelliSense for Python, Ruby, and SQL via language server integration
- Multi-file HTML environment (à la Coderpad's Vite mode)
- Production deployment

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend build | [Vite](https://vitejs.dev/) |
| Editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Collaboration / CRDT | [Yjs](https://yjs.dev/) + [y-websocket](https://github.com/yjs/y-websocket) + [y-monaco](https://github.com/yjs/y-monaco) |
| Collaboration WebSocket server (dev) | `y-websocket` local server |
| Terminal (frontend) | [xterm.js](https://xtermjs.org/) |
| Execution WebSocket server | Node.js + [ws](https://github.com/websockets/ws) |
| Container management | [Dockerode](https://github.com/apocas/dockerode) |
| Code isolation | Docker containers |
| Persistence API | [Flask](https://flask.palletsprojects.com/) + [psycopg2](https://www.psycopg.org/) |
| Database | PostgreSQL |
| Pad ID generation | [shortuuid](https://github.com/skorokithakis/shortuuid) |

---

## Project Structure

```
collaborative-code-editor/
├── index.html                  # App shell + name modal
├── invalid.html                # Shown when a pad ID is not found
├── src/
│   ├── js/
│   │   ├── main.js             # Entry point — wires all modules together
│   │   ├── editor.js           # Monaco editor + per-language model management
│   │   ├── collaboration.js    # Yjs + y-websocket + awareness (ConnectionManager)
│   │   ├── persistence.js      # Thin REST client for the persistence API
│   │   ├── terminal.js         # xterm.js terminal + CodeExecutionManager
│   │   ├── output.js           # HTML output pane (iframe)
│   │   ├── resizer.js          # Draggable divider logic
│   │   ├── modal.js            # Name prompt modal
│   │   └── username.js         # Username validation helpers
│   └── style.css
└── apis/
    ├── persistence/            # Flask REST API — pad lifecycle and content storage
    │   ├── app.py
    │   ├── database.py
    │   ├── decorators.py
    │   ├── schema.sql
    │   ├── requirements.txt
    │   └── tests/
    └── execution/              # Node.js execution server — Docker containers + REPL
        ├── websocket.js        # ReplServer + PadSession — WebSocket server and session management
        ├── docker.js           # DockerManager — container and PTY lifecycle
        ├── Dockerfile          # Ubuntu image with all language runtimes pre-installed
        └── package.json
```

---

## Local Setup

### Prerequisites

- Node.js 18+
- Python 3.9+
- PostgreSQL running locally
- Docker running locally

### Frontend

```bash
npm install
```

Create a `.env` file at the project root with:
- VITE_WS_URL = The URL of the Yjs WebSocket server (ex: ws://localhost:1234)
- VITE_PERSISTENCE_API_URL = The URL of the persistence API (ex: http://localhost:5003)
- VITE_EXECUTION_WS_URL = The URL of the code execution WebSocket server (ex: ws://localhost:8000)


Start the Vite dev server and the y-websocket server:

```bash
npm run dev
HOST=localhost PORT=1234 npx y-websocket
```

### Persistence API

See [`apis/persistence/README.md`](apis/persistence/README.md) for full setup instructions, including database creation, schema migration, and environment configuration.

### Execution Server

Build the Docker image (required once, or after any change to the Dockerfile):

```bash
docker build -t spot-editor:latest apis/execution/
```

Install dependencies and start the server:

```bash
cd apis/execution
npm install
WS_PORT=8080 node websocket.js (or node --env-file=.env node websocket.js if port info in an .env)
```

### Creating a pad

Once all servers are running, create a pad via the API:

```bash
curl -X POST http://localhost:5003/api/pads \
  -H "Authorization: Bearer <your_auth_token>"
```

The response will include a `pad_id`. Navigate to `/pads/<pad_id>` to open the pad.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed breakdown of the system design and the reasoning behind key decisions.
