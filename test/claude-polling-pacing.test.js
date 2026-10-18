import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claudeCodeArgs } from "../packages/core/src/claude-code-client.js";
import { claudePollingDecision, literalShellSleepSeconds, pollingSleepLimit } from "../packages/core/src/shell-poll-delay.js";

test("CI polling rejects long literal sleeps before the command starts", () => {
  for (const command of [
    "sleep 270; gh run view 123 --json status,conclusion",
    "git status --short; sleep 200; gh pr checks 12",
    "sleep 2.5m && gh run view 123",
    "command /usr/bin/sleep 20 20",
    "for i in 1 2; do sleep 2m; done",
  ]) {
    const decision = claudePollingDecision({ tool_name: "Bash", tool_input: { command } });
    assert.equal(decision?.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Check the job or CI status now/);
  }
});

test("pacing leaves builds, short polls and quoted script contents alone", () => {
  for (const command of [
    "npm run build && npm test", "sleep 30; gh run view 123", "sleep .5",
    "printf '%s' 'sleep 270; gh run view 123'", 'echo "sleep 400"',
    "rg 'sleep 270' test", "# sleep 120\nnpm test", "sleep $delay",
    "cat <<'EOF' > fixture.sh\nsleep 270\nEOF",
    "python3 -c 'import time; time.sleep(400)'",
  ]) assert.equal(claudePollingDecision({ tool_name: "Bash", tool_input: { command } }), null, command);
  assert.equal(claudePollingDecision({ tool_name: "Write", tool_input: { command: "sleep 900" } }), null);
  assert.deepEqual(literalShellSleepSeconds("echo 'semi;colon'; sleep 90 # wait"), [90]);
});

test("host can tune or disable the pacing check without overriding permissions", () => {
  assert.equal(pollingSleepLimit({}), 30);
  assert.equal(pollingSleepLimit({ ORKESTR_CLAUDE_MAX_POLL_SLEEP_SECONDS: "invalid" }), 30);
  const event = { tool_name: "Bash", tool_input: { command: "sleep 60" } };
  assert.equal(claudePollingDecision(event, 0), null);
  assert.equal(claudePollingDecision(event, 60), null);
  const disabled = claudeCodeArgs({}, {}, { ORKESTR_CLAUDE_MAX_POLL_SLEEP_SECONDS: "0" });
  assert.equal(disabled.includes("--settings"), false);
});

test("real hook process returns a refusal to Claude without executing the shell input", () => {
  const hook = fileURLToPath(new URL("../packages/core/src/claude-code-polling-hook.js", import.meta.url));
  const result = spawnSync(process.execPath, [hook, "30"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 270; exit 99" } }),
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allowed = spawnSync(process.execPath, [hook, "30"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }), encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, "", "no allow decision may bypass the existing permission policy");
});

test("first and resumed turns install pacing alongside status telemetry", () => {
  for (const sessionId of ["", "session-example"]) {
    const args = claudeCodeArgs({}, { sessionId, statusCaptureCommand: "status-capture" }, {});
    assert.equal(args.filter(arg => arg === "--settings").length, 1);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.deepEqual(settings.statusLine, { type: "command", command: "status-capture" });
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /claude-code-polling-hook\.js.* 30$/);
  }
});
