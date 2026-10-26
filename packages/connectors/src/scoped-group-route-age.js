// How long the relay keeps re-reading an open route (a routed input with no
// final yet). A turn that never produced a visible final here (a remote-runtime
// Deep NO_REPLY, which V1's message pages hide; a Fast reply delivered under
// its own parent; a silently finished input) stays open forever. Each delivery
// pass re-read the thread history for every such input, oldest first, before
// reaching a new reply: on the busiest group, 44 open routes since days cost
// ~6 s per reply. A remote turn ends within its 4 h window (after a bounded
// admission wait, 30 min by default), so past this window no answer can still
// arrive.
export const OPEN_ROUTE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function createRouteAge(db, now) {
  db.exec('CREATE TABLE IF NOT EXISTS route_opened(id TEXT PRIMARY KEY,opened_ms INTEGER NOT NULL);');
  const read = db.prepare('SELECT opened_ms FROM route_opened WHERE id=?');
  const insert = db.prepare('INSERT OR IGNORE INTO route_opened(id,opened_ms) VALUES(?,?)');
  const advance = db.prepare('UPDATE route_opened SET opened_ms=? WHERE id=? AND opened_ms<?');
  const complete = db.prepare('UPDATE routed SET completed=1 WHERE id=?');
  // When an open route started: the routing time this relay recorded, or, for
  // a route routed before that record existed, its WhatsApp time (never later
  // than now).
  function openedMs(input) {
    const row = read.get(input.id);
    if (row) return Number(row.opened_ms);
    const at = Date.parse(input.created_at);
    const opened = Number.isFinite(at) ? Math.min(at, now()) : now();
    insert.run(input.id, opened);
    return opened;
  }
  return {
    // Only an already routed input is ever skipped by its age.
    expired: input => now() - openedMs(input) > OPEN_ROUTE_MAX_AGE_MS,
    routed: id => insert.run(id, now()),
    // A delivered final completes the route. A question or progress update
    // shows the turn is still live: the window then counts from that answer,
    // so a turn that asked and waited is still watched for its final. The
    // answer's own time keeps re-reads idempotent.
    answered(id, answer) {
      if (['final_answer', 'final'].includes(answer.phase)) return complete.run(id);
      const at = Date.parse(answer.createdAt);
      if (!Number.isFinite(at)) return;
      const ms = Math.min(at, now());
      advance.run(ms, id, ms);
    },
  };
}
