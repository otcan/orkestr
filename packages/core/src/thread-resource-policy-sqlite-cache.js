// Parsed-state cache for the SQLite policy store. Parsing every table costs
// ~100 ms on a busy store and runs several times per request, so the parsed
// state is reused while it is provably current. The key combines:
// - `pragma data_version`, which changes whenever any other connection or
//   process commits to the database file;
// - a per-connection write generation, bumped around every own write,
//   because own commits do not change data_version;
// - the stored policy revision, as a cheap extra guard.
// Revisions alone are not enough: delivery/session bookkeeping commits with
// skipPolicyEpoch and leaves the revision unchanged.
const caches = new WeakMap();

function slot(db) {
  let entry = caches.get(db);
  if (!entry) caches.set(db, (entry = { writeGeneration: 0, states: new Map() }));
  return entry;
}

function currentKey(db, entry) {
  const dataVersion = db.prepare("pragma data_version").get()?.data_version;
  const revision = db.prepare("select value from orkestr_thread_resource_meta where key = 'revision'").get()?.value ?? "";
  return `${dataVersion}:${entry.writeGeneration}:${revision}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Returns a deep-frozen parsed state for `kind`, re-reading when the key
// moved. The key is taken before reading so a commit that lands mid-read
// forces a re-read on the next call instead of being cached under a new key.
export function cachedSqliteState(db, kind, read) {
  const entry = slot(db);
  const key = currentKey(db, entry);
  const hit = entry.states.get(kind);
  if (hit?.key === key) return hit.state;
  const state = deepFreeze(read(db));
  entry.states.set(kind, { key, state });
  return state;
}

// Mutable state for a write transaction (call after `begin immediate`). A
// current cache entry is cloned (about half the cost of re-parsing); on a
// miss the tables are read directly, since the write will invalidate anyway.
export function mutableSqliteState(db, read) {
  const entry = slot(db);
  const hit = entry.states.get("full");
  if (hit && hit.key === currentKey(db, entry)) return structuredClone(hit.state);
  return read(db);
}

// Every write on this connection must call this before committing and after
// a rollback, so no reader can observe a pre-write snapshot. Transactions that
// persist nothing leave the cache valid: they only ever mutate a clone.
export function invalidateSqliteStateCache(db) {
  const entry = slot(db);
  entry.writeGeneration += 1;
  entry.states.clear();
}
