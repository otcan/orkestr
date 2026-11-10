import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadProviderQuotaProjections, quotaProjectionWindows } from "../packages/core/src/provider-quota-projection.js";
import { emptyProviderQuota, mergeProjectedClaudeQuota, mergeThreadIntoProviderQuota, providerQuotaSnapshot } from "../packages/core/src/provider-quota-snapshot.js";

const owner = "10000000-0000-4000-8000-000000000001", account = "20000000-0000-4000-8000-000000000001";
const now = Date.parse("2099-01-10T12:00:00Z"), hour = 3_600_000;
const record = (used, observed = now, reset = now + hour) => ({ used_percent: used, resets_at: reset / 1000, status: "allowed", observed_at: observed });
const projection = windows => ({ format: "orkestr-provider-quota-v1", provider: "claude", owner_id: owner, account_ref: account, windows });
const binding = { coreOwnerId: owner, accountRef: account };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-quota-projection-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "claude.json"), config = path.join(directory, "sources.json");
  const source = { ownerUserId: "owner-a", ...binding, producerUid: process.getuid(), path: output };
  const save = async value => fs.writeFile(output, JSON.stringify(value), { mode: 0o600 });
  const configure = async (selected = source) => fs.writeFile(config, JSON.stringify({ format: "orkestr-provider-quota-sources-v1", sources: [selected] }), { mode: 0o600 });
  await configure();
  return { directory, output, config, source, save, configure, env: { ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG: config, ORKESTR_ADMIN_USER_ID: "owner-a" } };
}

test("only enrolled owner/account numeric windows enter the unchanged snapshot schema", async t => {
  const f = await fixture(t);
  await f.save(projection({ five_hour: record(23), seven_day: record(41, now, now + 96 * hour) }));
  const snapshot = await providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => [], loadClaudeProfiles: async () => [] }, f.env);
  assert.equal(snapshot.claude.fiveHourRemainingPct, 77);
  assert.equal(snapshot.claude.weeklyRemainingPct, 59);
  assert.equal(snapshot.claude.source, "telemetry");
  assert.equal(snapshot.claude.observedAt, new Date(now).toISOString());
  assert.deepEqual(Object.keys(snapshot.claude).sort(), Object.keys(emptyProviderQuota("claude")).sort());
  assert.deepEqual(await loadProviderQuotaProjections("owner-b", f.env, now), []);
  assert.ok(!JSON.stringify(snapshot).includes(account));
  await f.save({ ...projection({ five_hour: record(1) }), account_ref: owner });
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await f.save({ ...projection({ five_hour: record(1) }), owner_id: account });
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
});

test("fresh five-hour data cannot restamp old weekly usage or be lost to a calling thread", () => {
  const old = now - 7 * hour;
  const windows = quotaProjectionWindows(projection({ five_hour: record(23), seven_day: record(41, old, now + 96 * hour) }), binding, now);
  const quota = mergeProjectedClaudeQuota(emptyProviderQuota("claude"), windows, { now });
  assert.equal(quota.fiveHourRemainingPct, 77);
  assert.equal(quota.weeklyRemainingPct, 59);
  assert.equal(quota.observedAt, new Date(old).toISOString());
  assert.equal(quota.stale, true);
  const thread = { runtimeKind: "claude-code", claudeRateLimitsObservedAt: new Date(old).toISOString(),
    claudeRateLimits: { primary: { used_percent: 90, window_minutes: 300, resets_at: (now + hour) / 1000 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: (now + 96 * hour) / 1000 } } };
  const merged = mergeThreadIntoProviderQuota({ claude: quota, codex: emptyProviderQuota("codex") }, thread, { now });
  assert.equal(merged.claude.fiveHourRemainingPct, 77);
  assert.equal(merged.claude.weeklyRemainingPct, 59);
  assert.equal(merged.claude.observedAt, new Date(old).toISOString());
  assert.equal(merged.claude.stale, true);
});

