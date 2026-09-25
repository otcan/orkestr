import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeCodeCommand, claudeCodeExecutionEnv, classifyClaudeCodeFailure } from "./claude-code-client.js";

const exec = promisify(execFile);
const pending = new Map();

// Explicit operator verification, not a periodic quota-consuming job. Never
// resume a thread, replay its input, launch MCP servers, or expose raw CLI output.
export async function verifyClaudeCodeInference(profile, env = process.env) {
  const key = JSON.stringify([profile.credentialRoot, profile.credentialRevision || 0]);
  if (pending.has(key)) return pending.get(key);
  const operation = probe(profile, env).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function probe(profile, env) {
  const status = (authenticated, reason, available = true) => ({ available, authenticated, reason, verificationKind: "model_request" });
  let directory;
  try {
    const childEnv = await claudeCodeExecutionEnv(profile, {}, env);
    await Promise.all([fs.mkdir(childEnv.HOME, { recursive: true, mode: 0o700 }), fs.mkdir(childEnv.TMPDIR, { recursive: true, mode: 0o700 })]);
    directory = await fs.mkdtemp(path.join(childEnv.TMPDIR, "login-check-"));
    const args = ["--print", "--output-format", "json", "--model", "haiku", "--tools", "",
      "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
      "--no-session-persistence", "--system-prompt", "Reply with OK only.", "Reply with OK only."];
    const { stdout } = await exec(claudeCodeCommand(env), args, {
      env: childEnv, cwd: directory, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
    });
    let result;
    try { result = JSON.parse(stdout); } catch { return status(false, "claude_code_verification_invalid_response"); }
    if (result?.type === "result" && result.subtype === "success" && result.is_error === false && String(result.result || "").trim() === "OK") {
      return status(true, "model_request_succeeded");
    }
    // Only provider result error fields are eligible, never assistant content or
    // an exec error message containing command paths/prompt arguments.
    return status(false, result?.is_error === true
      ? classifyClaudeCodeFailure([result.result, ...(Array.isArray(result.errors) ? result.errors : [])].join(" "))
      : "claude_code_verification_invalid_response");
  } catch (error) {
    if (error?.killed || error?.signal === "SIGKILL") return status(false, "claude_code_timeout");
    if (error?.code === "ENOENT") return status(false, "claude_code_cli_missing", false);
    return status(false, classifyClaudeCodeFailure(`${error?.stdout || ""} ${error?.stderr || ""}`));
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
