import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CODE_FAILED_TURN_NOTICE } from "../packages/core/src/claude-code-client.js";
import {
  CLAUDE_AUTONOMY_MISSION_POLICY,
  CLAUDE_AUTONOMY_TICK_PROMPT,
  resolveStandingMissionAppendText,
  sanitizeStandingMissionText,
  standingMissionMaxChars,
} from "../packages/core/src/claude-standing-mission.js";
import { setThreadAgentReleaseRole } from "../packages/core/src/agent-release-role.js";
import { agentReleaseRolePolicy } from "../packages/core/src/agent-release-role-policy.js";
import {
  clearThreadStandingMission,
  getThreadStandingMission,
  setThreadStandingMission,
} from "../packages/core/src/claude-standing-mission-admin.js";
import {
  deliverClaudeCodePendingInputs,
  resetClaudeCodeRuntimeForTest,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { createThread, enqueueThreadInput, getThread } from "../packages/core/src/threads.js";

async function fixture(t, name = "standing-mission") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-claude-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ authenticated: true, status: "logged_in" }) + "\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const resumed = resumeAt >= 0 ? args[resumeAt + 1] : "";
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt: prompt.trim() }) + "\\n");
  if (prompt.includes("expired auth")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: resumed, is_error: true, result: "Failed to authenticate. API Error: 401" }) + "\\n");
    process.exit(1);
  }
  const session = resumed || "claude_session_fixture";
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "draft" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: session, model: "claude-sonnet-fixture", result: "Reply: " + prompt.trim(), is_error: false }) + "\\n");
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
  };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { home, fake, calls, env };
}

async function readyProfile(ownerUserId, label, env) {
  const created = await createLlmAccountProfile(ownerUserId, { provider: "claude-code", label, authMode: "subscription" }, env);
  await updateLlmAccountProfileState(ownerUserId, created.id, "ready", { verified: true }, env);
  return created;
}

async function claudeThread(ownerUserId, profileId, env, id = "claude-mission-thread") {
  env.ORKESTR_ADMIN_USER_ID = ownerUserId;
  const thread = await createThread({
    id,
    name: `Claude mission fixture ${id}`,
    ownerUserId,
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profileId, metadata: { accountProfileId: profileId, runtimeKind: "claude-code" } },
  }, env);
  return (await startClaudeCodeThread(thread, env)).thread;
}

async function recordedAppendSystemPrompts(calls) {
  const recorded = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  return recorded.map((call) => {
    const at = call.args.indexOf("--append-system-prompt");
    return at >= 0 ? call.args[at + 1] : null;
  });
}

test("standing mission text is capped and trimmed before it is ever persisted", () => {
  const max = standingMissionMaxChars();
  const oversized = "x".repeat(max + 500);
  assert.equal(sanitizeStandingMissionText(oversized).length, max);
  assert.equal(sanitizeStandingMissionText("  keep only unowned backlog work  "), "keep only unowned backlog work");
  assert.equal(sanitizeStandingMissionText(""), "");
});

test("standing mission admin set/get/clear validates, caps, and persists", async (t) => {
  const { env } = await fixture(t, "admin-crud");
  const profile = await readyProfile("owner", "Primary", env);
  const thread = await claudeThread("owner", profile.id, env);

  const empty = await getThreadStandingMission(thread.id, env);
  assert.equal(empty.standingMission, null);

  await assert.rejects(setThreadStandingMission(thread.id, "   ", "admin", env), /standing_mission_required/);

  const max = standingMissionMaxChars(env);
  const set = await setThreadStandingMission(thread.id, `${"work item ".repeat(1000)}`, "admin", env);
  assert.equal(set.standingMission.length <= max, true);
  assert.equal(set.standingMissionUpdatedBy, "admin");
  assert.ok(set.standingMissionUpdatedAt);

  const fetched = await getThreadStandingMission(thread.id, env);
  assert.equal(fetched.standingMission, set.standingMission);

  const cleared = await clearThreadStandingMission(thread.id, "admin", env);
  assert.equal(cleared.standingMission, null);
});

