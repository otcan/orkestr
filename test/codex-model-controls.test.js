import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changeCodexModelControls, liveCodexModelCatalog, readCodexModelControls } from "../packages/core/src/codex-model-controls.js";
import { withCodexSettingsLock } from "../packages/core/src/codex-settings-lock.js";
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";
import { persistObservedCodexMetadata } from "../packages/core/src/codex-observed-metadata.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { resolveCodexThreadSettingsCommand } from "../packages/core/src/codex-thread-settings.js";
import { CodexAppServerClient } from "../packages/core/src/codex-app-server-client.js";

const models = [
  { id: "gpt-main", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", null, {}, "invalid", "high"] },
  { id: "gpt-small", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"] },
];
const principal = { kind: "user", userId: "admin", role: "admin" };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-model-controls-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const created = await createThread({ id: "controls-test", name: "Controls test", cwd: home, ownerUserId: "admin", runtimeKind: "codex-app-server", executor: { type: "codex", transport: "codex-app-server" } }, env);
  const thread = await updateThread(created.id, { codexThreadId: "fake-codex", codexModel: "gpt-main", codexReasoningEffort: "medium" }, env);
  const calls = [];
  const client = { async request(method, params, options) { calls.push({ method, params, options }); return method === "model/list" ? { data: models } : {}; } };
  return { thread, env, client, calls };
}

test("live catalog caches short reads, bypasses cache for validation, and sanitizes efforts", async () => {
  let count = 0;
  const client = { request: async () => { count++; return { data: models }; } };
  const first = await liveCodexModelCatalog(client);
  assert.deepEqual(first[0].supportedReasoningEfforts.map((entry) => entry.reasoningEffort), ["low", "medium", "high"]);
  assert.deepEqual(await liveCodexModelCatalog(client), first);
  assert.equal(count, 1);
  await liveCodexModelCatalog(client, { fresh: true });
  assert.equal(count, 2);
});

test("catalog deadline bounds stalled and paginated requests and incomplete results fail closed", async () => {
  const started = Date.now();
  await assert.rejects(liveCodexModelCatalog({ request: () => new Promise(() => {}) }, { timeoutMs: 25 }), /timed out/);
  assert.ok(Date.now() - started < 500);
  let count = 0;
  await assert.rejects(liveCodexModelCatalog({ request: async () => { count++; return { data: models, nextCursor: "more" }; } }), /incomplete/);
  assert.equal(count, 10);
  await assert.rejects(liveCodexModelCatalog({ request: async () => ({ data: [] }) }), /unavailable/);
});

test("effort validates current model and never silently substitutes unavailable model", () => {
  assert.equal(parseThreadInputCommand({ text: "/effort high" }).command, "effort");
  const resolved = resolveCodexThreadSettingsCommand({ command: "effort", text: "high", models, thread: { codexModel: "gpt-main" } });
  assert.deepEqual(resolved.patch, { codexModel: "gpt-main", codexReasoningEffort: "high" });
  for (const text of ["", "high extra", "invalid"]) assert.equal(resolveCodexThreadSettingsCommand({ command: "effort", text, models }).ok, false);
  assert.equal(resolveCodexThreadSettingsCommand({ command: "effort", text: "high", models, thread: { codexModel: "missing" } }).ok, false);
  assert.equal(resolveCodexThreadSettingsCommand({ command: "effort", text: "high", models, thread: { codexModel: "gpt-small" } }).ok, false);
});

test("owner API and chat changes serialize, reload latest model, and persist against observations", async (t) => {
  const { thread, env, client, calls } = await fixture(t);
  const first = changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env);
  const second = changeCodexModelControls(thread, { authorized: true, client, command: "effort", text: "high" }, env);
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false); // validates the fresh small model, not the stale main model
  assert.equal(calls.filter((call) => call.method === "thread/settings/update").length, 1);
  await persistObservedCodexMetadata(thread.id, { codexModel: "gpt-main", codexReasoningEffort: "high" }, env);
  const current = await getThread(thread.id, env);
  assert.equal(current.codexModel, "gpt-small");
  assert.equal(current.executor.metadata.codexModel, "gpt-small");
  assert.equal(current.codexReasoningEffort, "low");
  assert.equal(current.codexSettingsUncertain, null);
  assert.ok(current.codexModelUpdatedAt);
  assert.ok(calls.every((call) => call.options.timeoutMs > 0 && call.options.timeoutMs <= 5000));
});