test("enrolled account never blends legacy thread windows or ambiguous account bindings", async t => {
  const f=await fixture(t);
  await f.save(projection({five_hour:record(23)}));
  const legacy={ownerUserId:"owner-a",runtimeKind:"claude-code",claudeRateLimitsObservedAt:new Date(now).toISOString(),
    claudeRateLimits:{primary:{used_percent:90,window_minutes:300},secondary:{used_percent:1,window_minutes:10080}}};
  const snapshot=await providerQuotaSnapshot({ownerUserId:"owner-a",now,useCache:false,loadThreads:async()=>[legacy],loadClaudeProfiles:async()=>[]},f.env);
  assert.equal(snapshot.claude.fiveHourRemainingPct,77);
  assert.equal(snapshot.claude.weeklyRemainingPct,null);
  const enriched=mergeThreadIntoProviderQuota(snapshot,legacy,{now});
  assert.equal(enriched.claude.fiveHourRemainingPct,77);
  assert.equal(enriched.claude.weeklyRemainingPct,null);
  await fs.writeFile(f.config,JSON.stringify({format:"orkestr-provider-quota-sources-v1",sources:[f.source,{...f.source,accountRef:owner}]}),{mode:0o600});
  assert.deepEqual(await loadProviderQuotaProjections("owner-a",f.env,now),[]);
});

test("absent, expired and status-only windows never invent remaining percentages", () => {
  const values = quotaProjectionWindows(projection({ five_hour: record(null), seven_day: record(40, now, now - hour) }), binding, now);
  const quota = mergeProjectedClaudeQuota(emptyProviderQuota("claude"), values, { now });
  assert.equal(quota.fiveHourRemainingPct, null);
  assert.equal(quota.weeklyRemainingPct, null);
  assert.equal(quota.weeklyResetsAt, null);
  const rejected = quotaProjectionWindows(projection({ five_hour: { ...record(null), status: "rejected" } }), binding, now);
  const limited = mergeProjectedClaudeQuota(emptyProviderQuota("claude"), rejected, { now });
  assert.equal(limited.limited, true);
  assert.equal(limited.fiveHourRemainingPct, null);
  assert.equal(limited.weeklyRemainingPct, null);
});

test("new reset windows win independently, while refreshing file mtime changes no observation", async t => {
  const f = await fixture(t), old = now - 7 * hour;
  await f.save(projection({ five_hour: record(30, old) }));
  await fs.utimes(f.output, new Date(now), new Date(now));
  const windows = await loadProviderQuotaProjections("owner-a", f.env, now);
  const quota = mergeProjectedClaudeQuota(emptyProviderQuota("claude"), windows, { now });
  assert.equal(quota.observedAt, new Date(old).toISOString());
  assert.equal(quota.stale, true);
  const prior = mergeProjectedClaudeQuota(emptyProviderQuota("claude"), quotaProjectionWindows(projection({ five_hour: record(90, now, now + hour) }), binding, now), { now });
  const newerWindow = quotaProjectionWindows(projection({ five_hour: record(10, now - 1000, now + 6 * hour) }), binding, now);
  assert.equal(mergeProjectedClaudeQuota(prior, newerWindow, { now }).fiveHourRemainingPct, 90);
});

test("source failures and unsafe files leave the request successful with unknown quota", async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await f.save(projection({ five_hour: record(30) }));
  await fs.chmod(f.output, 0o644);
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await fs.chmod(f.output, 0o600);
  await f.configure({ ...f.source, producerUid: process.getuid() + 1 });
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await f.configure();
  const alias = path.join(f.directory, "alias.json"); await fs.symlink(f.output, alias);
  await f.configure({ ...f.source, path: alias });
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await fs.unlink(alias); await fs.link(f.output, alias);
  await f.configure();
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  const snapshot = await providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => [], loadClaudeProfiles: async () => [], loadProjections: async () => { throw Error("synthetic source failure"); } }, f.env);
  assert.equal(snapshot.claude.fiveHourRemainingPct, null);
});

test("unknown keys, future observations and model-specific weekly substitutes refuse", () => {
  for (const value of [
    { ...projection({ five_hour: record(20) }), token: "never-read" },
    projection({ seven_day_opus: record(20) }),
    projection({ five_hour: record(20, now + hour) }),
    projection({ five_hour: { ...record(20), raw: "never-read" } }),
    projection({ five_hour: { ...record(20), used_percent: true } }),
  ]) assert.deepEqual(quotaProjectionWindows(value, binding, now), []);
});

