// The sync rule, kept apart from the Durable Object so `npm test` can run it
// against node:sqlite. `q(sql, ...args)` returns rows as plain objects.

const PAGE = 200;

export function apply(q, cursor, changes) {
  let seq = q("SELECT coalesce(max(seq), 0) AS s FROM notes")[0].s;
  const results = [];
  for (const c of changes) {
    const row = q("SELECT seq, text FROM notes WHERE id = ?", c.id)[0];
    const cur = row ? row.seq : 0;
    if (cur !== c.base) {
      // Someone else wrote first: send the current version back so the app
      // can keep both copies.
      results.push({ id: c.id, conflict: true, seq: cur, text: row ? row.text : null });
      continue;
    }
    seq += 1;
    q(
      `INSERT INTO notes (id, seq, text) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, text = excluded.text`,
      c.id,
      seq,
      c.text,
    );
    results.push({ id: c.id, seq });
  }
  const notes = q("SELECT id, seq, text FROM notes WHERE seq > ? ORDER BY seq LIMIT ?", cursor, PAGE + 1);
  const more = notes.length > PAGE;
  if (more) notes.pop();
  return { cursor: notes.length ? notes[notes.length - 1].seq : cursor, more, results, notes };
}

// Sharing: one public link per note, read live from `notes`. A new share
// replaces the note's old link, so stopping and sharing again never revives
// an old id.
//   shares(sid, note)  — sid: random, unguessable; note: notes.id

export const SHARES = "CREATE TABLE IF NOT EXISTS shares (sid TEXT PRIMARY KEY, note TEXT NOT NULL UNIQUE)";

/// 12 characters from 62: about 71 bits.
export function newSid() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b) if (x < 248 && s.length < 12) s += abc[x % 62]; // 248 = 4·62: no bias
  return s.length === 12 ? s : newSid();
}

export function share(q, note, sid = newSid()) {
  q("DELETE FROM shares WHERE note = ?", note);
  q("INSERT INTO shares (sid, note) VALUES (?, ?)", sid, note);
  return sid;
}

export function unshare(q, note) {
  q("DELETE FROM shares WHERE note = ?", note);
}

export const shares = (q) => q("SELECT note, sid FROM shares");

/// Text of the shared note, or null (unknown link, stopped, or deleted note).
export function shared(q, sid) {
  const r = q("SELECT n.text FROM shares s JOIN notes n ON n.id = s.note WHERE s.sid = ?", sid)[0];
  return r?.text ?? null;
}