test("authorization, policy, runtime and invalid settings leave state unchanged with no mutation RPC", async (t) => {
  const { thread, env, client, calls } = await fixture(t);
  const before = await getThread(thread.id, env);
  await assert.rejects(changeCodexModelControls(thread, { client, text: "gpt-small low" }, env), /Only a thread owner/);
  await assert.rejects(changeCodexModelControls(thread, { principal: { userId: "other" }, client, text: "gpt-small low" }, env), /forbidden/);
  await assert.rejects(readCodexModelControls(thread, { userId: "other" }, env, client), /forbidden/);
  assert.equal((await changeCodexModelControls(thread, { principal, client, text: "gpt-small high" }, env)).ok, false);
  assert.equal((await changeCodexModelControls(thread, { principal, client, text: "default high" }, env)).ok, false);
  assert.equal((await changeCodexModelControls(thread, { principal, client, text: "status high" }, env)).ok, false);
  assert.deepEqual(await getThread(thread.id, env), before);
  const raw = await updateThread(thread.id, { runtimeKind: "raw-terminal", executor: { type: "raw-terminal", transport: "raw-terminal" } }, env);
  assert.equal((await readCodexModelControls(raw, principal, env, client)).readOnly, true);
  await assert.rejects(changeCodexModelControls(raw, { principal, client, text: "gpt-small low" }, env), /read-only/);
  const contained = await updateThread(thread.id, { ownerUserId: "contained-user", runtimeKind: "codex-app-server" }, env);
  await assert.rejects(changeCodexModelControls(contained, { principal, client, text: "gpt-small low" }, env), /tenant policy/);
  assert.equal((await readCodexModelControls(contained, principal, env, client)).readOnly, true);
  assert.equal(calls.filter((call) => call.method === "thread/settings/update").length, 0);
});

test("unacknowledged mutation stays uncertain on reload and blocks repeat mutations", async (t) => {
  const { thread, env, client, calls } = await fixture(t);
  const original = client.request;
  client.request = async (...args) => { const value = await original(...args); if (args[0] === "thread/settings/update") throw Error("private transport detail"); return value; };
  await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env), /Could not confirm/);
  const pending = await getThread(thread.id, env);
  assert.equal(pending.codexModel, "gpt-main");
  assert.equal(pending.codexSettingsUncertain, true);
  assert.deepEqual(pending.codexSettingsPending.expected, { model: "gpt-small", effort: "low" });
  const reload = await readCodexModelControls(pending, principal, env, client);
  assert.equal(reload.readOnly, true);
  assert.match(reload.readOnlyReason, /unconfirmed/);
  const status = await changeCodexModelControls(thread, { authorized: true, client, text: "" }, env);
  assert.equal(status.action, "status");
  assert.match(status.replyText, /unconfirmed/);
  await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-main high" }, env), /unconfirmed/);
  assert.equal(calls.filter((call) => call.method === "thread/settings/update").length, 1);
});

for (const [code, message, expected] of [
  [-32600, "thread not found: private-generation", /Resume the thread/],
  [-32601, "unknown method", /does not support/],
  [-32602, "invalid model with private detail", /rejected these model settings/],
]) test(`correlated rejection ${code} leaves settings unchanged and permits retry`, async (t) => {
  const { thread, env, client } = await fixture(t);
  const original = client.request;
  client.request = async (...args) => {
    if (args[0] === "thread/settings/update") throw Object.assign(Error(message), { code, codexRpcMethod: args[0] });
    return original(...args);
  };
  await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env), (error) => {
    assert.equal(error.statusCode, 422);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  const current = await getThread(thread.id, env);
  assert.equal(current.codexModel, "gpt-main");
  assert.equal(current.codexReasoningEffort, "medium");
  assert.equal(current.codexSettingsUncertain, null);
  assert.equal(current.codexSettingsPending, null);
  assert.equal((await readCodexModelControls(current, principal, env, client)).readOnly, false);
  const events = await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /private-generation|private detail/);
  assert.ok(events.split("\n").filter(Boolean).map(JSON.parse).some(e => e.type === "codex_model_controls" && e.outcome === "rejected" && e.rpcCode === code));
  client.request = original;
  assert.equal((await changeCodexModelControls(current, { principal, client, text: "gpt-small low" }, env)).ok, true);
});

for (const error of [
  Object.assign(Error("internal error"), { code: -32603, codexRpcMethod: "thread/settings/update" }),
  Object.assign(Error("not a correlated RPC"), { code: -32602 }),
  Object.assign(Error("wrong RPC"), { code: -32602, codexRpcMethod: "thread/read" }),
  Error("codex_app_server_timeout:thread/settings/update"),
]) test(`non-definitive failure remains guarded: ${error.message}`, async (t) => {
  const { thread, env, client } = await fixture(t);
  const original = client.request;
  client.request = async (...args) => { if (args[0] === "thread/settings/update") throw error; return original(...args); };
  await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env), /Could not confirm/);
  const current = await getThread(thread.id, env);
  assert.equal(current.codexSettingsUncertain, true);
  assert.equal(current.codexModel, "gpt-main");
  assert.ok(current.codexSettingsPending.failureKind);
  assert.ok(current.codexSettingsPending.startedAt);
  assert.deepEqual(current.codexSettingsPending.patch, { codexModel: "gpt-small", codexReasoningEffort: "low" });
});

