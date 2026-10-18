import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { personalAgentCapability } from "../packages/core/src/personal-agent-capability.js";
import { personalAgentFeature } from "../packages/core/src/personal-agent-feature.js";

const ownerRequest = { orkestrPrincipal: { kind: "user", userId: "owner", role: "admin" } };

test("personalAgentFeature is opt-in and accepts only 1 or true", () => {
  assert.equal(personalAgentFeature({}), false);
  assert.equal(personalAgentFeature({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" }), true);
  assert.equal(personalAgentFeature({ ORKESTR_PERSONAL_AGENT_ENABLED: " TRUE " }), true);
  for (const value of ["", "0", "false", "on", "yes", "2"]) {
    assert.equal(personalAgentFeature({ ORKESTR_PERSONAL_AGENT_ENABLED: value }), false, value);
  }
});

test("capability requires an authenticated admin owner", () => {
  for (const request of [
    {},
    { orkestrAnonymous: true, orkestrPrincipal: ownerRequest.orkestrPrincipal },
    { orkestrMachineAuth: {}, orkestrPrincipal: ownerRequest.orkestrPrincipal },
    { orkestrPrincipal: { kind: "user", userId: "member", role: "user" } },
    { orkestrPrincipal: { kind: "system", userId: "system", role: "admin" } },
  ]) {
    assert.throws(() => personalAgentCapability(request, {}), { statusCode: 403, message: "personal_agent_owner_required" });
  }
});

test("disabled capability returns the stable response without touching storage", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-disabled-"));
  try {
    const result = personalAgentCapability(ownerRequest, { ORKESTR_HOME: home });
    assert.deepEqual(result, {
      enabled: false,
      capability: false,
      reason: "disabled",
      assistant: { available: false, reason: "not_configured" },
    });
    await assert.rejects(fs.stat(path.join(home, "agent-jobs.sqlite")), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(home), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("enabled capability reports storage_unavailable without creating a missing database", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-missing-db-"));
  try {
    assert.deepEqual(personalAgentCapability(ownerRequest, {
      ORKESTR_PERSONAL_AGENT_ENABLED: "true",
      ORKESTR_HOME: home,
    }), {
      enabled: true,
      capability: false,
      reason: "storage_unavailable",
      assistant: { available: false, reason: "not_configured" },
    });
    await assert.rejects(fs.stat(path.join(home, "agent-jobs.sqlite")), { code: "ENOENT" });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("capability is healthy only when both OP-03 tables exist and probe is read-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-ready-"));
  const dbPath = path.join(home, "agent-jobs.sqlite");
  const env = { ORKESTR_PERSONAL_AGENT_ENABLED: "1", ORKESTR_HOME: home };
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("create table personal_agent_projects (id text primary key); create table personal_agent_tasks (id text primary key)");
    db.close();
    const before = await fs.readFile(dbPath);
    assert.deepEqual(personalAgentCapability(ownerRequest, env), {
      enabled: true,
      capability: true,
      assistant: { available: false, reason: "not_configured" },
    });
    assert.deepEqual(await fs.readFile(dbPath), before);

    const incompletePath = path.join(home, "incomplete.sqlite");
    const incomplete = new DatabaseSync(incompletePath);
    incomplete.exec("create table personal_agent_projects (id text primary key)");
    incomplete.close();
    assert.deepEqual(personalAgentCapability(ownerRequest, { ...env, ORKESTR_AGENT_JOBS_DB: incompletePath }), {
      enabled: true,
      capability: false,
      reason: "storage_unavailable",
      assistant: { available: false, reason: "not_configured" },
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("capability endpoint is registered under the Personal Agent module", async () => {
  const [appModule, controller] = await Promise.all([
    fs.readFile(new URL("../apps/server/src/app.module.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/server/src/modules/personal-agent/personal-agent.controller.ts", import.meta.url), "utf8"),
  ]);
  assert.match(appModule, /PersonalAgentModule/);
  assert.match(controller, /@Controller\("api\/personal-agent"\)/);
  assert.match(controller, /@Get\("capability"\)/);
  assert.match(controller, /@Get\("events"\)/);
  assert.match(controller, /personalAgentCapability\(request\)/);
  assert.match(controller, /personalAgentEventFeed\(request, query\)/);
});
