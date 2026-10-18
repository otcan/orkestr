const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

// SQLite can return BUSY immediately during competing journal-mode upgrades,
// bypassing its busy handler. Retry only that operation within one deadline.
export function initializeAgentJobJournal(db, {
  timeoutMs = 10000,
  now = () => performance.now(),
  wait = ms => Atomics.wait(waitBuffer, 0, 0, ms),
} = {}) {
  const deadline = now() + timeoutMs;
  try {
    for (;;) {
      db.exec(`pragma busy_timeout = ${Math.max(0, Math.ceil(deadline - now()))}`);
      try {
        db.exec("pragma journal_mode = WAL");
        return;
      } catch (error) {
        const remaining = deadline - now();
        if ((Number(error?.errcode) & 255) !== 5 || remaining <= 0) throw error;
        wait(Math.min(10, remaining));
      }
    }
  } finally {
    db.exec("pragma busy_timeout = 10000");
  }
}
