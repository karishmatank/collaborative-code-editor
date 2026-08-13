# Architecture

This document describes the system design of The SPOT Editor, the reasoning behind key technology choices, and the tradeoffs considered along the way.

---

## Table of Contents

- [System Overview](#system-overview)
- [Component Breakdown](#component-breakdown)
  - [Frontend](#frontend)
  - [Collaboration Layer](#collaboration-layer)
  - [Persistence Layer](#persistence-layer)
  - [Code Execution Layer](#code-execution-layer)
- [Data Model](#data-model)
- [Key Design Decisions](#key-design-decisions)
- [v2 Roadmap](#v2-roadmap)

---

## System Overview

```
  +-----------+         WebSocket            +-------------------+
  |  Browser  |<---------------------------->|    Yjs server     |
  |           |                              |     (editor)      |
  +-----------+                              +-------------------+
    |     ^    \
HTTP       HTTP  \
req        resp    \     WebSocket
    v     |          \
  +-------------+      \  +-- Code execution server -----------------------------------------+
  | Persistence |         |                                   Containers                     |
  |     API     |         |  +------------------------+       +-------+                      |
  +-------------+         |  |                        |<----->|   1   |                      |
      |                   |  |    WebSocket server    |       +-------+                      |
      v                   |  |                        |       +-------+                      |
  +-------------+         |  |  (routes to container  |<----->|   2   |                      |
  | PostgreSQL  |         |  |       by pad ID)       |       +-------+                      |
  |             |         |  |                        |          ...                         |
  +-------------+         |  |                        |                                      |
                          |  +------------------------+                                      |
                          |                                                                  |
                          +------------------------------------------------------------------+
                                                               /  /
                                                              /  /
                                                   paired with  /
                                                            /  /
                                                           v  v
                          +-- Inside the container ------------------------------------------+
                          |                                                                  |
                          |             ^ Input / output from                                |
                          |             | WebSocket connection                               |
                          |             |                                                    |
                          |             v                                                    |
                          |   +------------------+      +------------------------+           |
                          |   |                  |      |          REPL          |           |
                          |   |  Pseudoterminal  |<----->     (python, node,     |           |
                          |   |                  |      |       irb, psql)       |           |
                          |   +------------------+      +------------------------+           |
                          |                                                                  |
                          +------------------------------------------------------------------+

```

- **Inside the browser, Monaco is bound to Yjs via `MonacoBinding`** (from the y-monaco package), not via a network call. Editor keystrokes flow Monaco → `Y.Text` → y-websocket → server. The Yjs document also carries a `Y.Map` that syncs the shared language selection across all users- when one user changes the language dropdown, the change propagates to all others through this map.
- **The browser-side terminal is xterm.js.** It connects to the execution WebSocket server and renders raw terminal output, including ANSI color codes and interactive prompts.
- **Locally, the Yjs server is the built-in `y-websocket` server.** In production, it will be replaced by Cloudflare Workers + Durable Objects- one Durable Object per pad, providing in-memory Yjs state and a globally distributed entry point for low-latency connections.


---

## Component Breakdown

### Frontend

**Built with:** Vite + vanilla JavaScript  
**Entry point:** `index.html` → `src/js/main.js`

`main.js` acts as the orchestrator: it initializes each module, wires together event listeners, and coordinates the sequence of async operations that need to happen in a specific order (e.g., waiting for the name modal before initializing Monaco, waiting for the WebSocket sync before loading persisted content).

The frontend is not a single-page application in the routing sense. It uses static hosting with client-side rendering: Cloudflare Pages (or a similar CDN) will serve the same `index.html` for every pad URL, and the JavaScript reads the pad ID from `window.location.pathname` to determine which room to connect to.

Key modules:

| Module | Responsibility |
|---|---|
| `editor.js` | Creates the Monaco editor instance and manages per-language models |
| `collaboration.js` | Owns the `Y.Doc`, `WebsocketProvider`, awareness, and MonacoBinding lifecycle |
| `persistence.js` | Thin REST client- `GET`/`PATCH` calls to the persistence API |
| `output.js` | Output pane state machine (empty → loading → populated) |
| `resizer.js` | Draggable divider, flex-basis math, 150 px minimum pane width enforcement |
| `modal.js` | Name prompt modal, shown on first visit per browser |
| `username.js` | Validation helpers shared by the modal and inline name editing |
| `terminal.js` | Owns the xterm UI setup and interactions with the code execution server |

**Monaco web workers**

Monaco offloads syntax analysis, IntelliSense computation for JS and TS only (for now), and formatting to background threads (web workers) so that typing stays responsive. The `MonacoEnvironment.getWorker` configuration in `editor.js` tells Monaco which worker file to spin up per language- a TypeScript/JavaScript worker, an HTML worker, or the generic editor worker.

---

### Collaboration Layer

**Built with:** Yjs, y-websocket, y-monaco  
**Core class:** `ConnectionManager` in `collaboration.js`

Each user's browser instantiates a single `Y.Doc`. This document contains:

- **One `Y.Text` per language** (e.g., `monaco-python`, `monaco-javascript`). Each `Y.Text` is bound to Monaco via `MonacoBinding`, which keeps the editor and the CRDT document in sync bidirectionally. A separate model is used per language in Monaco so that switching languages swaps the active model rather than clearing and re-inserting content.

- **One shared `Y.Map`** that carries one key:
  - `language`- the currently selected language. Synced so that when one user changes the language, all other users' dropdowns and editors update automatically.

**Awareness** (provided by `y-websocket`) carries ephemeral per-user state that does not need to be conflict-resolved: each user's display name and assigned cursor color. When a user joins or leaves, or edits their name, awareness propagates the change to all connected clients.

---

### Persistence Layer

**Built with:** Flask, psycopg2, PostgreSQL  
**Location:** `apis/persistence/`

A lightweight REST API with five endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/pads` | Create a new pad (auth-gated) |
| `GET` | `/api/pads/<pad_id>` | Get the pad's current language |
| `PATCH` | `/api/pads/<pad_id>` | Update the pad's current language |
| `GET` | `/api/pads/<pad_id>/content/<language>` | Get saved content for a pad/language pair |
| `PATCH` | `/api/pads/<pad_id>/content/<language>` | Save content for a pad/language pair |

The API is designed to be stateless and thin- it does not know about Yjs, rooms, or users. Its only job is durable storage.

See [`apis/persistence/README.md`](apis/persistence/README.md) for the full API reference, schema, and local setup instructions.

---

### Code Execution Layer

**Built with:** Node.js, ws, Dockerode, Docker  
**Location:** `apis/execution/`  
**Frontend module:** `src/js/terminal.js` (xterm.js)

The execution layer is a separate Node.js WebSocket server, independent of the y-websocket collaboration server. Each browser client opens a second WebSocket connection to this server on page load, passing `padId` and `language` as query parameters.

#### Session model

The server maintains a `sessions` map keyed by `padId`. Each entry is a `PadSession` object that owns:

- A Docker container (one per active pad, long-lived for the duration of the session)
- A pseudoterminal (PTY) stream connected to the active language runtime inside the container
- A set of connected WebSocket clients for the pad
- A running log of terminal output (so late-joining users receive the full prior output on connect)
- An optional `runStream`- the stream for a currently-executing one-off editor run

The container is started once when the first user joins the pad. It stays alive as long as at least one user is in the pad, and is killed and removed when the last user disconnects.

#### The REPL (interactive terminal)

For non-HTML languages, the server creates a PTY process inside the container via Docker's exec API with `Tty: true`. The exec command is the language's REPL binary (`python3`, `node`, `irb`, `ts-node`, or `psql`). The PTY makes the REPL behave as if connected to a real terminal- line-buffered output and correct interactive prompts.

The frontend terminal is powered by xterm.js with the `FitAddon`. User keystrokes are sent to the server as `{ type: 'input', data: ... }` messages and forwarded directly to the PTY stream. Output from the PTY is broadcast to all connected clients in the same pad. Because the REPL echoes input back through the PTY, all users see what is being typed without any separate broadcast of input characters.

#### Running editor code

The Run button does not pipe code through the PTY. `DockerManager.oneOffExecuteCode` creates a separate Docker exec on the same container with `Tty: false`, which returns a Docker multiplexed stream with 8-byte frame headers interleaving stdout and stderr. The server parses each frame header, extracts the payload, converts `\n` to `\r\n` for xterm.js compatibility, and broadcasts the output incrementally as it arrives.

Two safety limits apply per run:
- **Timeout:** 15 seconds. If the run stream is still open after 15 s, it is destroyed and a "timed out" message is appended.
- **Output cap:** 512 KB of incremental output. If a single run produces more than this, the stream is destroyed and an "output too long" message is appended.

REPL output is suppressed for the duration of the editor run to prevent the PTY's async echo from interleaving with the pre-run message and the one-off output.

#### Language switching

When the language dropdown changes, the frontend sends `{ type: 'languageChange', language: ... }` to the execution server. The server kills the current PTY process, starts a new one for the new language in the same container, and clears the output log. For HTML, no PTY process is started- the execution server is idle while HTML is selected.

#### SQL

PostgreSQL is not running by default in the container. On the first PTY process creation for SQL, the server runs a sequence of one-off execs as the `postgres` user: `pg_ctlcluster 18 main start`, then polls `pg_isready` until the server accepts connections, then creates a fresh `studentdb` database owned by a `student` user. The PTY process then runs `psql -U student studentdb`. On subsequent language switches back to SQL within the same session, the server skips Postgres startup (tracked by `postgresInitialized` on the `PadSession`) and restarts only the PTY process.

#### Security model

Each container is created with:

| Constraint | Setting |
|---|---|
| User | `sandbox` (non-root, standard Unix permissions only) |
| Network | Disabled (`NetworkDisabled: true`) |
| Memory | 256 MB |
| CPU | 0.5 cores |
| PID limit | 50 (prevents fork-bomb attacks) |
| Linux capabilities | All dropped (`CapDrop: ['ALL']`) |
| Seccomp | Docker's default profile (blocks dangerous syscalls) |

gVisor (an additional syscall intercept layer that prevents container-escape vulnerabilities) is planned for production.

---

## Data Model

Two tables in PostgreSQL:

### `pads`

Stores each pad and its currently active language.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` (PK) | 8-character shortuuid |
| `current_language` | `text` | Constrained to the six supported languages |
| `created_at` | `timestamptz` | Set on insert |
| `updated_at` | `timestamptz` | Updated on language change |

### `pad_contents`

Stores the saved editor content per pad/language combination.

| Column | Type | Notes |
|---|---|---|
| `id` | `serial` (PK) | Surrogate key |
| `pad_id` | `text` (FK → `pads.id`) | Cascading delete |
| `language` | `text` | Constrained to the six supported languages |
| `content` | `text` | Nullable- no content yet for this language |
| `updated_at` | `timestamptz` | Updated on each save |

A `UNIQUE (pad_id, language)` constraint ensures at most one content row per pad/language pair. A row is created on first access (when a user visits a language for the first time in a given pad), not at pad creation time, so the table stays sparse.

The relationship is one-to-many: one pad can have up to six content rows (one per language), but each content row belongs to exactly one pad.

---

## Key Design Decisions

### Monaco Editor

**Chosen over:** CodeMirror

Monaco was chosen primarily because it matches a format that students may already be familiar with through VS Code and ships with first-class IntelliSense for JavaScript and TypeScript out of the box. Having some completion and inline type information already available without additional setup is a nice advantage. If we want to add in IntelliSense support for other languages in the future, we can do so in the future.

The tradeoff is bundle size. Monaco is large. Vite's worker configuration and code splitting mitigate this somewhat, but it's a real cost compared to CodeMirror. For a tool that will run in a dedicated browser tab rather than embedded in a page, the bundle size tradeoff was deemed acceptable.

---

### CRDTs and Yjs

**The problem:** When two users type at the same position simultaneously, their local documents diverge. A system needs a principled way to merge those divergent states into a single consistent document, without either user's changes being silently discarded.

**Two main approaches exist:**

- **Operational Transformation (OT)**- Used by Google Docs. Each edit is represented as an operation, and operations are transformed against each other when they arrive out of order. OT requires a central server to impose a total order on all operations and to perform the transformations.

- **CRDTs (Conflict-free Replicated Data Types)**- Used by Yjs, Automerge, and others. The data structure is designed so that any two replicas can merge their states and arrive at the same result, regardless of the order operations arrived. No central server required for the merge logic itself.

Yjs was chosen because:
1. It provides a mature, well-tested CRDT implementation without requiring us to implement our own
2. It integrates directly with Monaco via `y-monaco`
3. Its `y-websocket` provider handles reconnection, offline queuing, and state sync automatically
4. Awareness (ephemeral user state like cursor position and name/color) is built in

**How Yjs resolves conflicts internally (YATA algorithm):**

Yjs represents a document as a doubly-linked list of individual characters/items. Rather than tracking absolute positions (which shift as the document changes), each item stores its unique ID (client ID + logical clock) and its left and right "origin" neighbors at the time of insertion. Conflict resolution when two items are inserted at the same position is deterministic and based on client ID, so all peers arrive at the same result without coordination. Deleted items become "tombstones"- they remain in the linked list but don't render, preserving the relative positions of surrounding items until it's safe to garbage-collect them.

---

### Yjs Document Structure

I opted for per-language Y.Text models in addition to a using a Y.Map for shared language state.

The pad supports six languages. When a user switches from Python to JavaScript, we don't want to wipe the Python code- it should be preserved so the user can switch back and find it intact. In addition, the currently selected language needs to sync across all users but doesn't require CRDT conflict resolution in the text-editing sense.

The solution is to create a separate `Y.Text` per language inside the single `Y.Doc`, keyed as `monaco-<language>` (e.g., `monaco-python`, `monaco-javascript`). Monaco also uses a separate model per language (`monaco.editor.createModel`), and a new `MonacoBinding` is created once per language to bind that language's `Y.Text` to its Monaco model. I then used a `Y.Map` to send language updates when any user changes the language dropdown in order to swap the active editor.

This approach lets content for each language live independently in the same synchronized document, without any coordination overhead between languages.

---

### Debounce-Based Content Saving

The persistence API is called to save editor content on three occasions:

1. When the last user leaves a pad (via `beforeunload`)
2. When any user changes the language (save the current language's content before switching)
3. While a user is actively editing (debounced)

For the editing case, a naive approach of saving on every keystroke would hammer the database. A periodic interval approach (e.g., every 5 minutes) risks losing several minutes of work if a browser crashes.

The chosen approach: start a 3-second debounce timer on each local edit. If the user keeps typing, the timer resets. If no edit arrives within 3 seconds, write to the database. This means at most one write per 3 seconds of inactivity, and at most 3 seconds of edits are at risk in the event of a crash.

Importantly, remote edits (changes arriving from other users via Yjs) do not trigger the debounce timer. The `transaction.local` property on a Yjs update event distinguishes local from remote changes. Only the user who made the edit triggers the save. Otherwise, every connected user would fire a redundant write for the same content.

---

### Detecting the First User in a Room

Whether the current user is the first to join a pad determines a critical initialization path: the first user needs to load persisted language and content from the database and set them in the Yjs document; subsequent users should receive that state from Yjs directly (it syncs automatically once the WebSocket connects).

The check is `collabController.users.length <= 1` after the WebSocket sync event fires. The sync event signals that the client has received the full document state from the server. At that point, awareness data for any existing users is also available, so the user count is reliable.

However, this creates a dependency ordering problem: to initialize the `ConnectionManager` (which opens the WebSocket), we need to know the initial language to configure the editor. However, we can't know whether we're the first user until after the WebSocket syncs. To break the cycle, every user makes the cheap API call to fetch the pad's current language before initializing the WebSocket, which resolves the initial editor language regardless of room membership. Only the first user then actually uses that language to set `Y.Map['language']` and load persisted content; all other users receive the language from Yjs.

---

### PostgreSQL for Persistence

The persistence layer uses PostgreSQL rather than a document store (e.g., DynamoDB, Firestore) for two reasons:

1. **Structured, relational data.** The schema is fixed and predictable: pads have a known set of columns; content rows have a foreign key to a pad. SQL's join semantics and constraint enforcement (the `UNIQUE (pad_id, language)` constraint, for example) express these relationships naturally.

2. **Pad content is a string, not a document.** There's no need for nested JSON, flexible schema, or document-level queries. The content field is just `text`.

---

### Two WebSocket Connections

The editor collaboration layer (Yjs + y-websocket) and the execution layer are intentionally separate WebSocket connections to separate servers.

A single connection might seem simpler, but the two layers have fundamentally different requirements. Yjs needs a transport that can relay opaque binary update packets and awareness messages; y-websocket is purpose-built for this. The execution server needs to relay raw terminal I/O, manage Docker containers, and handle per-pad session state, none of which belongs inside a Yjs provider.

Keeping them separate also means the execution server can be restarted or scaled independently without disrupting editor synchronization, and each server stays focused on one responsibility.

---

### Secure Code Execution

In order to securely run user-submitted code, the key question is where and how to isolate it. Three approaches were considered:

1. **Run the code client-side** - Using WebAssembly (WASM), language runtimes can be compiled and run directly in the browser, eliminating server-side risk from malicious code and reducing latency. However, WASM support is incomplete for our set of languages (ex: SQL has no viable WASM path), it puts execution load on the user's device rather than a controlled server, and each language addition requires a separate WASM compilation effort. Not viable given the language requirements.

2. **Use Docker containers** - A Docker container packages everything needed to run an application, such as code, runtimes, libraries, into an isolated environment. Each pad gets its own container, started when the first user joins and destroyed when the last leaves. Docker containers share the host kernel, which is the primary security limitation- if malicious code exploits a kernel vulnerability, it could escape the container and affect the host or other containers.

3. **Use microVMs** - Lightweight virtual machines like AWS Firecracker give each isolated environment its own kernel rather than sharing the host's. This means that even if malicious code exploits a kernel vulnerability, it can only affect its own VM's kernel. The tradeoffs are significant operational complexity (more infrastructure knowledge required to provision and manage), longer startup times compared to containers, and higher per-instance resource overhead.

I decided to go with Docker containers in the end, with the hardening measures described in the [Code Execution Layer](#code-execution-layer) section. For a study tool running student exercises, this level of isolation is sufficient.

---

### One Long-Lived Container Per Pad

When the first user joins a pad, the server starts a single Docker container. That container stays alive for the entire session and is shared by all users in the pad. When the last user leaves, the container is killed and removed.

The alternative of creating a new container each time the language switches was rejected because container startup takes hundreds of milliseconds to a few seconds, which would produce a noticeable delay on every language change. With a long-lived container, all language runtimes are already installed and language switching only requires killing the existing PTY process and starting a new one in the same container, which is near-instantaneous.

A single container image (`spot-editor:latest`) installs all supported runtimes (Python, Ruby, Node.js, TypeScript via ts-node, and PostgreSQL) so the container is ready for any language from the moment it starts.

---

### Pseudoterminal via Docker Exec

Interactive REPLs (python, node, irb, etc.) behave differently depending on whether their stdin is connected to a real terminal or a plain pipe. When connected to a pipe, most REPLs switch to block-buffered mode: they hold output in a buffer until it fills up (typically 4–8 KB) before flushing. This means output would arrive in large, delayed batches rather than line by line, which is clearly an unusable interactive experience.

The solution is a pseudoterminal (PTY): a kernel facility that mimics a real terminal. When a process's stdin/stdout are connected to a PTY, the process believes it is talking to a terminal and switches to line-buffered, interactive mode. Docker's exec API exposes PTY support via `Tty: true`, which hijacks the HTTP connection and converts it into a raw bidirectional TCP stream between the server and the REPL process inside the container.

Two other approaches were also considered:

- **Language-specific in-process runtimes** - Node.js has a built-in `repl` module, and bridge libraries (e.g., pythonia) can call Python from Node. This avoids the terminal complexity entirely. The problem is scalability: each language requires a different bridge, and bridge libraries for non-JS languages don't provide a true interactive REPL experience - they just execute code and return output, rather than maintaining a stateful interpreter session. SQL in particular has no viable bridge path.
- **Batch execution APIs (e.g., Judge0)** - Send code to an external API, get the output back. Simple, but fundamentally one-shot: there is no persistent process to type into interactively, which rules out the REPL use case entirely.

---

### One-Off Exec for Editor Runs

When a user clicks Run, the editor code is not fed into the PTY. Instead, the server creates a second Docker exec on the same container with `Tty: false`, passing the code as a command-line argument (`python3 -c <code>`, `node -e <code>`, etc.). This produces a one-shot, non-interactive process whose output is a Docker multiplexed stream, consisting of stdout and stderr interleaved with 8-byte frame headers identifying which stream each chunk belongs to.

The reason for this separation: multiline code sent character by character into a PTY (where each keystroke is echoed back) would produce garbled, unpredictable output. A one-off exec runs the full code block atomically and streams clean output.

The server parses the multiplexed stream frame by frame rather than stripping a fixed 8-byte prefix, because a single TCP data event can carry multiple frames. Parsing the entire buffer in a loop ensures every frame's payload is extracted correctly.

---

## v2 Roadmap

| Feature | Notes |
|---|---|
| IntelliSense for Python / Ruby / SQL | Monaco ships with JS/TS IntelliSense but not for other languages. Requires integrating language servers (e.g., Pyright for Python) via `monaco-languageclient`, ideally running in the browser via WebAssembly to avoid a separate backend process. |
| Multi-file HTML environment | A Vite-powered project directory per pad for the HTML language option, matching Coderpad's current behavior. Significantly more complex than the single-file approach currently used. |
| Production deployment | Cloudflare Pages for static assets, Cloudflare Workers + Durable Objects for the collaboration WebSocket, AWS (API Gateway + Lambda + RDS) for persistence, Docker + gVisor for the execution server. |
