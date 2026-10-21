// TilDown sync server.
//
// One Durable Object (SQLite) holds every note of one person:
//   notes(id, seq, text)  — text NULL = deleted (tombstone)
//   shares(sid, note)     — public read-only links
// `seq` grows by one on every write and doubles as the note's version.
// The Durable Object runs requests one at a time, so the version check in
// `sync` cannot race with another device.
//
// POST /sync  (Authorization: Bearer <TOKEN>)
//   { cursor, changes: [{ id, base, text | null }] }
// → { cursor, more, results: [{ id, seq } | { id, conflict, seq, text }],
//     notes: [{ id, seq, text | null }],   // changes since `cursor`
//     shares: [{ note, sid }] }            // every shared note
//
// POST /share    { note } → { note, sid }   new link; the old one stops working
// POST /unshare  { note } → {}
// GET  /s/<sid>  the note as a web page, always the latest synced version (no token)
// POST /mcp/<TOKEN>  MCP server for Claude (see mcp.js); the token in the URL is the secret

import { DurableObject } from "cloudflare:workers";
import { marked } from "marked";
import { apply, share, unshare, shares, shared, SHARES } from "./sync.js";
import { rpc } from "./mcp.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SID = /^\/s\/([A-Za-z0-9]{12})$/;

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

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Raw HTML in a note is shown as text; the CSP below also blocks every script.
// Enter = line break, as in the app.
marked.use({
  breaks: true,
  renderer: {
    html: ({ text }) => esc(text),
    // Only web, mail and in-page links; anything else (javascript:, …) stays plain text.
    link(t) {
      const inner = this.parser.parseInline(t.tokens);
      return /^(https?:|mailto:|#)/i.test(t.href) ? `<a href="${esc(t.href)}">${inner}</a>` : inner;
    },
  },
});

function page(text) {
  const title = (text.split("\n").find((l) => l.trim()) || "Note").replace(/^#+\s*/, "").trim().slice(0, 120);
  const body = marked.parse(text);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="https://goldalworming.github.io/tildown/icons/icon-192.png"><link rel="apple-touch-icon" href="https://goldalworming.github.io/tildown/icons/apple-touch-icon.png">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--fg:#1f2328;--dim:#59636e;--bg:#fff;--line:#d1d9e0;--code:#f6f8fa;--a:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--dim:#9198a1;--bg:#0d1117;--line:#3d444d;--code:#151b23;--a:#4493f8}}
@font-face{font-family:Khatt;src:url(https://cdn.jsdelivr.net/gh/goldalworming/tildown@v0.1.10/assets/fonts/DigitalKhatt-Madina.otf);unicode-range:U+0600-06FF,U+0750-077F,U+0870-08FF,U+FB50-FDFF,U+FE70-FEFF;size-adjust:130%;font-display:swap}
@font-face{font-family:Naskh;src:url(https://cdn.jsdelivr.net/gh/goldalworming/tildown@v0.1.10/assets/fonts/NotoNaskhArabic-Extra.ttf);unicode-range:U+0600-06FF,U+0750-077F,U+0870-08FF,U+FB50-FDFF,U+FE70-FEFF;size-adjust:130%;font-display:swap}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.8 Khatt,Naskh,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 24px;overflow-wrap:anywhere}
a{color:var(--a)}img{max-width:100%}h1,h2,h3{line-height:1.25}
pre,code{background:var(--code);border-radius:6px;font:14px/1.5 ui-monospace,Consolas,monospace}
pre{padding:12px 16px;overflow-x:auto}code{padding:2px 4px}pre code{padding:0}
blockquote{margin:0;padding:0 16px;color:var(--dim);border-left:3px solid var(--line)}
table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:6px 12px}
hr{border:0;border-top:1px solid var(--line)}
footer{max-width:720px;margin:0 auto;padding:16px;color:var(--dim);font-size:13px;border-top:1px solid var(--line)}
</style></head><body><main dir="auto">${body}</main>
<footer>Shared from <a href="https://github.com/goldalworming/tildown">TilDown</a></footer></body></html>`;
}

const gone = () =>
  new Response("This link doesn't exist or is no longer shared.\n", { status: 404, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { pathname } = new URL(req.url);
    const store = () => env.NOTES.get(env.NOTES.idFromName("notes"));

    const s = SID.exec(pathname);
    if (s && req.method === "GET") {
      const text = await store().shared(s[1]);
      if (text === null) return gone();
      return new Response(page(text), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https://cdn.jsdelivr.net",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const mcp = /^\/mcp\/([^/]+)$/.exec(pathname);
    if (mcp) {
      if (!env.TOKEN || env.TOKEN.length < 16 || !(await same(mcp[1], env.TOKEN)))
        return json({ error: "wrong token" }, 401);
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad JSON" } }, 400);
      }
      const out = await store().mcp(body);
      return out === null ? new Response(null, { status: 202 }) : json(out);
    }
    if (!["/sync", "/share", "/unshare"].includes(pathname)) {
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
    if (pathname !== "/sync") {
      const note = body?.note;
      if (!ID.test(note ?? "")) return json({ error: "bad note id" }, 400);
      if (pathname === "/share") return json({ note, sid: await store().share(note) });
      await store().unshare(note);
      return json({});
    }
    const cursor = Number.isInteger(body?.cursor) ? body.cursor : 0;
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    for (const c of changes) {
      const text = c?.text;
      if (!ID.test(c?.id ?? "") || !Number.isInteger(c.base) || !(text === null || typeof text === "string"))
        return json({ error: "bad change" }, 400);
    }
    return json(await store().sync(cursor, changes));
  },
};

export class Notes extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, text TEXT);
                   CREATE INDEX IF NOT EXISTS notes_seq ON notes (seq);
                   ${SHARES};`);
    this.q = (s, ...a) => this.sql.exec(s, ...a).toArray();
  }

  sync(cursor, changes) {
    return this.ctx.storage.transactionSync(() => ({ ...apply(this.q, cursor, changes), shares: shares(this.q) }));
  }

  share(note) {
    return this.ctx.storage.transactionSync(() => share(this.q, note));
  }

  unshare(note) {
    unshare(this.q, note);
  }

  shared(sid) {
    return shared(this.q, sid);
  }

  mcp(body) {
    return this.ctx.storage.transactionSync(() => {
      if (!Array.isArray(body)) return rpc(this.q, body);
      const out = body.map((m) => rpc(this.q, m)).filter(Boolean);
      return out.length ? out : null;
    });
  }
}
