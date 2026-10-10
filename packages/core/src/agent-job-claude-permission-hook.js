// Claude Code PreToolUse hook for Agent Job attempts. Claude Code runs it
// before every tool call (installed through `--settings` by
// agent-job-claude-code.js). It asks the attempt's Orkestr permission broker
// and prints the hook decision. It fails closed: any error, timeout or
// missing broker exits with code 2, which blocks the tool call.
import net from "node:net";

const socketPath = String(process.env.ORKESTR_AGENT_JOB_PERMISSION_SOCKET || "");
const token = String(process.env.ORKESTR_AGENT_JOB_PERMISSION_TOKEN || "");
const timeoutMs = Math.max(1_000, Number(process.env.ORKESTR_AGENT_JOB_PERMISSION_TIMEOUT_MS || 120_000) || 120_000);

function block(reason) {
  process.stderr.write(`Orkestr blocked this tool call: ${reason}\n`);
  process.exit(2);
}

const timer = setTimeout(() => block("permission check timed out"), timeoutMs);

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 1024 * 1024) block("tool input too large");
  }
  return input;
}

function ask(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { reply += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      try { resolve(JSON.parse(reply.trim())); } catch (error) { reject(error); }
    });
  });
}

try {
  if (!socketPath || !token) block("no Orkestr permission broker for this process");
  const event = JSON.parse(await readStdin());
  const reply = await ask({
    token,
    tool_name: event.tool_name,
    tool_input: event.tool_input,
    tool_use_id: event.tool_use_id,
  });
  const decision = reply?.decision === "allow" ? "allow" : "deny";
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: String(reply?.reason || "").slice(0, 1000),
    },
  })}\n`);
  if (decision !== "allow") {
    // Exit 2 as well, so a CLI that ignores the JSON output still blocks.
    process.stderr.write(`${String(reply?.reason || "denied by the Orkestr job policy").slice(0, 1000)}\n`);
    process.exit(2);
  }
  process.exit(0);
} catch (error) {
  block(String(error?.message || error).slice(0, 200));
}
