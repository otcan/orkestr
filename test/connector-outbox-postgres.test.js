import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __connectorOutboxTestInternals,
  claimConnectorOutboxJob,
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
  markConnectorOutboxJob,
  readConnectorOutbox,
} from "../packages/connectors/src/connector-outbox.js";
import { dataPaths } from "../packages/storage/src/paths.js";

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS: "5000",
    ...extra,
  };
}

function whatsappJob(input = {}) {
  return {
    connector: "whatsapp",
    accountId: "responder",
    chatId: "shared-chat",
    threadId: "thread-1",
    sourceEventId: "message-1",
    sourceMessageId: "message-1",
    sourceRevision: "1",
    deliveryType: "final",
    payload: { text: "same outbound body" },
    ...input,
  };
}

function fakePostgresOutboxPool() {
  const jobs = new Map();
  const meta = new Map();
  const pool = {
    async connect() {
      return {
        query: pool.query,
        release() {},
      };
    },
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (text.startsWith("create table") || text === "begin" || text === "commit" || text === "rollback") return { rows: [] };
      if (text.startsWith("select value from orkestr_connector_outbox_meta")) {
        return meta.has(params[0]) ? { rows: [{ value: meta.get(params[0]) }] } : { rows: [] };
      }
      if (text.startsWith("insert into orkestr_connector_outbox_meta")) {
        meta.set(params[0], params[1]);
        return { rows: [] };
      }
      if (text.startsWith("select count(*)::int as count from orkestr_connector_outbox")) {
        return { rows: [{ count: filteredRows(sql, params).length }] };
      }
      if (text.startsWith("delete from orkestr_connector_outbox") && !text.includes("where id in")) {
        jobs.clear();
        return { rows: [] };
      }
      if (text.startsWith("delete from orkestr_connector_outbox where id in")) {
        for (const id of params) jobs.delete(id);
        return { rows: [] };
      }
      if (text.startsWith("insert into orkestr_connector_outbox(")) {
        const job = typeof params[16] === "string" ? JSON.parse(params[16]) : params[16];
        for (const [id, existing] of jobs.entries()) {
          if (existing.idempotencyKey === params[1] && id !== params[0]) jobs.delete(id);
        }
        jobs.set(params[0], job);
        return { rows: [] };
      }
      if (text.startsWith("select data from orkestr_connector_outbox where id =")) {
        const match = [...jobs.values()].find((job) => job.id === params[0] || job.idempotencyKey === params[1]);
        return { rows: match ? [{ data: match }] : [] };
      }
      if (text.startsWith("select id from orkestr_connector_outbox")) return { rows: [] };
      if (text.startsWith("select data from orkestr_connector_outbox")) {
        const limit = text.includes(" limit ") ? Number(params.at(-1) || 0) : 0;
        const rows = filteredRows(sql, params)
          .sort((left, right) => Date.parse(right.updatedAt || right.terminalAt || right.createdAt) - Date.parse(left.updatedAt || left.terminalAt || left.createdAt))
          .slice(0, limit || undefined)
          .map((job) => ({ data: job }));
        return { rows };
      }
      throw new Error(`unexpected fake postgres query: ${sql}`);
    },
  };

  function filteredRows(sql, params = []) {
    const text = String(sql).toLowerCase();
    const values = [...jobs.values()];
    const has = (column) => text.includes(`${column} =`);
    return values.filter((job) => {
      let index = 0;
      if (has("connector") && job.connector !== params[index++]) return false;
      if (has("tenant_id") && job.tenantId !== params[index++]) return false;
      if (has("owner_user_id") && job.ownerUserId !== params[index++]) return false;
      if (has("account_id") && job.accountId !== params[index++]) return false;
      if (has("chat_id") && job.chatId !== params[index++]) return false;
      if (has("thread_id") && job.threadId !== params[index++]) return false;
      if (has("delivery_type") && job.deliveryType !== params[index++]) return false;
      if (text.includes("state in")) {
        const stateParams = params.slice(index, text.includes(" limit ") ? -1 : undefined);
        if (!stateParams.includes(job.state)) return false;
      }
      return true;
    });
  }

  return pool;
}

test("connector outbox supports Postgres backend operations", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-postgres-"));
  const runtimeEnv = env(home, {
    ORKESTR_CONNECTOR_OUTBOX_STORE: "postgres",
    ORKESTR_CONNECTOR_OUTBOX_POSTGRES_URL: "postgres://fixture/outbox",
  });
  const paths = dataPaths(runtimeEnv);
  const migratedJob = whatsappJob({
    tenantId: "tenant-pg",
    sourceMessageId: "migrated",
    sourceEventId: "migrated",
    state: "failed_retryable",
    error: "bridge_down",
  });
  await fs.writeFile(paths.connectorOutbox, `${JSON.stringify({ schemaVersion: 1, jobs: [migratedJob] }, null, 2)}\n`);
  __connectorOutboxTestInternals.setPostgresPoolFactory(() => fakePostgresOutboxPool());

  try {
    const migrated = await readConnectorOutbox(runtimeEnv);
    assert.equal(migrated.backend, "postgres");
    assert.equal(migrated.jobs.length, 1);
    assert.equal(migrated.jobs[0].sourceMessageId, "migrated");

    const first = await ensureConnectorOutboxJob(whatsappJob({
      tenantId: "tenant-pg",
      sourceMessageId: "fresh",
      sourceEventId: "fresh",
      payload: { text: "fresh body" },
    }), runtimeEnv);
    const duplicate = await ensureConnectorOutboxJob(whatsappJob({
      tenantId: "tenant-pg",
      sourceMessageId: "fresh",
      sourceEventId: "fresh-retry",
      payload: { text: "fresh retry body" },
    }), runtimeEnv);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    const listed = await listConnectorOutboxJobs({
      connector: "whatsapp",
      tenantId: "tenant-pg",
      state: "pending,failed_retryable",
    }, runtimeEnv);
    assert.equal(listed.backend, "postgres");
    assert.equal(listed.total, 2);

    const claimed = await claimConnectorOutboxJob(first.job.id, { claimant: "pg-worker" }, runtimeEnv);
    assert.equal(claimed.acquired, true);
    assert.equal(claimed.job.claimedBy, "pg-worker");

    const delivered = await markConnectorOutboxJob(claimed.job.id, {
      state: "delivered",
      deliveredAt: new Date().toISOString(),
    }, runtimeEnv);
    assert.equal(delivered.state, "delivered");

    const terminalClaim = await claimConnectorOutboxJob(claimed.job.id, { claimant: "late-worker" }, runtimeEnv);
    assert.equal(terminalClaim.acquired, false);
    assert.equal(terminalClaim.reason, "connector_outbox_delivered");
  } finally {
    __connectorOutboxTestInternals.setPostgresPoolFactory(null);
  }
});