for (const replacement of [{ codexThreadId: "new-generation" }, { ownerUserId: "new-owner" }, { codexSettingsPending: { id: "new-operation" } }]) {
  test(`rejection cannot clear a changed operation: ${Object.keys(replacement)[0]}`, async (t) => {
    const { thread, env, client } = await fixture(t);
    const original = client.request;
    client.request = async (...args) => {
      if (args[0] !== "thread/settings/update") return original(...args);
      await updateThread(thread.id, replacement, env);
      throw Object.assign(Error("rejected"), { code: -32602, codexRpcMethod: args[0] });
    };
    await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env), /thread changed/);
    const current = await getThread(thread.id, env);
    assert.equal(current.codexSettingsUncertain, true);
    assert.equal(current.codexModel, "gpt-main");
  });
}

test("wire client marks only correlated RPC errors, not transport failures", async () => {
  const client = new CodexAppServerClient({ env: {} });
  client.write = () => {};
  const request = client.request("thread/settings/update", { threadId: "fake" });
  client.handleLine(JSON.stringify({ id: 1, error: { code: -32600, message: "thread not found: fake" } }));
  await assert.rejects(request, error => error.codexRpcMethod === "thread/settings/update" && error.code === -32600);
  client.closed = true;
  await assert.rejects(client.request("thread/settings/update"), error => !error.codexRpcMethod);
});

test("settings audit includes latency and bounded outcome labels without model/thread metric labels", async (t) => {
  const { thread, env, client } = await fixture(t);
  resetObservabilityForTests();
  await changeCodexModelControls(thread, { principal, client, text: "missing" }, env);
  await readCodexModelControls(thread, principal, env, client);
  const metrics = renderOpenMetrics(env);
  assert.match(metrics, /orkestr_model_controls_total\{operation="settings",outcome="invalid"\}/);
  assert.match(metrics, /orkestr_model_controls_duration_seconds/);
  for (const line of metrics.split("\n").filter((line) => line.startsWith("orkestr_model_controls"))) {
    assert.doesNotMatch(line, /controls-test|gpt-main|fake-codex|threadId|model=/);
  }
  const events = await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8");
  const audit = events.split("\n").filter(Boolean).map(JSON.parse).filter((event) => event.type === "codex_model_controls");
  assert.ok(audit.some((event) => event.outcome === "invalid" && Number.isFinite(event.durationMs)));
});

test("runtime replacement while settings RPC is in flight cannot confirm settings for the new generation", async (t) => {
  const { thread, env, client } = await fixture(t);
  const original = client.request;
  client.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === "thread/settings/update") await updateThread(thread.id, { codexThreadId: "replacement-codex" }, env);
    return result;
  };
  await assert.rejects(changeCodexModelControls(thread, { principal, client, text: "gpt-small low" }, env), /runtime changed/);
  const current = await getThread(thread.id, env);
  assert.equal(current.codexThreadId, "replacement-codex");
  assert.equal(current.codexModel, "gpt-main");
  assert.equal(current.codexSettingsUncertain, true);
});

test("settings storage lock serializes independent callers", async (t) => {
  const { env } = await fixture(t);
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 3 }, () => withCodexSettingsLock("shared-model-lock", env, async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  })));
  assert.equal(maxActive, 1);
});

test("settings lock serializes separate API and connector processes", async (t) => {
  const { env } = await fixture(t);
  const source = `
    import { withCodexSettingsLock } from ${JSON.stringify(new URL("../packages/core/src/codex-settings-lock.js", import.meta.url).href)};
    import { appendFile } from 'node:fs/promises';
    const env = { ORKESTR_HOME: process.argv[1] };
    for (let index = 0; index < 3; index++) await withCodexSettingsLock('shared', env, async () => {
      await appendFile(process.argv[2], process.pid + ':start\\n');
      await new Promise(resolve => setTimeout(resolve, 10));
      await appendFile(process.argv[2], process.pid + ':end\\n');
    });
  `;
  const log = path.join(env.ORKESTR_HOME, "process-lock.log");
  await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, env.ORKESTR_HOME, log], { env: { PATH: process.env.PATH }, timeout: 10000 })));
  const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 12);
  for (let index = 0; index < lines.length; index += 2) assert.equal(lines[index + 1], lines[index].replace(":start", ":end"));
});

test("WebUI model controls mount only in open overlay with supported choices and bounded requests", async () => {
  const root = new URL("../apps/web/src/app/", import.meta.url);
  const template = await fs.readFile(new URL("app.component.html", root), "utf8");
  const component = await fs.readFile(new URL("model-settings.component.ts", root), "utf8");
  assert.ok(template.indexOf("@if (modelDetailsOpen)") < template.indexOf("<app-model-settings"));
  assert.match(component, /settings && !settings.readOnly/);
  assert.match(component, /supportedReasoningEfforts/);
  assert.match(component, /timeout\(7000\)/);
  assert.match(component, /timeout\(20000\)/);
  assert.match(component, /ngOnDestroy\(\).*unsubscribe/);
  assert.match(component, /reloadRequired/);
  assert.match(component, /min-height: 44px/);
});