test("real Python projector file is consumed by the real Node snapshot reader", async t => {
  const f = await fixture(t);
  const script = "import sys,os;sys.path.insert(0,sys.argv[1]);from claude_quota import QuotaSink,project;QuotaSink(sys.argv[2],sys.argv[3],sys.argv[4],os.getuid())(sys.argv[3],project({'unifiedWindows':{'five_hour':{'utilization':0.23,'resetsAt':float(sys.argv[6])},'seven_day':{'utilization':0.41,'resetsAt':float(sys.argv[7])}}},int(sys.argv[5])))";
  execFileSync("python3", ["-I", "-S", "-B", "-c", script, path.resolve("v2/provider-broker"), f.directory, owner, account, String(now), String((now + hour) / 1000), String((now + 96 * hour) / 1000)], { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  const snapshot = await providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => [], loadClaudeProfiles: async () => [] }, f.env);
  assert.equal(snapshot.claude.fiveHourRemainingPct, 77);
  assert.equal(snapshot.claude.weeklyRemainingPct, 59);
  assert.equal(snapshot.claude.stale, false);
});

test("an enrolled Codex projection replaces aged-out V1 Codex thread telemetry", async t => {
  const f = await fixture(t);
  const codexOutput = path.join(f.directory, "codex.json");
  const codexAccount = "30000000-0000-4000-8000-000000000001";
  const codexSource = { ...f.source, accountRef: codexAccount, path: codexOutput, provider: "codex" };
  await fs.writeFile(f.config, JSON.stringify({ format: "orkestr-provider-quota-sources-v1", sources: [f.source, codexSource] }), { mode: 0o600 });
  await f.save(projection({ five_hour: record(23) }));
  await fs.writeFile(codexOutput, JSON.stringify({ ...projection({ seven_day: record(4, now - hour, now + 96 * hour) }), provider: "codex", account_ref: codexAccount }), { mode: 0o600 });
  // V1 retired its Codex executor: the last thread record is ten hours old.
  const legacy = { ownerUserId: "owner-a", runtimeKind: "codex-app-server", updatedAt: new Date(now - 10 * hour).toISOString(),
    codexRateLimits: { primary: { used_percent: 30, window_minutes: 10080, resets_at: (now + 96 * hour) / 1000 } } };
  const snapshot = await providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => [legacy], loadClaudeProfiles: async () => [] }, f.env);
  assert.equal(snapshot.codex.weeklyRemainingPct, 96);
  assert.equal(snapshot.codex.fiveHourRemainingPct, null);
  assert.equal(snapshot.codex.stale, false);
  assert.equal(snapshot.codex.observedAt, new Date(now - hour).toISOString());
  assert.equal(snapshot.claude.fiveHourRemainingPct, 77);
  assert.ok(!JSON.stringify(snapshot).includes(codexAccount));
  const enriched = mergeThreadIntoProviderQuota(snapshot, legacy, { now });
  assert.equal(enriched.codex.weeklyRemainingPct, 96);
  assert.equal(enriched.codex.stale, false);
});

test("Codex projections must match their provider, account and a unique enrollment", async t => {
  const f = await fixture(t);
  const codexOutput = path.join(f.directory, "codex.json");
  const codexSource = { ...f.source, path: codexOutput, provider: "codex" };
  const configure = sources => fs.writeFile(f.config, JSON.stringify({ format: "orkestr-provider-quota-sources-v1", sources }), { mode: 0o600 });
  // A Claude-format file at the Codex path never becomes Codex quota.
  await fs.writeFile(codexOutput, JSON.stringify(projection({ seven_day: record(4) })), { mode: 0o600 });
  await configure([codexSource]);
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await fs.writeFile(codexOutput, JSON.stringify({ ...projection({ seven_day: record(4) }), provider: "codex" }), { mode: 0o600 });
  const windows = await loadProviderQuotaProjections("owner-a", f.env, now);
  assert.deepEqual(windows.map(entry => [entry.provider, entry.period]), [["codex", "weekly"]]);
  await configure([codexSource, { ...codexSource, accountRef: owner }]);
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  await configure([{ ...codexSource, provider: "openai" }]);
  assert.deepEqual(await loadProviderQuotaProjections("owner-a", f.env, now), []);
  // Without a Codex enrollment, legacy thread telemetry still drives the footer.
  await configure([f.source]);
  const legacy = { ownerUserId: "owner-a", runtimeKind: "codex-app-server", updatedAt: new Date(now).toISOString(),
    codexRateLimits: { primary: { used_percent: 30, window_minutes: 10080, resets_at: (now + 96 * hour) / 1000 } } };
  const snapshot = await providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => [legacy], loadClaudeProfiles: async () => [] }, f.env);
  assert.equal(snapshot.codex.weeklyRemainingPct, 70);
});
