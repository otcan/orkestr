// Incremental SQLite policy writes must leave exactly the rows (and the read
// order) that the full delete-and-reinsert rewrite would leave.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openThreadResourcePolicyDatabase } from "../packages/core/src/thread-resource-policy-store.js";
import { readThreadResourcePolicySqliteState as readState } from "../packages/core/src/thread-resource-policy-sqlite-state.js";
import { writeSqliteState } from "../packages/core/src/thread-resource-policy-sqlite-write.js";

async function database(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-policy-write-${name}-`));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return openThreadResourcePolicyDatabase({ ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" });
}

function dump(db) {
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name like 'orkestr_%' order by name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`select * from ${name} order by rowid`).all().map((row) => ({ ...row })).filter((row) => row.key !== "legacy_desktop_migrated_at")]));
}

function write(db, state, incremental) {
  db.exec("begin immediate");
  try {
    writeSqliteState(db, state, incremental ? readState(db) : null, []);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function random(seed) {
  let value = seed;
  return () => ((value = (value * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const factories = {
  grants: (n, rnd) => ({ id: `grant-${n}`, threadId: `thread-${n % 5}`, resourceType: "desktop", resourceId: `desk-${n}`, resourceKey: `desk-${n}`, ownerUserId: "admin", boundaryId: "local", permissions: rnd() < 0.5 ? ["operate"] : ["discover", "operate"], revision: 1 + Math.floor(rnd() * 3), source: "test", createdAt: at(n), updatedAt: at(n), revokedAt: rnd() < 0.3 ? at(n + 1) : null }),
  policies: (n, rnd) => ({ threadId: `thread-${n}`, resourceType: "desktop", revision: Math.floor(rnd() * 9), explicitEmpty: rnd() < 0.5, createdAt: at(n), updatedAt: at(n + 1) }),
  mutations: (n) => ({ action: "grants.set", idempotencyKey: `key-${n}`, result: { n }, policyRevision: n, createdAt: at(n) }),
  mailboxDeliveries: (n, rnd) => ({ id: `delivery-${n}`, dedupeKey: `dedupe-${Math.floor(rnd() * 1000)}-${n}`, resourceType: "mailbox", resourceId: "mailbox-1", mailboxId: "mailbox-1", state: rnd() < 0.5 ? "pending" : "delivered", messageKey: `message-${n}`, payload: { n }, createdAt: at(n), updatedAt: at(n) }),
  mailboxRoutes: (n, rnd) => ({ id: `route-${n}`, resourceId: `mailbox-${n}`, status: rnd() < 0.7 ? "active" : "retired", note: Math.floor(rnd() * 5) }),
};

function evolve(state, rnd, counter) {
  const next = structuredClone(state);
  for (const [name, make] of Object.entries(factories)) {
    let rows = next[name].filter(() => rnd() > 0.15);
    rows = rows.map((row) => (rnd() < 0.25 ? { ...make(Number(row.id?.split("-")[1] ?? row.threadId?.split("-")[1] ?? row.idempotencyKey?.split("-")[1]), rnd), ...(row.id ? { id: row.id } : {}) } : row));
    for (let i = Math.floor(rnd() * 4); i > 0; i -= 1) rows.push(make(counter.next++, rnd));
    if (rnd() < 0.1) rows.reverse();
    // Swap a unique value between two kept rows to exercise the fallback.
    if (name === "mailboxDeliveries" && rows.length > 1 && rnd() < 0.2) {
      [rows[0], rows[1]] = [{ ...rows[0], dedupeKey: rows[1].dedupeKey }, { ...rows[1], dedupeKey: rows[0].dedupeKey }];
    }
    next[name] = rows;
  }
  next.revision += 1;
  next.updatedAt = at(next.revision);
  return next;
}

test("incremental writes match the full rewrite for randomized state changes", async (t) => {
  const incremental = await database(t, "incremental");
  const full = await database(t, "full");
  const rnd = random(42);
  const counter = { next: 0 };
  let state = { revision: 0, updatedAt: at(0), resources: [], ceilings: [], mailboxListeners: [], mailboxPumpLeases: [], mailboxSources: [], mailboxRouteWork: [], mailboxContexts: [], resourceSessions: [], ...Object.fromEntries(Object.keys(factories).map((name) => [name, []])) };
  for (let step = 0; step < 60; step += 1) {
    state = evolve(state, rnd, counter);
    write(incremental, state, true);
    write(full, state, false);
    assert.deepEqual(dump(incremental), dump(full), `step ${step}`);
    assert.deepEqual(readState(incremental), readState(full), `step ${step}`);
  }
});

test("unchanged rows are left in place and a revoke lands in the same write", async (t) => {
  const db = await database(t, "in-place");
  const grant = (id, extra = {}) => ({ id, threadId: "thread-1", resourceType: "desktop", resourceId: id, resourceKey: id, ownerUserId: "admin", boundaryId: "local", permissions: ["operate"], revision: 1, createdAt: at(1), updatedAt: at(1), ...extra });
  write(db, { revision: 1, grants: [grant("desk-a"), grant("desk-b")] }, false);
  const rowids = () => Object.fromEntries(db.prepare("select id, rowid from orkestr_thread_resource_grants").all().map((row) => [row.id, row.rowid]));
  const before = rowids();
  write(db, { revision: 2, grants: [grant("desk-a"), grant("desk-b", { revokedAt: at(2), revokedBy: "admin" })] }, true);
  assert.deepEqual(rowids(), before);
  assert.equal(readState(db).grants.find((item) => item.id === "desk-b").revokedAt, at(2));
});
