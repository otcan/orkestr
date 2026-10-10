// Per-attempt permission broker for native provider tool loops
// (docs/spec/adapter-interface.md §3.3, permissionHook "pre_call").
//
// The provider CLI calls a hook command before every tool call
// (agent-job-claude-permission-hook.js). The hook connects to this broker over
// a private Unix socket and gets the Orkestr decision: allow, or deny with a
// reason. Requests must carry the per-attempt token. Every tool_use id that
// passed the broker is remembered, so the adapter can fail closed when the
// provider reports a tool result for a call that never asked.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const MAX_REQUEST_BYTES = 1024 * 1024;

export const PERMISSION_SOCKET_ENV = "ORKESTR_AGENT_JOB_PERMISSION_SOCKET";
export const PERMISSION_TOKEN_ENV = "ORKESTR_AGENT_JOB_PERMISSION_TOKEN";

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

// Provider tool name -> job policy tool name (permissions.tools patterns are
// lower-case dotted names). Claude built-ins become `claude.<tool>`
// (`Bash` -> `claude.bash`), MCP tools `mcp.<server>.<tool>`.
export function nativeToolName(name) {
  const raw = String(name || "");
  if (raw.startsWith("mcp__")) {
    const [, server = "", ...rest] = raw.split("__");
    return `mcp.${slug(server)}.${slug(rest.join("__"))}`;
  }
  return `claude.${slug(raw)}`;
}

function tokensEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Start a broker. `authorize({ tool, rawTool, args, callId })` resolves to
 * { decision: "allow" | "deny", reason? }; anything else is a deny.
 * Returns { socketPath, token, env, decisionFor(callId, rawTool), close() }.
 */
export async function startPermissionBroker({ authorize }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-perm-"));
  await fs.chmod(dir, 0o700);
  const socketPath = path.join(dir, "broker.sock");
  const token = crypto.randomBytes(24).toString("base64url");
  const decided = new Map();
  // Hook inputs without tool_use_id (older CLIs): matched by tool name in order.
  const anonymous = [];

  async function answer(request) {
    if (!tokensEqual(request?.token, token)) return { decision: "deny", reason: "orkestr_permission_token_invalid" };
    const rawTool = String(request.tool_name || "");
    const callId = String(request.tool_use_id || "");
    const tool = nativeToolName(rawTool);
    const args = request.tool_input && typeof request.tool_input === "object" ? request.tool_input : {};
    let verdict;
    try {
      verdict = await authorize({ tool, rawTool, args, callId });
    } catch (error) {
      verdict = { decision: "deny", reason: `orkestr_permission_error: ${String(error?.message || error).slice(0, 200)}` };
    }
    const decision = verdict?.decision === "allow" ? "allow" : "deny";
    if (callId) decided.set(callId, decision);
    else anonymous.push({ rawTool, decision });
    return { decision, reason: String(verdict?.reason || (decision === "allow" ? "allowed by the Orkestr job policy" : `${tool} is denied by the Orkestr job policy`)) };
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ decision: "deny", reason: "orkestr_permission_request_too_large" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let request = null;
      try { request = JSON.parse(buffer.slice(0, newline)); } catch {}
      void answer(request).then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600).catch(() => {});

  return {
    socketPath,
    token,
    // The decision taken for a call, or null when it never passed the broker.
    decisionFor(callId, rawTool = "") {
      if (decided.has(callId)) return decided.get(callId);
      const index = anonymous.findIndex((entry) => entry.rawTool === rawTool);
      if (index < 0) return null;
      const [entry] = anonymous.splice(index, 1);
      decided.set(callId, entry.decision);
      return entry.decision;
    },
    env: { [PERMISSION_SOCKET_ENV]: socketPath, [PERMISSION_TOKEN_ENV]: token },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
