import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerCodexAppServerPendingRequest,
  deliverCodexAppServerPendingInputs,
  interruptCodexAppServerThread,
  resumeCodexAppServerThread,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../../packages/core/src/codex-app-server.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../../packages/core/src/threads.js";
import { turnLifecycleEventName } from "../../packages/core/src/orkestr-events.js";
import { listEvents } from "../../packages/storage/src/store.js";

// Conformance harness for the Codex app-server adapter
// (packages/core/src/codex-app-server*.js). It drives the real Orkestr adapter
// through the Orkestr thread layer against fakes/fake-codex-app-server.mjs, so
// no Codex login or network access is needed.

const fakePath = fileURLToPath(new URL("./fakes/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, { timeoutMs = 10_000, intervalMs = 10, describe = async () => "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`codex conformance harness timed out waiting for adapter state ${await describe()}`.trim());
}

function classifyCodexFailure(thread) {
  // The adapter only distinguishes auth failures (failed_auth + authFailure).
  // Everything else is an unclassified `failed` turn with raw error text.
  if (thread?.state === "failed_auth" || thread?.runtime?.authFailure) return "auth";
  return "unclassified";
}

export const codexAppServerConformance = {
  name: "codex-app-server",
  capabilities: [
    "turn.start",
    "turn.final_output",
    "turn.streaming",
    "turn.cancel",
    "session.resume",
    "input.idempotent",
    "tools.approval",
    "errors.auth",
  ],
  gaps: {
    "errors.transient": "gap: non-auth turn failures persist raw error text only (state=failed); no transient vs permanent class",
    "errors.permanent": "gap: non-auth turn failures persist raw error text only (state=failed); no transient vs permanent class",
  },
  async create() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-codex-"));
    const bin = path.join(home, "bin");
    const stateFile = path.join(home, "codex-state.json");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr"),
      HOME: path.join(home, "runtime-home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      FAKE_CODEX_STATE: stateFile,
      ORKESTR_ADMIN_USER_ID: "conformance-owner",
    };
    const readFakeState = async () => JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}"));

    async function turnIdForInput(threadId, inputId) {
      const messages = await listThreadMessages(threadId, env);
      const input = messages.find((message) => message.id === inputId);
      return input?.codexTurnId || input?.executorTurnId || "";
    }

    // Settle on the adapter's turn lifecycle events rather than thread.runtime:
    // the persisted runtime snapshot can be overwritten after turn/start (see
    // the "Known gaps" section of docs/spec/conformance.md).
    async function lifecycle(threadId, turnId) {
      const events = await listEvents(env, 500);
      const types = new Set(events.filter((event) => event.threadId === threadId && event.turnId === turnId).map((event) => event.type));
      const terminal = ["completed", "failed", "interrupted"].find((type) => types.has(turnLifecycleEventName(type))) || "";
      return { terminal, awaitingApproval: types.has(turnLifecycleEventName("awaiting_approval")) };
    }

    async function settle(threadId, inputId, onToolRequest) {
      let tool = null;
      const turnId = await waitFor(() => turnIdForInput(threadId, inputId));
      const terminal = await waitFor(async () => {
        const observed = await lifecycle(threadId, turnId);
        if (observed.awaitingApproval && !tool?.answered) {
          const current = await getThread(threadId, env);
          if (!tool) {
            const decision = onToolRequest ? await onToolRequest({ tool: "commandExecution", input: current?.runtime?.pendingRequest || null }) : "deny";
            tool = { requested: true, decision, answered: false };
          }
          const answer = await answerCodexAppServerPendingRequest(current, { decision: tool.decision === "approve" ? "accept" : "decline" }, env);
          tool.answered = answer.answered === true;
          return null;
        }
        return observed.terminal || null;
      }, { describe: async () => JSON.stringify({ turnId, lifecycle: await lifecycle(threadId, turnId), state: (await getThread(threadId, env))?.state }) });
      const thread = await getThread(threadId, env);
      return { turnId, terminal, thread, tool: tool ? { requested: tool.requested, decision: tool.decision } : null };
    }

    return {
      async startSession({ sessionKey }) {
        const created = await createThread({
          id: `conformance-${sessionKey}`,
          name: `Conformance ${sessionKey}`,
          ownerUserId: "conformance-owner",
          cwd: home,
          executorId: "codex",
          codexSandbox: "workspace-write",
          codexApprovalPolicy: "on-request",
          executor: { type: "codex", metadata: { codexSandbox: "workspace-write", codexApprovalPolicy: "on-request" } },
        }, env);
        const started = await startCodexAppServerThread(created, env);
        return { threadId: started.thread.id };
      },
      async runTurn(session, input, { onEvent = () => {}, onToolRequest } = {}) {
        const queued = await enqueueThreadInput(session.threadId, {
          text: `${input.text} [scenario:${input.scenario || "echo"}]`,
          source: "conformance",
          clientMessageId: input.inputId,
        }, env);
        if (queued.duplicate) {
          const turnId = await turnIdForInput(session.threadId, queued.id);
          const thread = await getThread(session.threadId, env);
          const { terminal } = await lifecycle(session.threadId, turnId);
          return { turnId, status: terminal === "interrupted" ? "cancelled" : terminal || "completed", duplicate: true, providerSessionId: thread.executor?.codexThreadId || "", output: null, error: null };
        }
        await deliverCodexAppServerPendingInputs(await getThread(session.threadId, env), env);
        const { turnId, terminal, thread, tool } = await settle(session.threadId, queued.id, onToolRequest);
        const messages = (await listThreadMessages(session.threadId, env))
          .filter((message) => message.role === "assistant" && message.codexTurnId === turnId);
        const finals = messages.filter((message) => message.phase === "final_answer");
        for (const message of messages) {
          if (message.phase === "commentary") onEvent({ type: "progress", text: message.text });
          if (message.phase === "final_answer") onEvent({ type: "final", text: message.text });
        }
        const status = terminal === "interrupted" ? "cancelled" : terminal;
        const fake = await readFakeState();
        const executed = Boolean(fake.toolDecisions?.find((entry) => entry.turnId === turnId)?.executed);
        return {
          turnId,
          status,
          duplicate: false,
          providerSessionId: thread.executor?.codexThreadId || thread.codexThreadId || "",
          output: status === "completed" && finals.length ? { text: finals.at(-1).text } : null,
          error: status === "failed" ? { class: classifyCodexFailure(thread), code: thread.lastError || thread.runtime?.lastTurnError || "" } : null,
          ...(tool ? { tool: { ...tool, executed } } : {}),
        };
      },
      async cancelTurn(session) {
        await waitFor(async () => (await getThread(session.threadId, env))?.runtime?.activeTurnId, { describe: async () => "(no active turn to cancel)" });
        const result = await interruptCodexAppServerThread(await getThread(session.threadId, env), env);
        return { cancelled: result.interrupted === true };
      },
      async restart() {
        stopCodexAppServerClients();
      },
      async resumeSession(session) {
        const resumed = await resumeCodexAppServerThread(await getThread(session.threadId, env), env);
        const calls = (await readFakeState()).calls || [];
        const providerSessionId = resumed.thread?.executor?.codexThreadId || resumed.thread?.codexThreadId || "";
        return { providerSessionId, resumed: calls.some((call) => call.method === "thread/resume" && call.threadId === providerSessionId) };
      },
      async providerTurnCount() {
        return (await readFakeState()).turnStarts || 0;
      },
      async teardown() {
        stopCodexAppServerClients();
        await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  },
};
