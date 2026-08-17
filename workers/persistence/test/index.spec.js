import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Persistence API", () => {
  beforeEach(async () => {
    await env.collab_pads.exec(
      `CREATE TABLE IF NOT EXISTS pads (
        id text PRIMARY KEY,
        current_language text NOT NULL CHECK (current_language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')) DEFAULT 'python',
        created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`.replace(/\s+/g, ' ').trim()
    );
    await env.collab_pads.exec(
      `CREATE TABLE IF NOT EXISTS pad_contents (
        id integer PRIMARY KEY,
        pad_id text NOT NULL,
        content text,
        language text NOT NULL CHECK (language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')),
        updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (pad_id, language)
      );`.replace(/\s+/g, ' ').trim()
    );
    // Seed data
    await env.collab_pads.prepare("INSERT INTO pads (id) VALUES (?)").bind('1').run();
    await env.collab_pads.prepare("INSERT INTO pad_contents (pad_id, language) VALUES (?, ?)").bind('1', 'python').run();
  });

  // Because Cloudflare Workers Vitest integration gives each test its own
  // isolated Worker context with a fresh D1, we don't actually need afterEach here
  // afterEach(async () => {
  //   await env.collab_pads.prepare("DELETE FROM pad_contents").run();
  //   await env.collab_pads.prepare("DELETE FROM pads").run();
  // });

  it("creates a pad successfully", async () => {
    const before = await env.collab_pads.prepare("SELECT count(id) as count FROM pads").first();
    expect(before.count).toBe(1);

    const response = await SELF.fetch("http://example.com/api/pads", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.AUTH_TOKEN}` }
    });
    expect(response.status).toBe(201);

    const after = await env.collab_pads.prepare("SELECT count(id) as count FROM pads").first();
    expect(after.count).toBe(2);
  });

  it("rejects pad creation without auth token", async () => {
    const response = await SELF.fetch("http://example.com/api/pads", {
      method: "POST"
    });
    expect(response.status).toBe(401);

    const count = await env.collab_pads.prepare("SELECT count(id) as count FROM pads").first();
    expect(count.count).toBe(1);
  });

  // Note: Hono returns 404 for unmatched routes (including wrong HTTP method), not 405
  it("rejects incorrect request type on /api/pads", async () => {
    const response = await SELF.fetch("http://example.com/api/pads");
    expect(response.status).toBe(404);
  });

  it("returns the correct language for a given pad", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/1");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("language");
    expect(body.language).toBe("python");
  });

  it("returns an error for a nonexistent pad", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/456");
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("language");
    expect(body.error).toBe("Pad not found");
  });

  it("updates the language for a given pad", async () => {
    const before = await env.collab_pads
      .prepare("SELECT current_language FROM pads WHERE id = ?")
      .bind('1')
      .first();
    expect(before.current_language).toBe("python");

    const response = await SELF.fetch("http://example.com/api/pads/1", {
      method: "PATCH",
      body: JSON.stringify({ language: "ruby" }),
      headers: { "Content-Type": "application/json" }
    });
    expect(response.status).toBe(204);

    const after = await env.collab_pads
      .prepare("SELECT current_language FROM pads WHERE id = ?")
      .bind('1')
      .first();
    expect(after.current_language).toBe("ruby");
  });

  it("returns an error when updating language without providing language info", async () => {
    const before = await env.collab_pads
      .prepare("SELECT current_language FROM pads WHERE id = ?")
      .bind('1')
      .first();
    expect(before.current_language).toBe("python");

    const response = await SELF.fetch("http://example.com/api/pads/1", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" }
    });
    expect(response.status).toBe(400);

    const after = await env.collab_pads
      .prepare("SELECT current_language FROM pads WHERE id = ?")
      .bind('1')
      .first();
    expect(after.current_language).toBe("python");
  });

  it("returns an error when updating the language of a nonexistent pad", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/456", {
      method: "PATCH",
      body: JSON.stringify({ language: "ruby" }),
      headers: { "Content-Type": "application/json" }
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("language");
    expect(body.error).toBe("Pad not found");
  });

  it("returns the correct content for a given pad and language", async () => {
    await env.collab_pads
      .prepare("UPDATE pad_contents SET content = ? WHERE pad_id = ? AND language = ?")
      .bind('print("hello world")', '1', 'python')
      .run();

    const response = await SELF.fetch("http://example.com/api/pads/1/content/python");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toBe('print("hello world")');
  });

  it("returns an empty string if content is NULL for a given pad and language", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/1/content/python");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toBe("");
  });

  it("adds a row to pad_contents when content is first accessed for a new pad/language combo", async () => {
    await env.collab_pads.prepare("INSERT INTO pads (id) VALUES (?)").bind('2').run();

    const before = await env.collab_pads
      .prepare("SELECT count(id) as count FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('2', 'python')
      .first();
    expect(before.count).toBe(0);

    const response = await SELF.fetch("http://example.com/api/pads/2/content/python");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toBe("");

    const after = await env.collab_pads
      .prepare("SELECT count(id) as count FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('2', 'python')
      .first();
    expect(after.count).toBe(1);
  });

  it("updates content successfully", async () => {
    const before = await env.collab_pads
      .prepare("SELECT content FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('1', 'python')
      .first();
    expect(before.content).toBeNull();

    const response = await SELF.fetch("http://example.com/api/pads/1/content/python", {
      method: "PATCH",
      body: JSON.stringify({ content: 'print("Goodbye")' }),
      headers: { "Content-Type": "application/json" }
    });
    expect(response.status).toBe(204);

    const after = await env.collab_pads
      .prepare("SELECT content FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('1', 'python')
      .first();
    expect(after.content).toBe('print("Goodbye")');
  });

  it("returns an error when updating content of a nonexistent pad", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/456/content/python", {
      method: "PATCH",
      body: JSON.stringify({ content: 'print("Goodbye")' }),
      headers: { "Content-Type": "application/json" }
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("content");
    expect(body.error).toBe("Pad not found");
  });

  it("returns an error when updating content for an invalid language", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/1/content/rust", {
      method: "PATCH",
      body: JSON.stringify({ content: 'print("Goodbye")' }),
      headers: { "Content-Type": "application/json" }
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("content");
    expect(body.error).toBe("Pad language is invalid");
  });

  it("returns an error when updating content without providing content info", async () => {
    const before = await env.collab_pads
      .prepare("SELECT content FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('1', 'python')
      .first();
    expect(before.content).toBeNull();

    const response = await SELF.fetch("http://example.com/api/pads/1/content/python", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" }
    });
    expect(response.status).toBe(400);

    const after = await env.collab_pads
      .prepare("SELECT content FROM pad_contents WHERE pad_id = ? AND language = ?")
      .bind('1', 'python')
      .first();
    expect(after.content).toBeNull();
  });

  it("returns an error when updating content for a pad/language combo that does not exist", async () => {
    const response = await SELF.fetch("http://example.com/api/pads/1/content/sql", {
      method: "PATCH",
      body: JSON.stringify({ content: "SELECT * FROM table;" }),
      headers: { "Content-Type": "application/json" }
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Pad language combo does not exist");
  });
});
