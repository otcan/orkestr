import { codexLoginStatus } from "../../../../../packages/connectors/src/codex.js";
import { listLlmAccountProfiles } from "../../../../../packages/core/src/llm-account-profiles.js";

// Whether the owner has a signed-in AI provider a Setup can run on.
export async function setupProviderReady(provider = "", ownerUserId = "", env: NodeJS.ProcessEnv = process.env): Promise<{ ready: boolean; reason: string; accountProfileId?: string }> {
  if (provider === "codex") {
    const status = await codexLoginStatus({ env });
    return { ready: Boolean(status.connected), reason: status.reason };
  }
  const profiles = await listLlmAccountProfiles(ownerUserId, { provider: "claude-code" }, env).catch(() => []);
  const ready = profiles.find((profile: any) => profile.state === "ready");
  return ready ? { ready: true, reason: "account_ready", accountProfileId: String(ready.id) } : { ready: false, reason: "claude_account_not_ready" };
}
