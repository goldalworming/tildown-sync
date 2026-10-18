// TilDown sync server.
//
// One Durable Object (SQLite) holds every note of one person:
//   notes(id, seq, text)  — text NULL = deleted (tombstone)
// `seq` grows by one on every write and doubles as the note's version.
// The Durable Object runs requests one at a time, so the version check in
// `sync` cannot race with another device.
//
// POST /sync  (Authorization: Bearer <TOKEN>)
//   { cursor, changes: [{ id, base, text | null }] }
// → { cursor, more, results: [{ id, seq } | { id, conflict, seq, text }],
//     notes: [{ id, seq, text | null }] }   // changes since `cursor`

import { DurableObject } from "cloudflare:workers";
import { apply } from "./sync.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Compare SHA-256 digests so the comparison is constant-time and length-blind.
async function same(a, b) {
  const h = async (s) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await h(a), await h(b));
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { pathname } = new URL(req.url);
    if (pathname !== "/sync") {
      const ok = pathname === "/";
      return new Response(ok ? "TilDown sync server is running.\n" : "Not found\n", {
        status: ok ? 200 : 404,
        headers: CORS,
      });
    }
    if (req.method !== "POST") return json({ error: "use POST" }, 405);
    if (!env.TOKEN || env.TOKEN.length < 16)
      return json({ error: "server TOKEN secret is missing or shorter than 16 characters" }, 500);
    const auth = req.headers.get("Authorization") || "";
    if (!(await same(auth, `Bearer ${env.TOKEN}`))) return json({ error: "wrong token" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad JSON" }, 400);
    }
    const cursor = Number.isInteger(body?.cursor) ? body.cursor : 0;
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    for (const c of changes) {
      const text = c?.text;
      if (!ID.test(c?.id ?? "") || !Number.isInteger(c.base) || !(text === null || typeof text === "string"))
        return json({ error: "bad change" }, 400);
    }
    const store = env.NOTES.get(env.NOTES.idFromName("notes"));
    return json(await store.sync(cursor, changes));
  },
};

export class Notes extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, text TEXT);
                   CREATE INDEX IF NOT EXISTS notes_seq ON notes (seq);`);
  }

  sync(cursor, changes) {
    const q = (s, ...a) => this.sql.exec(s, ...a).toArray();
    return this.ctx.storage.transactionSync(() => apply(q, cursor, changes));
  }
}
