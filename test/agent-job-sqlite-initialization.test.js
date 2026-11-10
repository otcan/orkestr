import assert from "node:assert/strict";
import test from "node:test";
import { initializeAgentJobJournal } from "../packages/core/src/agent-job-sqlite-initialization.js";

function fixture(errors) {
  let elapsed = 0, attempts = 0;
  const statements = [], waits = [];
  return {
    db: { exec(sql) {
      statements.push(sql);
      if (sql === "pragma journal_mode = WAL") {
        attempts++;
        const error = errors.shift();
        if (error) throw error;
      }
    } },
    options: { timeoutMs: 25, now: () => elapsed, wait: ms => { waits.push(ms); elapsed += ms; } },
    statements, waits, attempts: () => attempts,
  };
}

test("journal busy handler is installed before WAL and restored after success", () => {
  const f = fixture([]);
  initializeAgentJobJournal(f.db, f.options);
  assert.deepEqual(f.statements, ["pragma busy_timeout = 25", "pragma journal_mode = WAL", "pragma busy_timeout = 10000"]);
  assert.equal(f.attempts(), 1);
});

test("immediate BUSY and extended BUSY retry only journal initialization", () => {
  const f = fixture([Object.assign(Error("busy"), { errcode: 5 }), Object.assign(Error("busy recovery"), { errcode: 261 })]);
  initializeAgentJobJournal(f.db, f.options);
  assert.equal(f.attempts(), 3);
  assert.deepEqual(f.waits, [10, 10]);
  assert.ok(f.statements.includes("pragma busy_timeout = 5"));
});

test("persistent contention ends at the deadline without hiding the SQLite error", () => {
  const error = Object.assign(Error("busy"), { errcode: 5 });
  const f = fixture(Array(10).fill(error));
  assert.throws(() => initializeAgentJobJournal(f.db, f.options), caught => caught === error);
  assert.deepEqual(f.waits, [10, 10, 5]);
  assert.equal(f.attempts(), 4);
  assert.equal(f.statements.at(-1), "pragma busy_timeout = 10000");
});

test("corruption, permission errors and SQLITE_LOCKED are not retried", () => {
  for (const errcode of [11, 23, 6, undefined]) {
    const error = Object.assign(Error("not transient busy"), { errcode });
    const f = fixture([error]);
    assert.throws(() => initializeAgentJobJournal(f.db, f.options), caught => caught === error);
    assert.equal(f.attempts(), 1);
    assert.deepEqual(f.waits, []);
  }
});
