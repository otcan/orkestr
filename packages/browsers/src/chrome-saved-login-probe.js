import fs from "node:fs/promises";
import path from "node:path";

// Password-blind check that Chrome saved a login for an exact origin
// (docs/password-handoff.md). It opens the profile's "Login Data" database
// read-only and selects only `signon_realm` and `date_created`. It never
// selects usernames or password columns and never copies the file.

// Chrome stores timestamps as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

export function chromeTimeToMs(value) {
  const micros = Number(value);
  return Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) - CHROME_EPOCH_OFFSET_MS : 0;
}

export function msToChromeTime(ms) {
  return (Math.floor(Number(ms) || 0) + CHROME_EPOCH_OFFSET_MS) * 1000;
}

function signonRealm(origin) {
  return `${String(origin || "").replace(/\/+$/g, "")}/`;
}

async function nonEmpty(file) {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * `{ ok: true, saved, count }`: logins Chrome saved for `origin` at or after
 * `sinceMs`; `{ ok: false, reason }` when the profile cannot be read, or
 * `journal_pending` while a WAL or rollback journal holds writes that an
 * immutable read cannot see (a save may be there, unconfirmed).
 */
export async function savedLoginSince(profileDir, origin, sinceMs, deps = {}) {
  const file = path.join(String(profileDir || ""), "Default", "Login Data");
  if (!profileDir) return { ok: false, reason: "profile_unknown" };
  try {
    await fs.access(file);
  } catch {
    return { ok: false, reason: "login_store_missing" };
  }
  if (await nonEmpty(`${file}-wal`) || await nonEmpty(`${file}-journal`)) return { ok: false, reason: "journal_pending" };
  let db = null;
  try {
    const sqlite = deps.sqlite || await import("node:sqlite");
    // immutable: no locks and no journal writes while Chrome has it open.
    db = new sqlite.DatabaseSync(`file:${encodeURI(file)}?mode=ro&immutable=1`, { readOnly: true });
    const row = db.prepare("select count(*) as count from logins where signon_realm = ? and date_created >= ?")
      .get(signonRealm(origin), msToChromeTime(sinceMs));
    const count = Number(row?.count || 0) || 0;
    return { ok: true, saved: count > 0, count };
  } catch {
    return { ok: false, reason: "login_store_unreadable" };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
