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
