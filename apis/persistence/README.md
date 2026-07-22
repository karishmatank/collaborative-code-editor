# Persistence API

A REST API for managing collaborative coding pads. It handles pad lifecycle (creation, language selection) and per-language content persistence, backed by a PostgreSQL database.

Built with Flask and psycopg2, this service is designed to be consumed by the collaborative editor frontend.

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
- [Authentication](#authentication)
- [Supported Languages](#supported-languages)
- [Running Tests](#running-tests)

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | [Flask](https://flask.palletsprojects.com/) 3.1 |
| Database | PostgreSQL (via [psycopg2](https://www.psycopg.org/)) |
| ID generation | [shortuuid](https://github.com/skorokithakis/shortuuid) |
| Testing | Python `unittest` |

---

## Local Setup

**Prerequisites:** Python 3.9+, PostgreSQL running locally.

**1. Create and activate a virtual environment**

```bash
python -m venv .venv
source .venv/bin/activate
```

**2. Install dependencies**

```bash
pip install -r requirements.txt
```

**3. Create the databases**

```bash
createdb collab_pads
createdb collab_pads_test
```

**4. Apply the schema**

```bash
psql collab_pads < schema.sql
psql collab_pads_test < schema.sql
```

**5. Configure environment variables**

Create a `.env` file in `apis/persistence/`:

```
AUTH_TOKEN=your_secret_token_here
```

**6. Start the server**

```bash
python app.py
```

The server runs on `http://localhost:5003`.

---

## Database Schema

The service uses two tables:

### `pads`

Stores each collaborative pad and its currently selected language.

| Column | Type | Description |
|---|---|---|
| `id` | `text` (PK) | Short unique identifier for the pad |
| `current_language` | `text` | The active language for the pad session |
| `created_at` | `timestamptz` | Timestamp of pad creation |
| `updated_at` | `timestamptz` | Timestamp of the last update |

### `pad_contents`

Stores the saved content for each pad/language combination. A pad can have content entries for multiple languages independently.

| Column | Type | Description |
|---|---|---|
| `id` | `serial` (PK) | Auto-incrementing row ID |
| `pad_id` | `text` (FK → `pads.id`) | The pad this content belongs to |
| `language` | `text` | The language this content is for |
| `content` | `text` | The saved editor content (nullable) |
| `updated_at` | `timestamptz` | Timestamp of the last content update |

A `UNIQUE (pad_id, language)` constraint ensures at most one content row per pad/language pair. Deleting a pad cascades to its content rows.

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
curl -X POST http://localhost:5003/api/pads \
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
curl http://localhost:5003/api/pads/aB3kR7zQ
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
curl -X PATCH http://localhost:5003/api/pads/aB3kR7zQ \
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
curl http://localhost:5003/api/pads/aB3kR7zQ/content/python
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
curl -X PATCH http://localhost:5003/api/pads/aB3kR7zQ/content/python \
  -H "Content-Type: application/json" \
  -d '{"content": "print(\"hello world\")"}'
```

---

## Authentication

Pad creation requires a bearer token passed in the `Authorization` header:

```
Authorization: Bearer <AUTH_TOKEN>
```

The expected token value is read from the `AUTH_TOKEN` environment variable. Requests with a missing or incorrect token receive a `401 Unauthorized` response.

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

Tests use Python's built-in `unittest` framework and run against a dedicated `collab_pads_test` database (make sure it exists and has the schema applied before running).

From the `apis/persistence/` directory:

```bash
python -m unittest tests.test_app
```

The test suite covers:

- Pad creation, including auth enforcement and duplicate ID collision resistance
- Retrieving and updating pad language, including error cases for nonexistent pads
- Retrieving pad content, including auto-creation of content rows on first access
- Updating pad content, including missing-body and nonexistent pad/language error cases
- Rejection of unsupported HTTP methods

Each test seeds the database in `setUp` and cleans up in `tearDown`, so tests are fully isolated from one another.