test("Claude turns without a standing mission behave exactly as before (no append-system-prompt)", async (t) => {
  const { calls, env } = await fixture(t, "no-mission");
  const profile = await readyProfile("owner", "Primary", env);
  const thread = await claudeThread("owner", profile.id, env);
  await enqueueThreadInput(thread.id, { text: "plain request", source: "test" }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  assert.deepEqual(await recordedAppendSystemPrompts(calls), [null]);
});

test("CLAUDE_AUTONOMY_MISSION_POLICY requires explicit current-conversation authorization before a worker may push any branch", () => {
  const [permitted, denied] = CLAUDE_AUTONOMY_MISSION_POLICY.split(/(?=Denied:)/);
  // Local work is still permitted, but never framed as an implicit push grant.
  assert.match(permitted, /commit changes, locally only, to this worker's own stored branch/);
  assert.doesNotMatch(permitted, /\bpush\b/i);
  // Normal Orkestr-routed replies are explicitly not an external message --
  // the Moteks incident's false "I cannot send WhatsApp" claim was wrong.
  assert.match(permitted, /Orkestr automatically routes these to the bound connector, which is not sending an external message and is always allowed/);
  // The pre-existing "Denied: merging, rebasing, or pushing main" substring
  // must still lead the Denied clause unchanged -- the release-role-switch
  // regression test below asserts on this exact text.
  assert.match(denied, /^Denied: merging, rebasing, or pushing main or any release branch;/);
  // Pushing -- including the worker's own branch -- is denied by default and
  // requires the user's explicit, in-conversation authorization for that
  // exact push.
  assert.match(denied, /pushing this worker's own branch, or any other branch, without the user explicitly authorizing that exact push in the current conversation/);
  // A scheduled tick can take bounded local work but can never itself unlock a push.
  assert.match(denied, /scheduled timer or autonomy tick may take at most one bounded, local-commit-only step and report status, but must never by itself authorize a push of any branch/);
});

test("CLAUDE_AUTONOMY_TICK_PROMPT keeps autonomy ticks local-commit-only and never itself authorizes a push", () => {
  assert.match(CLAUDE_AUTONOMY_TICK_PROMPT, /test, and commit locally, only to your own branch/);
  assert.match(CLAUDE_AUTONOMY_TICK_PROMPT, /Do not push any branch -- an autonomy tick can never itself authorize a push; only the user, explicitly, in a live conversation, can\./);
  assert.match(CLAUDE_AUTONOMY_TICK_PROMPT, /that reply is normal Orkestr-routed output, not sending an external message/);
  assert.doesNotMatch(CLAUDE_AUTONOMY_TICK_PROMPT, /commit, and push/);
});

test("mission composition delivers the corrected local-commit-only worker policy end-to-end, and release-train promotion is unaffected", async (t) => {
  const { calls, env } = await fixture(t, "push-authorization-composition");
  const profile = await readyProfile("owner", "Primary", env);
  let thread = await claudeThread("owner", profile.id, env, "push-authorization-worker");
  await setThreadStandingMission(thread.id, "Keep the backlog board green.", "admin", env);
  thread = await getThread(thread.id, env);

  await enqueueThreadInput(thread.id, { text: "do the safe thing", source: "test" }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  const [workerNotice] = await recordedAppendSystemPrompts(calls);
  assert.ok(workerNotice.includes(CLAUDE_AUTONOMY_MISSION_POLICY));
  assert.match(workerNotice, /pushing this worker's own branch, or any other branch, without the user explicitly authorizing that exact push in the current conversation/);
  assert.match(workerNotice, /Orkestr automatically routes these to the bound connector, which is not sending an external message/);
  assert.ok(workerNotice.includes("Standing mission: Keep the backlog board green."));

  // Promoting to release_train still fully replaces the worker text with the
  // stronger, unmodified release-train policy -- this fix must not touch or
  // weaken agent-release-role-policy.js's release-train gates.
  await setThreadAgentReleaseRole(thread.id, "release_train", { actorUserId: "admin" }, env);
  thread = await getThread(thread.id, env);
  const releaseTrainPolicy = agentReleaseRolePolicy(thread);
  assert.equal(releaseTrainPolicy.requiresExplicitPhaseRequest, true);
  assert.equal(releaseTrainPolicy.canPushMain, true);
  assert.match(releaseTrainPolicy.promptText, /only when the user has explicitly requested that specific release phase in the current conversation/);
  const switchedNotice = resolveStandingMissionAppendText(thread, env);
  assert.doesNotMatch(switchedNotice, /pushing this worker's own branch/);
  assert.match(switchedNotice, /Rules \(release train role/);
});

test("Claude standing mission is delivered on the first turn and again on a resumed turn", async (t) => {
  const { calls, env } = await fixture(t, "every-turn");
  const profile = await readyProfile("owner", "Primary", env);
  let thread = await claudeThread("owner", profile.id, env);
  await setThreadStandingMission(thread.id, "Keep the backlog board green.", "admin", env);
  thread = await getThread(thread.id, env);

  for (const text of ["first turn", "second turn"]) {
    await enqueueThreadInput(thread.id, { text, source: "test" }, env);
    await deliverClaudeCodePendingInputs(thread, env);
    thread = await getThread(thread.id, env);
  }

  const notices = await recordedAppendSystemPrompts(calls);
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.ok(notice, "expected a standing mission on every turn");
    assert.ok(notice.includes(CLAUDE_AUTONOMY_MISSION_POLICY));
    assert.ok(notice.includes("Standing mission: Keep the backlog board green."));
    assert.equal(notice.includes(CLAUDE_CODE_FAILED_TURN_NOTICE), false);
  }
});

test("an existing Claude worker switches its per-turn system policy after an audited release-role update", async (t) => {
  const { calls, env } = await fixture(t, "release-role-switch");
  const profile = await readyProfile("owner", "Primary", env);
  let thread = await claudeThread("owner", profile.id, env, "existing-release-worker");
  await setThreadStandingMission(thread.id, "Maintain the Features release train.", "admin", env);

  thread = await getThread(thread.id, env);
  assert.match(resolveStandingMissionAppendText(thread, env), /Denied: merging, rebasing, or pushing main/);
  await enqueueThreadInput(thread.id, { text: "prepare only", source: "test" }, env);
  await deliverClaudeCodePendingInputs(thread, env);

  await setThreadAgentReleaseRole(thread.id, "release_train", { actorUserId: "admin" }, env);
  thread = await getThread(thread.id, env);
  const switched = resolveStandingMissionAppendText(thread, env);
  assert.match(switched, /Rules \(release train role/);
  assert.match(switched, /only when the user has explicitly requested that specific release phase/);
  assert.match(switched, /scheduled timer or autonomy tick.*must never by itself authorize/);
  assert.doesNotMatch(switched, /Denied: merging, rebasing, or pushing main/);

  await enqueueThreadInput(thread.id, { text: "report readiness", source: "test" }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  const notices = await recordedAppendSystemPrompts(calls);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /Denied: merging, rebasing, or pushing main/);
  assert.match(notices[1], /Rules \(release train role/);
  assert.doesNotMatch(notices[1], /Denied: merging, rebasing, or pushing main/);
  const recorded = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(recorded[0].args.includes("--resume"), false);
  assert.equal(recorded[1].args.includes("--resume"), false, "trusted role changes must rotate the Claude session");
});

test("Claude standing mission coexists with the failed-turn notice without replacing it", async (t) => {
  const { calls, env } = await fixture(t, "mission-and-failed-turn");
  const profile = await readyProfile("owner", "Primary", env);
  let thread = await claudeThread("owner", profile.id, env);
  await setThreadStandingMission(thread.id, "Ship the safe backlog item.", "admin", env);
  thread = await getThread(thread.id, env);

  for (const text of ["first request", "expired auth probe", "replacement request"]) {
    await enqueueThreadInput(thread.id, { text, source: "test" }, env);
    await deliverClaudeCodePendingInputs(thread, env).catch(() => {});
    if (text === "expired auth probe") await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
    thread = await getThread(thread.id, env);
  }

  const notices = await recordedAppendSystemPrompts(calls);
  assert.equal(notices.length, 3);
  // Every turn keeps the standing mission.
  for (const notice of notices) assert.ok(notice.includes("Standing mission: Ship the safe backlog item."));
  // Only the turn immediately after the failure also carries the void notice.
  assert.equal(notices[0].includes(CLAUDE_CODE_FAILED_TURN_NOTICE), false);
  assert.equal(notices[1].includes(CLAUDE_CODE_FAILED_TURN_NOTICE), false);
  assert.equal(notices[2].includes(CLAUDE_CODE_FAILED_TURN_NOTICE), true);
});
