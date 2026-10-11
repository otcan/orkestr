// Subscription-only check at provider dispatch for Setup threads.
//
// A Setup must never run on pay-as-you-go API billing. Login state can change
// after install, so the check runs on every turn handed to a provider:
// scheduled check-ins, owner messages and resumed sessions all pass through
// the same dispatch points. Threads not created by a Setup are unaffected.
// If the auth state cannot be established, the turn is refused.

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

// Claude Code: the account profile must be a subscription profile and the
// child process must not carry any API-billing configuration.
export function checkSetupClaudeSubscription(thread, profile = {}, childEnv = {}) {
  if (!isSetupThread(thread)) return { ok: true, applies: false };
  if (String(profile?.authMode || "").trim() !== "subscription") return refusal("claude_profile_not_subscription");
  const leaked = anthropicApiEnv.filter((key) => String(childEnv?.[key] || "").trim());
  if (leaked.length) return refusal("claude_api_billing_env_present", leaked.join(","));
  return { ok: true, applies: true };
}
