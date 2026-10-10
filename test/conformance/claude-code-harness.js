import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getClaudeCodeSession } from "../../packages/core/src/claude-code-sessions.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../../packages/core/src/llm-account-profiles.js";
import {
  hasActiveClaudeCodeSupervisor,
  interruptClaudeCodeThread,
  resetClaudeCodeRuntimeForTest,
  resumeClaudeCodeThread,
  sendClaudeCodeInput,
  startClaudeCodeThread,
} from "../../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../../packages/core/src/threads.js";

// Conformance harness for the Claude Code adapter
// (packages/core/src/runtime-claude-code-adapter.js) driven against
// fakes/fake-claude-code.mjs. No Claude login or network access is needed.

const fakePath = fileURLToPath(new URL("./fakes/fake-claude-code.mjs", import.meta.url));
const OWNER = "conformance-owner";

// The adapter reports low-cardinality failure codes; the error class mapping
// lives here because the adapter does not expose a provider-neutral class.
const ERROR_CLASS_BY_CODE = {
  claude_code_auth_required: "auth",
  llm_account_profile_login_required: "auth",
  claude_code_rate_limited: "transient",
  claude_code_timeout: "transient",
};

export function classifyClaudeCodeFailure(code = "") {
  return ERROR_CLASS_BY_CODE[code] || "permanent";
}

export const claudeCodeConformance = {
  name: "claude-code",
  capabilities: [
    "turn.start",
    "turn.final_output",
    "turn.streaming",
    "turn.cancel",
    "session.resume",
    "input.idempotent",
    "errors.auth",
    "errors.transient",
    "errors.permanent",
  ],
  gaps: {
    "tools.approval": "gap: Claude Code runs its own tool loop under a fixed permission mode; there is no per-call Orkestr approval hook",
  },
  async create() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-claude-"));
    const bin = path.join(home, "claude");
    const callsFile = path.join(home, "claude-calls.jsonl");
    // The adapter builds the child env from an allowlist, so the wrapper pins
    // the fake's calls file itself.
    await fs.writeFile(bin, `#!/bin/sh\nFAKE_CLAUDE_CALLS="${callsFile}" exec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: OWNER,
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: bin,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      PATH: process.env.PATH || "",
    };
    const priorHome = process.env.ORKESTR_HOME;
    process.env.ORKESTR_HOME = home;
    const readCalls = async () => (await fs.readFile(callsFile, "utf8").catch(() => ""))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));

    async function turnIdForInput(threadId, inputId) {
      const messages = await listThreadMessages(threadId, env);
      const input = messages.find((message) => message.id === inputId);
      return input?.executorTurnId || input?.claudeAttemptId || input?.turnId || "";
    }

    return {
      async startSession({ sessionKey }) {
        const profile = await createLlmAccountProfile(OWNER, { provider: "claude-code", label: `Conformance ${sessionKey}`, authMode: "subscription" }, env);
        await updateLlmAccountProfileState(OWNER, profile.id, "ready", { verified: true }, env);
        const thread = await createThread({
          id: `conformance-${sessionKey}`,
          name: `Conformance ${sessionKey}`,
          ownerUserId: OWNER,
          executorId: "claude-code",
          runtimeKind: "claude-code",
          executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
        }, env);
        const started = await startClaudeCodeThread(thread, env);
        return { threadId: started.thread.id };
      },
      async runTurn(session, input, { onEvent = () => {} } = {}) {
        const scenario = input.scenario || "echo";
        const queued = await enqueueThreadInput(session.threadId, {
          text: `${input.text} [scenario:${scenario}]`,
          clientMessageId: input.inputId,
          source: "conformance",
        }, env);
        const thread = await getThread(session.threadId, env);
        if (queued.duplicate) {
          return {
            turnId: await turnIdForInput(session.threadId, queued.id),
            status: queued.state === "failed" ? "failed" : queued.state === "interrupted" ? "cancelled" : "completed",
            duplicate: true,
            providerSessionId: await getClaudeCodeSession(thread, env),
            output: null,
            error: queued.state === "failed" ? { class: classifyClaudeCodeFailure(queued.error), code: String(queued.error || "") } : null,
          };
        }
        let failure = null;
        let interrupted = false;
        try {
          // Progress for a non-connector input arrives through onProgress.
          const result = await sendClaudeCodeInput(thread, queued, env, {
            onProgress: ({ text }) => onEvent({ type: "progress", text }),
          });
          interrupted = result?.interrupted === true;
        } catch (error) {
          failure = error;
        }
        const after = await getThread(session.threadId, env);
        const turnId = await turnIdForInput(session.threadId, queued.id) || after?.runtime?.lastTurnId || "";
        const assistant = (await listThreadMessages(session.threadId, env))
          .filter((message) => message.role === "assistant" && message.parentMessageId === queued.id && message.source !== "orkestr_runtime");
        for (const message of assistant) {
          onEvent({ type: message.phase === "commentary" ? "progress" : "final", text: message.text });
        }
        const finals = assistant.filter((message) => message.phase !== "commentary");
        const status = failure ? "failed" : interrupted ? "cancelled" : "completed";
        const code = failure ? String(failure.code || failure.message || "") : "";
        return {
          turnId,
          status,
          duplicate: false,
          providerSessionId: await getClaudeCodeSession(after, env),
          output: status === "completed" && finals.length ? { text: finals.at(-1).text } : null,
          error: failure ? { class: classifyClaudeCodeFailure(code), code } : null,
        };
      },
      async cancelTurn(session) {
        for (let attempt = 0; attempt < 500 && !hasActiveClaudeCodeSupervisor(session.threadId); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const result = await interruptClaudeCodeThread(await getThread(session.threadId, env), env);
        return { cancelled: result.interrupted === true };
      },
      async restart() {
        resetClaudeCodeRuntimeForTest();
      },
      async resumeSession(session) {
        const thread = await getThread(session.threadId, env);
        await resumeClaudeCodeThread(thread, env);
        const providerSessionId = await getClaudeCodeSession(thread, env);
        return { providerSessionId, resumed: Boolean(providerSessionId) };
      },
      async providerTurnCount() {
        return (await readCalls()).length;
      },
      async teardown() {
        resetClaudeCodeRuntimeForTest();
        if (priorHome === undefined) delete process.env.ORKESTR_HOME;
        else process.env.ORKESTR_HOME = priorHome;
        await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  },
};
