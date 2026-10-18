// Sync rule against a real SQLite (node:sqlite), same SQL as the Durable Object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { call, rpc } from "./src/mcp.js";
import { apply, share, unshare, shares, shared, newSid, SHARES } from "./src/sync.js";

const db = () => {
  const d = new DatabaseSync(":memory:");
  d.exec(SHARES + "; CREATE TABLE notes (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, text TEXT); CREATE INDEX notes_seq ON notes (seq);");
  return (s, ...a) => d.prepare(s).all(...a).map((r) => ({ ...r }));
};

test("push, pull, conflict, delete", () => {
  const q = db();
  // Device A creates two notes.
  let r = apply(q, 0, [{ id: "a", base: 0, text: "A1" }, { id: "b", base: 0, text: "B1" }]);
  assert.deepEqual(r.results, [{ id: "a", seq: 1 }, { id: "b", seq: 2 }]);
  assert.equal(r.cursor, 2);
  // Device B pulls everything.
  r = apply(q, 0, []);
  assert.deepEqual(r.notes.map((n) => [n.id, n.seq, n.text]), [["a", 1, "A1"], ["b", 2, "B1"]]);
  // A edits a; B edits a from the old base → conflict with A's version.
  apply(q, 2, [{ id: "a", base: 1, text: "A2" }]);
  r = apply(q, 2, [{ id: "a", base: 1, text: "A-from-B" }]);
  assert.deepEqual(r.results, [{ id: "a", conflict: true, seq: 3, text: "A2" }]);
  // Delete leaves a tombstone that others pull.
  apply(q, 3, [{ id: "b", base: 2, text: null }]);
  r = apply(q, 3, []);
  assert.deepEqual(r.notes, [{ id: "b", seq: 4, text: null }]);
  // A new note under a deleted id must use the tombstone's seq as base.
  r = apply(q, 4, [{ id: "b", base: 0, text: "again" }]);
  assert.equal(r.results[0].conflict, true);
});

test("pages of 200", () => {
  const q = db();
  apply(q, 0, Array.from({ length: 450 }, (_, i) => ({ id: `n${i}`, base: 0, text: "x" })));
  let r = apply(q, 0, []);
  assert.equal(r.notes.length, 200);
  assert.ok(r.more);
  r = apply(q, r.cursor, []);
  r = apply(q, r.cursor, []);
  assert.equal(r.notes.length, 50);
  assert.ok(!r.more);
  assert.equal(r.cursor, 450);
});

test("share, live text, stop, share again", () => {
  const q = db();
  apply(q, 0, [{ id: "a", base: 0, text: "A1" }]);
  const s1 = share(q, "a");
  assert.match(s1, /^[A-Za-z0-9]{12}$/);
  assert.equal(shared(q, s1), "A1");
  apply(q, 1, [{ id: "a", base: 1, text: "A2" }]);
  assert.equal(shared(q, s1), "A2", "the link shows the latest version");
  const s2 = share(q, "a");
  assert.notEqual(s1, s2);
  assert.equal(shared(q, s1), null, "sharing again kills the old link");
  assert.deepEqual(shares(q), [{ note: "a", sid: s2 }]);
  unshare(q, "a");
  assert.equal(shared(q, s2), null);
  share(q, "a", "x");
  apply(q, 2, [{ id: "a", base: 2, text: null }]);
  assert.equal(shared(q, "x"), null, "deleted note");
  assert.equal(shared(q, "nope"), null);
  assert.equal(new Set(Array.from({ length: 50 }, newSid)).size, 50);
});

test("mcp tools", () => {
  const q = db();
  apply(q, 0, [{ id: "20260101-000000", base: 0, text: "# Rendang\n\n#resep daging sapi\nsantan" }, { id: "x", base: 0, text: "# Lain\n#resepku" }]);
  assert.match(call(q, "list_notes", {}), /tildown:20260101-000000  Rendang/);
  const s = call(q, "search_notes", { query: "#resep santan" });
  assert.match(s, /Rendang\n    santan/);
  assert.doesNotMatch(s, /Lain/, "tag must match exactly");
  assert.match(call(q, "read_note", { id: "tildown:20260101-000000 (Rendang)" }), /daging sapi/);
  const id = call(q, "create_note", { text: "# Baru" }).match(/tildown:(\S+)/)[1];
  assert.match(id, /^\d{8}-\d{6}$/);
  assert.equal(apply(q, 0, []).notes.find((n) => n.id === id).text, "# Baru", "devices pull it");
  call(q, "append_to_note", { id, text: "- satu" });
  const body = call(q, "read_note", { id }).split("\n\n").slice(1).join("\n\n");
  call(q, "update_note", { id, text: body + "- dua\n" });
  assert.equal(call(q, "read_note", { id }), `tildown:${id}\n\n# Baru\n- satu\n- dua\n`);
  assert.throws(() => call(q, "read_note", { id: "nope" }));
  const r = rpc(q, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { id: "nope" } } });
  assert.equal(r.result.isError, true);
  assert.equal(rpc(q, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(rpc(q, { jsonrpc: "2.0", id: 2, method: "tools/list" }).result.tools.length, 6);
});
