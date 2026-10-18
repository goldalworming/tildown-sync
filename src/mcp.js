// MCP (Model Context Protocol) for Claude: read, search, create and edit notes.
// Streamable HTTP, stateless: every POST is one JSON-RPC message (or a batch)
// answered with plain JSON. Notes written here reach the apps on their next sync.
// `q(sql, ...args)` returns rows; writes go through `apply` like a device would.

import { apply } from "./sync.js";

const VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "list_notes",
    description: "List TilDown notes, most recently changed first: id and title.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Max notes (default 50)" } } },
  },
  {
    name: "search_notes",
    description:
      "Search TilDown notes. Every word must appear; a word starting with # matches that exact tag (e.g. '#kajian doa'). Returns id, title and a matching line.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_note",
    description: "Read a note's full markdown. `id` may be a reference like 'tildown:20261018-171034'.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_note",
    description: "Create a note. The first line is its title, e.g. '# Shopping list'. Returns the new id.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "update_note",
    description: "Replace a note's whole text. Read it first and keep what the user did not ask to change.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
  {
    name: "append_to_note",
    description: "Add text to the end of a note (on a new line).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
];

const title = (t) => (t.split("\n").find((l) => l.trim()) || "(empty)").replace(/^#+\s*/, "").trim();
const cleanId = (id) => String(id ?? "").trim().replace(/^tildown:/, "").split(/\s/)[0];
const tags = (t) => [...t.matchAll(/(?:^|\s)(#[\p{L}\p{N}_\-/]+)/gu)].map((m) => m[1].replace(/[-/]+$/, ""));

function live(q) {
  return q("SELECT id, seq, text FROM notes WHERE text IS NOT NULL ORDER BY seq DESC");
}

function note(q, id) {
  return q("SELECT id, seq, text FROM notes WHERE id = ?", cleanId(id))[0];
}

// Same id shape as the app (`YYYYMMDD-HHMMSS`, UTC), made unique.
function newId(q, now = new Date()) {
  const base = now.toISOString().slice(0, 19).replace(/-/g, "").replace(":", "").replace(":", "").replace("T", "-");
  for (let k = 1; ; k++) {
    const id = k === 1 ? base : `${base}-${k}`;
    if (!q("SELECT 1 FROM notes WHERE id = ?", id).length) return id;
  }
}

function write(q, id, base, text) {
  const r = apply(q, Number.MAX_SAFE_INTEGER, [{ id, base, text }]).results[0];
  if (r.conflict) throw new Error("the note changed meanwhile; read it again");
}

export function call(q, name, a = {}) {
  switch (name) {
    case "list_notes": {
      const n = live(q).slice(0, Math.max(1, Math.min(500, a.limit ?? 50)));
      return n.map((r) => `tildown:${r.id}  ${title(r.text)}`).join("\n") || "No notes.";
    }
    case "search_notes": {
      const terms = String(a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = live(q).filter((r) => {
        const low = r.text.toLowerCase();
        const tg = tags(low);
        return terms.every((t) => (t.length > 1 && t.startsWith("#") ? tg.includes(t) : low.includes(t)));
      });
      return (
        hits
          .slice(0, 50)
          .map((r) => {
            const words = terms.filter((t) => !t.startsWith("#"));
            const lines = r.text.split("\n").filter((l) => l.trim()).slice(1); // without the title
            const line = lines.find((l) => words.some((t) => l.toLowerCase().includes(t))) ?? "";
            return `tildown:${r.id}  ${title(r.text)}${line ? `\n    ${line.trim().slice(0, 160)}` : ""}`;
          })
          .join("\n") || "No matching notes."
      );
    }
    case "read_note": {
      const r = note(q, a.id);
      if (!r || r.text === null) throw new Error(`no note ${cleanId(a.id)}`);
      return `tildown:${r.id}\n\n${r.text}`;
    }
    case "create_note": {
      const id = newId(q);
      write(q, id, 0, String(a.text ?? ""));
      return `Created tildown:${id}`;
    }
    case "update_note":
    case "append_to_note": {
      const r = note(q, a.id);
      if (!r || r.text === null) throw new Error(`no note ${cleanId(a.id)}`);
      const text = name === "update_note" ? String(a.text ?? "") : `${r.text.replace(/\n*$/, "")}\n${a.text ?? ""}\n`;
      write(q, r.id, r.seq, text);
      return `Saved tildown:${r.id}`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/// One JSON-RPC message → reply object, or null for notifications.
export function rpc(q, m) {
  const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m?.id === undefined || m?.id === null) return null; // notification
  switch (m.method) {
    case "initialize":
      return ok({
        protocolVersion: m.params?.protocolVersion || VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "tildown", version: "1" },
        instructions:
          "TilDown notes (markdown). References look like 'tildown:<id>'; pass them to read_note. Titles are the first line.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      try {
        return ok({ content: [{ type: "text", text: call(q, m.params?.name, m.params?.arguments) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } };
  }
}
