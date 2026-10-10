// Real connectivity probes for Agent Job providers: Codex CLI login status and
// Claude Code auth status. Results are cached briefly so webhook bursts do not
// spawn a CLI per request. Installed by the server and the CLI.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { setAgentJobProviderProbe } from "../../core/src/agent-job-providers.js";
import { claudeCodeStatusAuthenticated } from "../../core/src/claude-code-auth-status.js";
import { claudeCodeCommand } from "../../core/src/claude-code-client.js";
import { agentJobExecutorFor } from "../../core/src/agent-job-adapters.js";
import { codexAppServerStatus } from "../../core/src/codex-app-server-client.js";
import { codexLoginStatus } from "./codex.js";

const execFileAsync = promisify(execFile);

// connected = the login works; runnable = Orkestr also has a job executor.
async function withExecutor(provider, status, env) {
  if (!status.connected) return { ...status, runnable: false };
  const executor = await agentJobExecutorFor(provider, env);
  return executor ? { ...status, runnable: true } : { ...status, runnable: false, reason: "job_executor_unavailable" };
}

// Codex: the same checks as `orkestr doctor` (login status, then app-server).
async function codexStatus(env) {
  const home = env.HOME || os.homedir();
  const login = await codexLoginStatus({ env, home, timeoutMs: 2500 });
  if (!login.connected) return { connected: false, reason: login.reason };
  const appServer = await codexAppServerStatus({ env, home });
  if (!appServer.ok) return { connected: false, reason: "codex_app_server_unavailable" };
  return withExecutor("codex", { connected: true, reason: "logged_in" }, env);
}

// Host Claude CLI login (`claude auth status --json`), the same login a
// terminal user on this host would use.
async function claudeHostStatus(env) {
  try {
    const { stdout = "" } = await execFileAsync(claudeCodeCommand(env), ["auth", "status", "--json"], {
      env: { PATH: env.PATH || process.env.PATH || "", HOME: env.HOME || os.homedir(), DISABLE_AUTOUPDATER: "1" },
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const connected = claudeCodeStatusAuthenticated(stdout);
    return { connected, reason: connected ? "logged_in" : "not_logged_in" };
  } catch (error) {
    return { connected: false, reason: error?.code === "ENOENT" ? "claude_code_cli_missing" : "not_logged_in" };
  }
}

const CACHE_MS = 60_000;
const cache = new Map();

function cached(key, fn) {
  return async (env) => {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await fn(env);
    cache.set(key, { value, until: Date.now() + CACHE_MS });
    return value;
  };
}

export function clearAgentJobProviderProbeCache() {
  cache.clear();
}

let installed = false;

// Probes registered earlier (tests, overlays) are kept.
export function installAgentJobProviderProbes() {
  if (installed) return;
  installed = true;
  setAgentJobProviderProbe("codex", cached("codex", codexStatus), { ifAbsent: true });
  setAgentJobProviderProbe("claude-code", cached("claude-code", async (env) => withExecutor("claude-code", await claudeHostStatus(env), env)), { ifAbsent: true });
}
