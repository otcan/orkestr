// get_provider_quotas through the bridge grant checks and the real quota
// snapshot, reading a synthetic enrolled projection source (the same file
// boundary the V2 provider broker writes). No real accounts or quota values.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUser } from "../packages/core/src/users.js";
import { setUserOnboardingState } from "../packages/core/src/user-onboarding.js";
import { callThreadBridgeTool } from "../packages/core/src/thread-bridge-mcp.js";
import { bridgeProviderQuotas } from "../packages/core/src/thread-bridge-quota.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const CORE_OWNER = "10000000-0000-4000-8000-0000000000a1";
const CLAUDE_ACCOUNT = "20000000-0000-4000-8000-0000000000b1";
const CODEX_ACCOUNT = "20000000-0000-4000-8000-0000000000b2";
const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  scopes: ["threads:read"] };
const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth", enabled: true,
  expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all" };
const minute = 60_000, hour = 60 * minute, day = 24 * hour;

const window = (used, { observed = Date.now() - minute, reset = Date.now() + hour, status = null } = {}) =>
  ({ used_percent: used, resets_at: reset / 1000, status, observed_at: Math.round(observed) });
const projection = (provider, account, windows) => ({ format: "orkestr-provider-quota-v1", provider, owner_id: CORE_OWNER, account_ref: account, windows });

async function fixture(t, grantOverride = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bridge-quota-"));
  const sources = path.join(home, "quota-sources.json");
  const files = { claude: path.join(home, "claude.json"), codex: path.join(home, "codex.json") };
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG: sources, ORKESTR_PROVIDER_QUOTA_CACHE_MS: "0" };
  const grants = path.join(home, "thread-bridge-grants.json");
  await fs.writeFile(grants, JSON.stringify([{ ...grant, ...grantOverride }]));
  await fs.writeFile(sources, JSON.stringify({ format: "orkestr-provider-quota-sources-v1", sources: [
    { ownerUserId: "owner-a", coreOwnerId: CORE_OWNER, accountRef: CLAUDE_ACCOUNT, producerUid: process.getuid(), path: files.claude },
    { ownerUserId: "owner-a", coreOwnerId: CORE_OWNER, accountRef: CODEX_ACCOUNT, producerUid: process.getuid(), path: files.codex, provider: "codex" },
  ] }), { mode: 0o600 });
  await createUser({ id: "owner-a" }, env);
  t.after(async () => { await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const save = (provider, windows) => fs.writeFile(files[provider], JSON.stringify(projection(provider, provider === "codex" ? CODEX_ACCOUNT : CLAUDE_ACCOUNT, windows)), { mode: 0o600 });
  return { env, home, grants, sources, files, save };
}

const providerOf = (report, name) => report.providers.find((entry) => entry.provider === name);
const windowOf = (entry, name) => entry.windows.find((item) => item.window === name);

test("MCP get_provider_quotas reads the owner's enrolled projection: fresh, missing, stale and expired windows", async (t) => {
  const f = await fixture(t);
  await setUserOnboardingState("owner-a", { profile: { timezone: "Europe/Berlin" } }, f.env);
  const now = Date.now();
  await f.save("codex", { seven_day: window(21, { reset: now + 5 * day }) });
  await f.save("claude", {
    five_hour: window(7, { observed: now - 17 * day, reset: now - 16 * day, status: "allowed" }),
    seven_day: window(30, { observed: now - 7 * hour, reset: now + 3 * day, status: "allowed" }),
  });
  const result = await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const report = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), report);
  assert.equal(report.available, true);
  assert.equal(report.timezone.name, "Europe/Berlin");

  const codex = providerOf(report, "codex");
  assert.equal(codex.source, "account_projection");
  assert.deepEqual([windowOf(codex, "weekly").state, windowOf(codex, "weekly").usedPercent, windowOf(codex, "weekly").remainingPercent], ["current", 21, 79]);
  assert.match(windowOf(codex, "weekly").resetsAtLocal, /[+-]\d{2}:\d{2}$/);
  assert.equal(windowOf(codex, "five_hour").state, "not_reported");

  const claude = providerOf(report, "claude");
  assert.equal(windowOf(claude, "five_hour").state, "expired");
  assert.equal(windowOf(claude, "weekly").state, "stale");
  assert.equal(windowOf(claude, "weekly").remainingPercent, null);
  assert.equal(windowOf(claude, "weekly").lastObserved.remainingPercent, 70);
  assert.equal(claude.state, "stale");
  assert.deepEqual(claude.warnings.map((warning) => warning.code), ["window_expired", "stale_observation"]);

  const filtered = (await callThreadBridgeTool("get_provider_quotas", { provider: "codex" }, principal, f.env)).structuredContent;
  assert.deepEqual(filtered.providers.map((entry) => entry.provider), ["codex"]);
  const invalid = await callThreadBridgeTool("get_provider_quotas", { provider: "openai-api" }, principal, f.env);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /invalid_arguments/);
});

test("no enrolled source or projection file reads as unknown, never as free quota", async (t) => {
  const f = await fixture(t);
  const report = (await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env)).structuredContent;
  assert.equal(report.available, true);
  for (const entry of report.providers) {
    assert.equal(entry.state, "unknown");
    assert.ok(entry.windows.every((item) => item.state === "not_reported" && item.remainingPercent === null));
    assert.deepEqual(entry.warnings.map((warning) => warning.code), ["no_observation"]);
  }
  await fs.rm(f.sources);
  assert.equal(providerOf((await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env)).structuredContent, "codex").state, "unknown");
});

