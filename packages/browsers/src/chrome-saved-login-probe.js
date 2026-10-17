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

// Chrome keeps two login stores: "Login Data" (this profile) and
// "Login Data For Account" (the signed-in Google account; generated passwords
// usually land there). Both are checked; the stores are rollback-journal
// SQLite files, and a non-empty -journal or -wal means unread writes.
const STORES = ["Login Data", "Login Data For Account"];

async function countStore(file, origin, sinceMs, deps) {
  if (await nonEmpty(`${file}-wal`) || await nonEmpty(`${file}-journal`)) return { ok: false, reason: "journal_pending" };
  let db = null;
  try {
    const sqlite = deps.sqlite || await import("node:sqlite");
    // immutable: no locks and no journal writes while Chrome has it open.
    db = new sqlite.DatabaseSync(`file:${encodeURI(file)}?mode=ro&immutable=1`, { readOnly: true });
    const row = db.prepare("select count(*) as count from logins where signon_realm = ? and date_created >= ?")
      .get(signonRealm(origin), msToChromeTime(sinceMs));
    return { ok: true, count: Number(row?.count || 0) || 0 };
  } catch {
    return { ok: false, reason: "login_store_unreadable" };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * `{ ok: true, saved, count }`: logins Chrome saved for `origin` at or after
 * `sinceMs` in either store; `{ ok: false, reason }` when no store exists, a
 * store cannot be read, or `journal_pending` while a store has writes an
 * immutable read cannot see (a save may be there, unconfirmed).
 */
export async function savedLoginSince(profileDir, origin, sinceMs, deps = {}) {
  if (!profileDir) return { ok: false, reason: "profile_unknown" };
  let found = 0;
  let count = 0;
  for (const name of STORES) {
    const file = path.join(String(profileDir), "Default", name);
    try {
      await fs.access(file);
    } catch {
      continue;
    }
    found += 1;
    const result = await countStore(file, origin, sinceMs, deps);
    if (!result.ok) return result;
    count += result.count;
  }
  if (!found) return { ok: false, reason: "login_store_missing" };
  return { ok: true, saved: count > 0, count };
}
