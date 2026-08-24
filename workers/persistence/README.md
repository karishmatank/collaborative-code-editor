# Persistence API

A REST API for managing collaborative coding pads. It handles pad lifecycle (creation, language selection) and per-language content persistence, backed by a Cloudflare D1 database.

Built with Hono and deployed as a Cloudflare Worker, this service is designed to be consumed by the collaborative editor frontend. Sibling Workers: [collaboration](../collaboration/README.md), [execution](../execution/README.md).

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Local Setup](#local-setup)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
  - [Create a Pad](#create-a-pad)
  - [Get Pad Language](#get-pad-language)
  - [Update Pad Language](#update-pad-language)
  - [Get Pad Content](#get-pad-content)
  - [Update Pad Content](#update-pad-content)
  - [Get or Create Generation ID](#get-or-create-generation-id)
  - [Clear Generation ID](#clear-generation-id)
- [Authentication](#authentication)
- [Supported Languages](#supported-languages)
- [Running Tests](#running-tests)

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com/) |
| Framework | [Hono](https://hono.dev/) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ID generation | [nanoid](https://github.com/ai/nanoid) |
| Testing | [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers) |

---

## Local Setup

**Prerequisites:** Node.js, a [Cloudflare account](https://dash.cloudflare.com/sign-up) with Wrangler authenticated (`npx wrangler login`).

**1. Install dependencies**

```bash
npm install
```

**2. Create the D1 database**

```bash
npx wrangler d1 create collab-pads
```

Copy the `database_id` from the output into `wrangler.jsonc` under `d1_databases`.

**3. Apply the schema**

```bash
npx wrangler d1 execute collab-pads --local --file=schema.sql
```

**4. Configure secrets**

Create a `.dev.vars` file in `workers/persistence/`:

```
AUTH_TOKEN=your_secret_token_here
```

**5. Start the dev server**

```bash
npm run dev
```

The server runs on `http://localhost:8787`.

---

## Deploying

**1. Apply the schema to the remote database**

```bash
npx wrangler d1 execute collab-pads --remote --file=schema.sql
```

**2. Set the auth token secret**

```bash
npx wrangler secret put AUTH_TOKEN
```

**3. Deploy**

```bash
npm run deploy
```

---

## Database Schema

The service uses two tables, stored in a Cloudflare D1 (SQLite) database.

### `pads`

Stores each collaborative pad and its currently selected language.

| Column | Type | Description |
|---|---|---|
| `id` | `text` (PK) | Short unique identifier for the pad |
| `current_language` | `text` | The active language for the pad session |
| `generation` | `text` | Live session ID shared by the collaboration and execution Workers; `NULL` when no group is in the pad |
| `join_count` | `integer` | Incremented on each collaboration connect |
| `created_at` | `text` | UTC timestamp of pad creation |
| `updated_at` | `text` | UTC timestamp of the last update |

### `pad_contents`

Stores the saved content for each pad/language combination. A pad can have content entries for multiple languages independently.

| Column | Type | Description |
|---|---|---|
| `id` | `integer` (PK) | Auto-incrementing row ID |
| `pad_id` | `text` (FK → `pads.id`) | The pad this content belongs to |
| `language` | `text` | The language this content is for |
| `content` | `text` | The saved editor content (nullable) |
| `updated_at` | `text` | UTC timestamp of the last content update |

A `UNIQUE (pad_id, language)` constraint ensures at most one content row per pad/language pair. Deleting a pad cascades to its content rows.

`generation` is the live session key used by the collaboration and execution Workers so a new group of students gets a new Durable Object (and Container) placed near them, rather than reusing the object created the first time the pad was ever opened, as that object may physically be in a disadvantageous location. The collaboration and execution Workers currently read and write this column on D1 directly; the HTTP endpoints below exist on this Worker as well.

---

## API Reference

All responses use `Content-Type: application/json`. Error responses follow the shape:

```json
{ "error": "Description of the error" }
```

---

### Create a Pad

Creates a new pad with a randomly generated ID and a default language of `python`.

```
POST /api/pads
```

**Auth required:** Yes — see [Authentication](#authentication).

**Request body:** None

**Responses**

| Status | Body | Description |
|---|---|---|
| `201 Created` | `{'pad_id': 'ABC123'}` | Pad successfully created |
| `401 Unauthorized` | `{'error': 'Not authorized'}` | Missing or invalid auth token |

**Example**

```bash
curl -X POST https://persistence.<your-account>.workers.dev/api/pads \
  -H "Authorization: Bearer your_secret_token_here"
```

---

### Get Pad Language

Returns the currently active language for a given pad.

```
GET /api/pads/<pad_id>
```

**Auth required:** No

**Path parameters**

| Parameter | Type | Description |
|---|---|---|
| `pad_id` | string | The pad's unique ID |

**Responses**

| Status | Body | Description |
|---|---|---|
| `200 OK` | `{ "language": "python" }` | The pad's current language |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |

**Example**

```bash
curl https://persistence.<your-account>.workers.dev/api/pads/aB3kR7zQ
```

```json
{ "language": "python" }
```

---

### Update Pad Language

Updates the active language for a given pad.

```
PATCH /api/pads/<pad_id>
```

**Auth required:** No

**Path parameters**

| Parameter | Type | Description |
|---|---|---|
| `pad_id` | string | The pad's unique ID |

**Request body**

```json
{ "language": "javascript" }
```

**Responses**

| Status | Body | Description |
|---|---|---|
| `204 No Content` | — | Language successfully updated |
| `400 Bad Request` | `{ "error": "Missing language" }` | Request body is missing the `language` field |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |

**Example**

```bash
curl -X PATCH https://persistence.<your-account>.workers.dev/api/pads/aB3kR7zQ \
  -H "Content-Type: application/json" \
  -d '{"language": "javascript"}'
```

---

### Get Pad Content

Returns the saved content for a specific pad and language. If no content entry exists yet for this pad/language combination, one is created and an empty string is returned.

```
GET /api/pads/<pad_id>/content/<language>
```

**Auth required:** No

**Path parameters**

| Parameter | Type | Description |
|---|---|---|
| `pad_id` | string | The pad's unique ID |
| `language` | string | One of the [supported languages](#supported-languages) |

**Responses**

| Status | Body | Description |
|---|---|---|
| `200 OK` | `{ "content": "print(\"hello world\")" }` | The saved content (empty string if none yet) |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |
| `404 Not Found` | `{ "error": "Pad language is invalid" }` | The language is not supported |

**Example**

```bash
curl https://persistence.<your-account>.workers.dev/api/pads/aB3kR7zQ/content/python
```

```json
{ "content": "print(\"hello world\")" }
```

---

### Update Pad Content

Saves new content for a specific pad and language.

```
PATCH /api/pads/<pad_id>/content/<language>
```

**Auth required:** No

**Path parameters**

| Parameter | Type | Description |
|---|---|---|
| `pad_id` | string | The pad's unique ID |
| `language` | string | One of the [supported languages](#supported-languages) |

**Request body**

```json
{ "content": "print(\"hello world\")" }
```

Note: `content` may be an empty string, but the field must be present in the request body.

**Responses**

| Status | Body | Description |
|---|---|---|
| `204 No Content` | — | Content successfully updated |
| `400 Bad Request` | `{ "error": "Missing content" }` | Request body is missing the `content` field |
| `400 Bad Request` | `{ "error": "Pad language combo does not exist" }` | No prior content entry for this pad/language pair |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |
| `404 Not Found` | `{ "error": "Pad language is invalid" }` | The language is not supported |

**Example**

```bash
curl -X PATCH https://persistence.<your-account>.workers.dev/api/pads/aB3kR7zQ/content/python \
  -H "Content-Type: application/json" \
  -d '{"content": "print(\"hello world\")"}'
```

---

### Get or Create Generation ID

Returns the live generation ID for a pad, creating one if the pad has none. The `UPDATE … WHERE generation IS NULL` write is what prevents two simultaneous first joiners from minting two IDs.

```
GET /api/pads/<pad_id>/generation
```

**Auth required:** No

**Responses**

| Status | Body | Description |
|---|---|---|
| `200 OK` | `{ "generationId": "…" }` | Current or newly created generation ID |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |

The collaboration and execution Workers currently perform this same SQL against D1 themselves rather than calling this route.

---

### Clear Generation ID

Sets `generation` back to `NULL` so the next group to open the pad gets a new Durable Object / Container.

```
DELETE /api/pads/<pad_id>/generation
```

**Auth required:** No

**Responses**

| Status | Body | Description |
|---|---|---|
| `204 No Content` | — | Generation cleared |
| `404 Not Found` | `{ "error": "Pad not found" }` | No pad exists with this ID |

---

## Authentication

Pad creation requires a bearer token passed in the `Authorization` header:

```
Authorization: Bearer <AUTH_TOKEN>
```

The expected token value is stored as a Wrangler secret (`AUTH_TOKEN`). Requests with a missing or incorrect token receive a `401 Unauthorized` response.

For local development, set `AUTH_TOKEN` in a `.dev.vars` file. For production, use `npx wrangler secret put AUTH_TOKEN`.

---

## Supported Languages

The API enforces a fixed set of supported languages for both pad language selection and content storage:

- `python`
- `javascript`
- `typescript`
- `ruby`
- `sql`
- `html`

Requests using any other language value will receive a `404` response.

---

## Running Tests

Tests use Vitest with the `@cloudflare/vitest-pool-workers` runner, which executes tests inside a real Workers runtime with an in-memory D1 database — no external database setup required.

From the `workers/persistence/` directory:

```bash
npm test
```

To run once without watch mode:

```bash
npm test -- --run
```

The test suite covers:

- Pad creation, including auth enforcement
- Retrieving and updating pad language, including error cases for nonexistent pads
- Retrieving pad content, including auto-creation of content rows on first access
- Updating pad content, including missing-body and nonexistent pad/language error cases
- Rejection of unsupported languages

Each test runs in an isolated Worker context with a fresh D1 instance, so tests are fully independent from one another.