test("the report never carries account references, owner ids, source paths, grants or credentials", async (t) => {
  const f = await fixture(t);
  await f.save("codex", { five_hour: window(10), seven_day: window(20, { reset: Date.now() + day }) });
  await f.save("claude", { five_hour: window(30, { status: "allowed_warning" }), seven_day: window(40, { reset: Date.now() + day, status: "allowed" }) });
  const result = await callThreadBridgeTool("get_provider_quotas", {}, principal, { ...f.env, ORKESTR_THREAD_BRIDGE_TOKEN: "synthetic-secret-token" });
  const text = JSON.stringify(result);
  for (const secret of [CORE_OWNER, CLAUDE_ACCOUNT, CODEX_ACCOUNT, f.home, f.sources, f.files.claude, "grant-a", "agent-a", "owner-a", "synthetic-secret-token", "account_ref", "owner_id"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  const keys = (value) => (value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => [Array.isArray(value) ? null : key, ...keys(child)]) : []).filter(Boolean);
  const allowed = new Set(["format", "generatedAt", "timezone", "name", "source", "staleAfterSeconds", "kind", "providerContacted", "sharedWith", "notes",
    "available", "reason", "snapshotGeneratedAt", "providers", "provider", "allowanceType", "state", "newestObservedAt", "windows", "window",
    "durationMinutes", "usedPercent", "remainingPercent", "unit", "providerStatus", "resetsAt", "resetsAtLocal", "resetsInSeconds", "observedAt",
    "ageSeconds", "lastObserved", "modelSpecificWindows", "apiCredits", "balance", "warnings", "blockers", "code", "message", "until", "evidence"]);
  assert.deepEqual([...new Set(keys(result.structuredContent))].filter((key) => !allowed.has(key)), []);
});

test("only a grant that observes all of the owner's threads may read quota; no new scope is accepted or needed", async (t) => {
  const f = await fixture(t, { observe: ["thread-a"] });
  const narrowed = await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env);
  assert.equal(narrowed.isError, true);
  assert.match(narrowed.content[0].text, /bridge_quota_not_granted/);
  await fs.writeFile(f.grants, JSON.stringify([grant]));
  const noRead = await callThreadBridgeTool("get_provider_quotas", {}, { ...principal, scopes: ["threads:comment", "threads:message"] }, f.env);
  assert.match(noRead.content[0].text, /insufficient_scope/);
  await fs.writeFile(f.grants, JSON.stringify([{ ...grant, enabled: false }]));
  assert.match((await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env)).content[0].text, /bridge_grant_revoked/);
  await fs.writeFile(f.grants, JSON.stringify([{ ...grant, ownerUserId: "owner-b" }]));
  assert.match((await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env)).content[0].text, /bridge_grant_revoked/);
  await fs.writeFile(f.grants, JSON.stringify([grant]));
  assert.match((await callThreadBridgeTool("get_provider_quotas", {}, principal, { ...f.env, ORKESTR_THREAD_BRIDGE_ENABLED: "0" })).content[0].text, /thread_bridge_disabled/);
  assert.equal((await callThreadBridgeTool("get_provider_quotas", {}, principal, f.env)).isError, undefined);
});

test("the snapshot is read for the grant's owner only, bounded, and re-authorized after the read", async (t) => {
  const f = await fixture(t);
  const owners = [];
  const snapshot = { codex: null, claude: null, staleAfterMs: 21_600_000, generatedAt: new Date().toISOString() };
  await bridgeProviderQuotas({ ...principal, ownerUserId: "owner-a" }, {}, f.env, { loadSnapshot: async ({ ownerUserId }) => { owners.push(ownerUserId); return snapshot; } });
  assert.deepEqual(owners, ["owner-a"]);

  const started = Date.now();
  const slow = await bridgeProviderQuotas(principal, {}, f.env, { timeoutMs: 30, loadSnapshot: () => new Promise(() => {}), loadTimezone: async () => "Europe/Berlin" });
  assert.ok(Date.now() - started < 2000);
  assert.equal(slow.available, false);
  assert.equal(slow.reason, "quota_snapshot_timeout");
  assert.equal(slow.timezone.name, "Europe/Berlin");
  assert.ok(slow.providers.every((entry) => entry.state === "unavailable"));

  const broken = await bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: async () => { throw new Error("synthetic source failure"); } });
  assert.equal(broken.reason, "quota_snapshot_unavailable");
  assert.ok(!JSON.stringify(broken).includes("synthetic source failure"));

  // An unreadable owner profile is explicit, not mistaken for "no zone set".
  const hangingZone = await bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: async () => snapshot, loadTimezone: () => new Promise(() => {}) });
  assert.equal(hangingZone.available, true);
  assert.deepEqual(hangingZone.timezone, { name: "UTC", source: "unavailable" });
  const brokenZone = await bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: async () => snapshot, loadTimezone: async () => { throw new Error("synthetic"); } });
  assert.deepEqual(brokenZone.timezone, { name: "UTC", source: "unavailable" });
  const noZone = await bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: async () => snapshot });
  assert.deepEqual(noZone.timezone, { name: "UTC", source: "default" }, "the real profile read: owner without a zone");

  // Revoked while the snapshot was being read: nothing is returned.
  const revoking = async () => { await fs.writeFile(f.grants, JSON.stringify([{ ...grant, enabled: false }])); return snapshot; };
  await assert.rejects(bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: revoking }), /bridge_grant_revoked/);
  await fs.writeFile(f.grants, JSON.stringify([grant]));
  const narrowing = async () => { await fs.writeFile(f.grants, JSON.stringify([{ ...grant, observe: ["thread-a"] }])); return snapshot; };
  await assert.rejects(bridgeProviderQuotas(principal, {}, f.env, { loadSnapshot: narrowing }), /bridge_quota_not_granted/);
});
