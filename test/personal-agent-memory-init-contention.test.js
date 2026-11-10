import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const memoryModule = new URL("../packages/core/src/personal-agent-memory-sqlite.js", import.meta.url).href;
const jobModule = new URL("../packages/core/src/agent-job-store.js", import.meta.url).href;

for (const kind of ["memory", "Agent Job"]) {
test(`${kind} initialization waits for an existing writer before changing journal mode`, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-memory-init-contention-"));
  const db = new DatabaseSync(path.join(home, "agent-jobs.sqlite"));
  t.after(async () => { db.close(); await fs.rm(home, { recursive: true, force: true }); });
  db.exec("create table legacy_fixture (value text); insert into legacy_fixture values ('synthetic'); begin exclusive");
  const code = `import {openPersonalAgentMemoryStore} from ${JSON.stringify(memoryModule)};
    import {openAgentJobDb} from ${JSON.stringify(jobModule)};
    process.stdout.write('opening\\n');
    ${kind === "memory" ? "const store=await openPersonalAgentMemoryStore({ownerUserId:'owner-fixture'}); console.log(JSON.stringify(store.transaction(tx=>tx.list())));" : "await openAgentJobDb(); console.log('[]');"}`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    env: { PATH: process.env.PATH, HOME: home, ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "", stderr = "", release;
  const timer = setTimeout(() => child.kill(), 15000);
  child.stdout.on("data", data => {
    stdout += data;
    if (!release && stdout.includes("opening\n")) release = setTimeout(() => db.exec("commit"), 200);
  });
  child.stderr.on("data", data => { stderr += data; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  if (release) clearTimeout(release);
  if (db.isTransaction) db.exec("rollback");
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "opening\n[]");
  assert.equal(db.prepare("select value from legacy_fixture").get().value, "synthetic");
  assert.equal(db.prepare("pragma journal_mode").get().journal_mode, "wal");
});
}

for (const initialized of [false, true]) {
  test(`simultaneous memory openers preserve one consented record (initialized=${initialized})`, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-memory-simultaneous-"));
    const env = { PATH: process.env.PATH, HOME: home, ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    if (initialized) {
      const { openAgentJobDb, closeAgentJobDbs } = await import("../packages/core/src/agent-job-store.js");
      await openAgentJobDb(env);
      await closeAgentJobDbs();
    }
    const workers = [1, 2].map(() => {
      const child = spawn(process.execPath, [new URL("./fixtures/personal-agent-memory-init-worker.mjs", import.meta.url).pathname], {
        env, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill(), 20000);
      t.after(() => { clearTimeout(timer); child.kill(); });
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      const ready = new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", code => reject(Error(`worker exited before ready: ${code}`)));
      });
      const finished = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      return { child, ready, finished };
    });
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.send("start");
    const results = await Promise.all(workers.map(worker => worker.finished));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const writes = results.map(result => JSON.parse(result.stdout));
    assert.deepEqual(writes.map(result => result.deduplicated).sort(), [false, true]);
    assert.deepEqual(writes[0].record, writes[1].record);
    const db = new DatabaseSync(path.join(home, "agent-jobs.sqlite"));
    try { assert.equal(db.prepare("select count(*) as n from personal_agent_memories").get().n, 1); }
    finally { db.close(); }
  });
}
