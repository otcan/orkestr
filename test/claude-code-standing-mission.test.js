import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CODE_FAILED_TURN_NOTICE } from "../packages/core/src/claude-code-client.js";
import {
  CLAUDE_AUTONOMY_MISSION_POLICY,
  sanitizeStandingMissionText,
  standingMissionMaxChars,
} from "../packages/core/src/claude-standing-mission.js";
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
