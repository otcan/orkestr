// Fake `claude` CLI for the Claude Code job executor tests. It mimics the
// parts of `claude -p --output-format stream-json` the executor relies on,
// including PreToolUse hooks from `--settings`: each hook command runs through
// the shell with the hook JSON on stdin; exit 2 blocks the call, exit 0 with
// hookSpecificOutput.permissionDecision decides it, and any other exit code is
// a non-blocking hook error (the call runs), as in the real CLI.
//
// Env (set by the wrapper script the test writes):
//   FAKE_CLAUDE_JOB_PLAN   JSON file { turns: [turn, ...] }; invocation i uses
//                          turns[i] (or the last). A turn:
//                          { text, tools: [{ name, input }], final, slow,
//                            skipHook, noToolUseId, fail: "auth"|"rate"|"task", hang }
//   FAKE_CLAUDE_JOB_CALLS  JSONL log: one line per invocation
//   FAKE_CLAUDE_JOB_RAN    JSONL log: one line per tool call that actually ran
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");

if (args[0] === "auth" && args[1] === "status") {
  write({ loggedIn: true, authMethod: "claude.ai" });
  process.exit(0);
}

const callsFile = process.env.FAKE_CLAUDE_JOB_CALLS;
const ranFile = process.env.FAKE_CLAUDE_JOB_RAN;
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_JOB_PLAN, "utf8"));
const previousCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
const turn = plan.turns[Math.min(previousCalls, plan.turns.length - 1)] || {};
const settings = flag("--settings") ? JSON.parse(flag("--settings")) : {};
const hooks = (settings.hooks?.PreToolUse || []).flatMap((entry) => entry.hooks || []);

function runHooks(session, toolUseId, tool) {
  for (const hook of hooks) {
    const result = spawnSync("/bin/sh", ["-c", hook.command], {
      input: JSON.stringify({ session_id: session, hook_event_name: "PreToolUse", cwd: process.cwd(), tool_name: tool.name, tool_input: tool.input || {}, ...(turn.noToolUseId ? {} : { tool_use_id: toolUseId }) }),
      encoding: "utf8",
      env: process.env,
    });
    if (result.status === 2) return { allowed: false, reason: String(result.stderr || "blocked").trim() };
    if (result.status !== 0) continue; // non-blocking hook error
    try {
      const output = JSON.parse(result.stdout || "{}").hookSpecificOutput || {};
      if (output.permissionDecision === "deny") return { allowed: false, reason: output.permissionDecisionReason || "denied" };
    } catch {}
  }
  return { allowed: true };
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  const resumed = flag("--resume");
  const session = resumed || `fake-claude-session-${process.pid}`;
  fs.appendFileSync(callsFile, `${JSON.stringify({ resumed, prompt: prompt.trim(), cwd: process.cwd(), hooks: hooks.length, permissionMode: flag("--permission-mode"), strictMcp: args.includes("--strict-mcp-config"), home: process.env.HOME || "", leaked: Object.keys(process.env).filter((key) => key.startsWith("ORKESTR_") && !key.startsWith("ORKESTR_AGENT_JOB_PERMISSION_")) })}\n`);
  write({ type: "system", subtype: "init", session_id: session });
  if (turn.fail === "auth") {
    write({ type: "result", session_id: session, is_error: true, result: "Failed to authenticate. API Error: 401" });
    process.exit(1);
  }
  if (turn.fail === "rate") {
    process.stderr.write("429 usage limit reached\n");
    process.exit(1);
  }
  if (turn.text) write({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: turn.text }] } });
  let n = 0;
  for (const tool of turn.tools || []) {
    n += 1;
    const id = `toolu_fake_${previousCalls}_${n}`;
    write({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id, name: tool.name, input: tool.input || {} }] } });
    const verdict = turn.skipHook ? { allowed: true } : runHooks(session, id, tool);
    if (verdict.allowed) fs.appendFileSync(ranFile, `${JSON.stringify({ name: tool.name, input: tool.input || {} })}\n`);
    write({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !verdict.allowed, content: verdict.allowed ? "ok" : verdict.reason }] } });
    if (turn.hang && !verdict.allowed) await new Promise(() => {}); // like a model waiting
  }
  const finish = () => {
    if (turn.fail === "task") {
      write({ type: "result", subtype: "error_during_execution", session_id: session, is_error: true, result: "malformed request" });
      process.exit(1);
    }
    write({ type: "result", session_id: session, is_error: false, result: turn.final ?? "done", usage: { input_tokens: 12, output_tokens: 7 } });
    process.exit(0);
  };
  if (turn.slow) setTimeout(finish, 30_000);
  else finish();
});
