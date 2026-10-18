// Offline fixture process only: die after real entity DDL, before COMMIT.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { migratePersonalAgentEntities } from "../../../packages/core/src/agent-job-entities-migration.js";
import { openAgentJobDb } from "../../../packages/core/src/agent-job-store.js";

const db = await openAgentJobDb(process.env);
const interrupted = {
  prepare: (...args) => db.prepare(...args),
  exec(statement) {
    db.exec(statement);
    if (statement.includes("create table if not exists personal_agent_tasks")) {
      assert.equal(db.prepare("select count(*) as count from sqlite_master where name in ('personal_agent_projects', 'personal_agent_tasks')").get().count, 2);
      writeSync(1, "fixture_ddl_applied_before_commit\n");
      process.kill(process.pid, "SIGKILL");
    }
  },
};
migratePersonalAgentEntities(interrupted, { dryRun: false });
assert.fail("fixture must stop before the migration commits");
