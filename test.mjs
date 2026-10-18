// Sync rule against a real SQLite (node:sqlite), same SQL as the Durable Object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { apply } from "./src/sync.js";

const db = () => {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, text TEXT); CREATE INDEX notes_seq ON notes (seq);");
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
