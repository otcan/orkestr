import path from "node:path";
import { resolveLlmAccountProfile } from "./llm-account-profiles.js";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { codexAppServerStatus } from "./codex-app-server-client.js";
import { getCodexJobClient } from "./codex-job-client.js";
import { codexJobAdapter, personalAgentCodexDynamicTools, personalAgentCodexInstructions } from "./agent-job-codex.js";
import { claudeCodeJobAdapter } from "./agent-job-claude-code.js";
import { claudeCodeExecutionEnv } from "./claude-code-client.js";
import { claudeCodeAccountDiagnostics } from "./claude-code-subscription-diagnostics.js";
import { sessionBlockedReason, sessionError } from "./personal-agent-session-records.js";

// Subscription executors only. The optional openai-compatible profile remains
// in Agent Jobs and is never selected as an implicit replacement here.
export function createPersonalAgentSessionRuntimes({ env = process.env, cwd, resolveProfile = resolveLlmAccountProfile,
  codexLogin = async () => ({ available: false }), codexStatus = codexAppServerStatus, codexClient = getCodexJobClient,
  claudeDiagnostics = claudeCodeAccountDiagnostics, claudeEnv = claudeCodeExecutionEnv,
  executors = { codex: codexJobAdapter, "claude-code": claudeCodeJobAdapter } } = {}) {
  if (!cwd || !path.isAbsolute(cwd)) throw sessionError("agent_session_workspace_required", 400);
  async function configured(row) {
    if (!personalAgentFeature(env)) throw sessionError("personal_agent_disabled", 404);
    const profile = await resolveProfile({ ownerUserId: row.ownerUserId, profileId: row.accountProfileId, provider: row.provider, requireReady: false }, env);
    if (profile.ownerUserId !== row.ownerUserId || profile.id !== row.accountProfileId || profile.provider !== row.provider || profile.authMode !== "subscription") throw sessionError("agent_session_auth_required", 503);
    if (profile.state === "rate_limited") throw sessionError("agent_session_rate_limited", 503);
    if (profile.state !== "ready") throw sessionError("agent_session_auth_required", 503);
    if (!executors[row.provider]?.enabled(env)) throw sessionError("agent_session_runtime_unavailable", 503);
    const runtimeEnv = row.provider === "codex"
      ? { ...env, HOME: path.join(profile.credentialRoot, "runtime-home"), CODEX_HOME: profile.credentialRoot,
        OPENAI_API_KEY: "", CODEX_API_KEY: "", ORKESTR_CODEX_APP_SERVER_MODE: "stdio", ORKESTR_CODEX_APP_SERVER_SOCKET: "" }
      : { ...env, CLAUDE_CODE_OAUTH_TOKEN: "", ...await claudeEnv(profile, {}, env), ORKESTR_AGENT_JOB_CLAUDE_CONFIG_DIR: profile.credentialRoot };
    return { profile, runtimeEnv };
  }
  return Object.freeze(Object.fromEntries(["codex", "claude-code"].map(provider => [provider, Object.freeze({
    async probe(row) {
      try {
        const { profile, runtimeEnv } = await configured(row);
        if (provider === "codex") {
          const login = await codexLogin({ env: runtimeEnv, home: runtimeEnv.HOME });
          if (!login.available) return { available: false, reason: "runtime_unavailable" };
          if (!login.connected || login.authMode !== "chatgpt") return { available: false, reason: "authentication_required" };
          return (await codexStatus({ env: runtimeEnv, home: runtimeEnv.HOME })).ok === true
            ? { available: true } : { available: false, reason: "runtime_unavailable" };
        }
        const status = await claudeDiagnostics(profile, env);
        if (!status.available) return { available: false, reason: "runtime_unavailable" };
        // Authentication is not a successful inference or quota check.
        return status.authenticated && ["claude.ai", "oauth_token", "subscription_token", "oauth"].includes(status.authMethod)
          ? { available: true } : { available: false, reason: "authentication_required" };
      } catch (error) { return { available: false, reason: sessionBlockedReason(error) }; }
    },
    async open(row, { parent = null, signal } = {}) {
      signal?.throwIfAborted();
      const { runtimeEnv } = await configured(row);
      if (provider === "claude-code") {
        if (parent) throw sessionError("agent_session_fork_unsupported", 503);
        // Claude print mode has no metadata-only session/create command. Do
        // not spend quota or claim ready: the first supervised turn creates it.
        return { nativeSessionId: row.nativeSessionId, lifecycle: row.nativeSessionId ? "ready" : "starting" };
      }
      const client = await codexClient({ env: runtimeEnv, home: runtimeEnv.HOME });
      signal?.throwIfAborted();
      if (row.nativeSessionId && client.personalAgentPendingSessions?.has(row.nativeSessionId)) return { nativeSessionId: row.nativeSessionId, lifecycle: "starting" };
      const method = row.nativeSessionId ? "thread/resume" : parent ? "thread/fork" : "thread/start";
      let result;
      try {
        result = await client.request(method, { ...(row.nativeSessionId || parent ? { threadId: row.nativeSessionId || parent.nativeSessionId } : {}),
          cwd, model: row.model, modelProvider: "openai", approvalPolicy: "untrusted", sandbox: "workspace-write",
          developerInstructions: personalAgentCodexInstructions(cwd),
          ...(method === "thread/start" ? { ephemeral: false, allowProviderModelFallback: false, dynamicTools: personalAgentCodexDynamicTools(), serviceName: "orkestr_oss" } : {}) });
      } catch (error) {
        if (row.nativeSessionId) throw sessionError("agent_session_native_resume_failed", 503);
        throw error;
      }
      signal?.throwIfAborted();
      const nativeSessionId = result?.thread?.id;
      if (!nativeSessionId) throw sessionError("agent_session_native_session_missing", 503);
      if (result.thread.turns?.some(turn => turn.status === "inProgress")) throw sessionError("agent_session_native_resume_reconciliation_required", 503);
      if (method === "thread/start") {
        client.personalAgentPendingSessions ||= new Map();
        client.personalAgentPendingSessions.set(nativeSessionId, result.thread);
      }
      return { nativeSessionId, lifecycle: method === "thread/start" ? "starting" : "ready" };
    },
    async run(row, ctx, input) {
      ctx.signal.throwIfAborted();
      const { runtimeEnv } = await configured(row);
      const plan = { id: row.id, effort: row.effort };
      return executors[provider].run({ ...ctx, env: runtimeEnv, personalAgentSession: plan,
        resume: row.nativeSessionId ? { sessionRef: row.nativeSessionId, reason: "persistent personal-agent session" } : null,
        // Project resources are owned by the conversation, not copied per
        // session. A run cannot silently move a resumed session to another cwd.
        prepareWorkspace: async () => {
          const workspace = await ctx.prepareWorkspace(input);
          if (path.resolve(workspace.path) !== path.resolve(cwd)) throw sessionError("agent_session_workspace_mismatch", 403);
          return workspace;
        },
      }, { ...input, model: row.model });
    },
  })])));
}
