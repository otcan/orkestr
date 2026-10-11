// Subscription-only check at provider dispatch for Setup threads.
//
// A Setup must never run on pay-as-you-go API billing. Login state can change
// after install, so the check runs on every turn handed to a provider:
// scheduled check-ins, owner messages and resumed sessions all pass through
// the same dispatch points. Threads not created by a Setup are unaffected.
// If the auth state cannot be established, the turn is refused.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isSetupThread(thread = {}) {
  return Boolean(String(thread?.setupInstanceId || "").trim());
}

function refusal(reason, detail = "") {
  return { ok: false, reason, detail };
}

// Codex: ask the app-server that will run the turn which login it uses
// (`account/read`, Codex app-server protocol v2). Only a ChatGPT login counts.
export async function checkSetupCodexSubscription(client, thread) {
  if (!isSetupThread(thread)) return { ok: true, applies: false };
  let response;
  try {
    response = await client.request("account/read", { refreshToken: false });
  } catch (error) {
    return refusal("codex_auth_state_unavailable", String(error?.message || error).slice(0, 200));
  }
  const type = String(response?.account?.type || "").trim();
  if (type === "chatgpt") return { ok: true, applies: true };
  if (type === "apiKey") return refusal("codex_api_key_not_subscription");
  if (!type) return refusal("codex_not_logged_in");
  return refusal("codex_auth_mode_not_subscription", type.slice(0, 40));
}

const anthropicApiEnv = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

// Runs the installed CLI's own status command (`claude auth status --json`,
// verified on Claude Code 2.1.295) with exactly the command, child
// environment and working directory the turn would use; project-local
// settings (for example an apiKeyHelper) depend on the working directory.
// No credential file is read by Orkestr. Only a clean exit counts as status:
// a non-zero exit, timeout or signal never authorizes anything, even if
// positive-looking JSON was printed first. Output from a failed run is kept
// only to explain the refusal.
export async function readClaudeAuthStatus(command, childEnv, { cwd, timeoutMs = 15_000 } = {}) {
  try {
    const { stdout = "" } = await execFileAsync(command, ["auth", "status", "--json"], { env: childEnv, cwd: cwd || undefined, timeout: timeoutMs, maxBuffer: 256 * 1024 });
    return { ok: true, status: JSON.parse(stdout) };
  } catch (error) {
    let reported = null;
    try { reported = JSON.parse(String(error?.stdout || "")); } catch {}
    const reason = error?.code === "ENOENT" ? "claude_cli_missing"
      : error?.killed || error?.signal ? `status_${error.signal || "killed"}`
      : typeof error?.code === "number" ? `status_exit_${error.code}`
      : String(error?.message || error).slice(0, 200);
    return { ok: false, error: reason, reportedLoggedIn: reported?.loggedIn === true ? true : reported?.loggedIn === false ? false : null };
  }
}

// Positive evidence only: a first-party login through claude.ai with a known
// subscription type, or a subscription OAuth token (`claude setup-token`).
// Anything else (API key, third-party provider, unknown method) is refused.
export function claudeAuthStatusIsSubscription(status = {}) {
  if (status?.loggedIn !== true) return refusal("claude_not_logged_in");
  if (String(status.apiProvider || "") !== "firstParty") return refusal("claude_login_not_subscription", `provider:${String(status.apiProvider || "unknown").slice(0, 40)}`);
  if (status.apiKeySource) return refusal("claude_login_not_subscription", "api_key_source");
  const method = String(status.authMethod || "");
  if (method === "claude.ai" && String(status.subscriptionType || "").trim()) return { ok: true, applies: true };
  if (method === "oauth_token") return { ok: true, applies: true };
  return refusal("claude_login_not_subscription", `method:${method.slice(0, 40) || "unknown"}`);
}

// Claude Code: the profile must be declared a subscription profile, the child
// env must carry no API-billing settings, and the CLI itself, run in that
// exact env, must report a subscription login.
export async function checkSetupClaudeSubscription(thread, profile = {}, childEnv = {}, { command = "claude", cwd, timeoutMs, readStatus = readClaudeAuthStatus } = {}) {
  if (!isSetupThread(thread)) return { ok: true, applies: false };
  if (String(profile?.authMode || "").trim() !== "subscription") return refusal("claude_profile_not_subscription");
  const leaked = anthropicApiEnv.filter((key) => String(childEnv?.[key] || "").trim());
  if (leaked.length) return refusal("claude_api_billing_env_present", leaked.join(","));
  const read = await readStatus(command, childEnv, { cwd, ...(timeoutMs ? { timeoutMs } : {}) });
  if (!read.ok) return refusal(read.reportedLoggedIn === false ? "claude_not_logged_in" : "claude_auth_status_unavailable", read.error);
  return claudeAuthStatusIsSubscription(read.status);
}
