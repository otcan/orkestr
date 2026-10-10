import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeJobAdapter } from "../../packages/core/src/agent-job-claude-code.js";
import { conformanceErrorClass } from "../../packages/core/src/runtime-turn-error-class.js";

// Conformance harness for the Claude Code *job-attempt* adapter
// (packages/core/src/agent-job-claude-code.js) driven against
// fakes/fake-claude-code.mjs. Unlike claude-code-harness.js it needs no thread
// record: it calls adapter.run(ctx, input) the way the Agent Job runner does.
// The tool scenario goes through the real PreToolUse hook script and the
// per-attempt permission broker. No Claude login or network access is needed.

const fakePath = fileURLToPath(new URL("./fakes/fake-claude-code.mjs", import.meta.url));

export const claudeCodeJobConformance = {
  name: "claude-code-job",
  capabilities: [
    "turn.start",
    "turn.final_output",
    "turn.streaming",
    "turn.cancel",
    "session.resume",
    "tools.approval",
    "errors.auth",
    "errors.transient",
    "errors.permanent",
  ],
  gaps: {
    "input.idempotent": "by design: re-delivered triggers are deduplicated by run admission (run_key), not by the adapter",
  },
  async create() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-claude-job-"));
    const bin = path.join(home, "claude");
    const callsFile = path.join(home, "claude-calls.jsonl");
    const toolsFile = path.join(home, "claude-tools.jsonl");
    // Stands in for the run journal: survives restart().
    const sessionsFile = path.join(home, "sessions.json");
    await fs.writeFile(bin, `#!/bin/sh\nFAKE_CLAUDE_CALLS="${callsFile}" FAKE_CLAUDE_TOOLS="${toolsFile}" exec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
    const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_CODE_BIN: bin, HOME: path.join(home, "host-home"), PATH: process.env.PATH || "" };
    const lines = async (file) => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const sessions = async () => JSON.parse(await fs.readFile(sessionsFile, "utf8").catch(() => "{}"));
    let active = new Map();
    let turns = 0;

    return {
      async startSession({ sessionKey }) {
        return { key: sessionKey };
      },
      async runTurn(session, input, { onEvent = () => {}, onToolRequest = null } = {}) {
        turns += 1;
        const turnId = `job-turn-${turns}`;
        const controller = new AbortController();
        active.set(session.key, controller);
        const toolsBefore = (await lines(toolsFile)).length;
        let tool = null;
        let sessionRef = (await sessions())[session.key] || "";
        const ctx = {
          runId: `conformance-${session.key}`,
          job: "conformance",
          attempt: turns,
          provider: "claude-code",
          env,
          workspace: path.join(home, "workspaces", session.key),
          async prepareWorkspace() {
            await fs.mkdir(ctx.workspace, { recursive: true });
            return { path: ctx.workspace, kind: "directory", repository: null };
          },
          resume: sessionRef ? { sessionRef, attempt: turns - 1, reason: "next conformance turn" } : null,
          signal: controller.signal,
          emit(event) {
            if (event.type === "session.started") sessionRef = event.sessionRef;
            if (event.type === "message.completed") onEvent({ type: "progress", text: event.text });
          },
          async authorizeTool(call) {
            const decision = onToolRequest ? await onToolRequest({ tool: call.tool, input: call.args }) : "deny";
            tool = { requested: call.tool, decision };
            return decision === "approve" ? { decision: "allow" } : { decision: "deny" };
          },
        };
        const runInput = { prompt: `${input.text} [scenario:${input.scenario || "echo"}]`, inputs: {} };
        let result = null;
        let failure = null;
        try {
          result = await claudeCodeJobAdapter.run(ctx, runInput);
        } catch (error) {
          failure = error;
        } finally {
          active.delete(session.key);
        }
        if (sessionRef) await fs.writeFile(sessionsFile, JSON.stringify({ ...(await sessions()), [session.key]: sessionRef }));
        if (tool) tool.executed = (await lines(toolsFile)).length > toolsBefore;
        const status = failure ? "failed" : result?.type === "cancelled" ? "cancelled" : "completed";
        if (status === "completed") onEvent({ type: "final", text: result.output?.text || "" });
        return {
          turnId,
          status,
          duplicate: false,
          providerSessionId: sessionRef,
          output: status === "completed" ? { text: result.output?.text || "" } : null,
          error: failure ? { class: conformanceErrorClass(failure.errorClass), code: String(failure.code || failure.message || "") } : null,
          ...(tool ? { tool } : {}),
        };
      },
      async cancelTurn(session) {
        // Wait until the provider process has started the turn.
        for (let i = 0; i < 500 && !(active.has(session.key) && (await lines(callsFile)).length >= turns); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const controller = active.get(session.key);
        controller?.abort("cancelled");
        return { cancelled: Boolean(controller) };
      },
      async restart() {
        active = new Map();
      },
      async resumeSession(session) {
        const providerSessionId = (await sessions())[session.key] || "";
        return { providerSessionId, resumed: Boolean(providerSessionId) };
      },
      async providerTurnCount() {
        return (await lines(callsFile)).length;
      },
      async teardown() {
        await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  },
};
