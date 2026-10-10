// Fake `claude` CLI for the conformance suite. Derived from the inline fake in
// test/claude-code-runtime.test.js: reads the prompt on stdin and writes
// stream-json events. Scenario markers in the prompt:
//   [scenario:progress]        assistant text + tool_use event before the result
//   [scenario:slow]            sleeps until the adapter interrupts the process
//   [scenario:fault:<class>]   auth / transient / permanent failure shapes
//   [scenario:tool]            one Bash tool_use; PreToolUse hooks from
//                              --settings decide it like the real CLI (exit 2
//                              or permissionDecision "deny" blocks); a call
//                              that runs is appended to FAKE_CLAUDE_TOOLS
// Every turn invocation is appended to FAKE_CLAUDE_CALLS.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const callsFile = process.env.FAKE_CLAUDE_CALLS;
const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[args.indexOf("--output-format") + 1] === "json") {
  write({ type: "result", subtype: "success", is_error: false, result: "OK" });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  write({ authenticated: true, status: "logged_in" });
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const resumed = resumeAt >= 0 ? args[resumeAt + 1] : "";
  const scenario = /\[scenario:([a-z:]+)\]/.exec(prompt)?.[1] || "echo";
  fs.appendFileSync(callsFile, `${JSON.stringify({ scenario, resumed, prompt: prompt.trim() })}\n`);
  const session = resumed || `claude_session_${process.pid}`;
  write({ type: "system", subtype: "init", session_id: session });
  if (scenario === "fault:auth") {
    write({ type: "result", subtype: "success", session_id: session, is_error: true, result: "Failed to authenticate. API Error: 401" });
    process.exit(1);
  }
  if (scenario === "fault:transient") {
    process.stderr.write("429 usage limit reached\n");
    process.exit(1);
  }
  if (scenario === "fault:permanent") {
    write({ type: "result", subtype: "error_during_execution", session_id: session, is_error: true, result: "invalid_request_error: malformed request" });
    process.exit(1);
  }
  const finish = () => {
    write({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "draft" }] } });
    write({ type: "result", session_id: session, model: "claude-fixture", result: `Reply: ${prompt.trim()}`, is_error: false, usage: { input_tokens: 10, output_tokens: 5 } });
  };
  if (scenario === "slow") return void setTimeout(finish, 30_000);
  if (scenario === "tool") {
    const input = { command: "echo conformance" };
    write({ type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "toolu_conformance", name: "Bash", input }] } });
    const settings = args.includes("--settings") ? JSON.parse(args[args.indexOf("--settings") + 1]) : {};
    let allowed = true;
    for (const hook of (settings.hooks?.PreToolUse || []).flatMap((entry) => entry.hooks || [])) {
      const run = spawnSync("/bin/sh", ["-c", hook.command], { input: JSON.stringify({ session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: "toolu_conformance" }), encoding: "utf8" });
      let denied = run.status === 2;
      try { denied ||= run.status === 0 && JSON.parse(run.stdout || "{}").hookSpecificOutput?.permissionDecision === "deny"; } catch {}
      if (denied) allowed = false;
    }
    if (allowed && process.env.FAKE_CLAUDE_TOOLS) fs.appendFileSync(process.env.FAKE_CLAUDE_TOOLS, `${JSON.stringify(input)}\n`);
    write({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "toolu_conformance", is_error: !allowed, content: allowed ? "conformance" : "blocked" }] } });
  }
  if (scenario === "progress") {
    write({ type: "assistant", session_id: session, message: { content: [
      { type: "text", text: "Inspecting the workspace before answering." },
      { type: "tool_use", name: "Read", input: { path: "README.md" } },
    ] } });
  }
  return void setTimeout(finish, 20);
});
