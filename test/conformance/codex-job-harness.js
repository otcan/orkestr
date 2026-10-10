import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopCodexJobClients } from "../../packages/core/src/codex-job-client.js";
import { CodexJobSession } from "../../packages/core/src/codex-job-session.js";

// Conformance harness for the Agent Job `codex` executor's provider session
// (packages/core/src/codex-job-session.js): Codex app-server sessions owned by
// a job, with no Orkestr thread record. Runs against
// fakes/fake-codex-app-server.mjs, so no Codex login or network is needed.

const fakePath = fileURLToPath(new URL("./fakes/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const codexJobConformance = {
  name: "codex-job",
  capabilities: [
    "turn.start",
    "turn.final_output",
    "turn.streaming",
    "turn.cancel",
    "session.resume",
    "input.idempotent",
    "tools.approval",
    "errors.auth",
    "errors.transient",
    "errors.permanent",
  ],
  gaps: {},
  async create() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-codex-job-"));
    const bin = path.join(home, "bin", "codex");
    const stateFile = path.join(home, "codex-state.json");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
    const workspace = path.join(home, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr"),
      HOME: path.join(home, "runtime-home"),
      ORKESTR_CODEX_BIN: bin,
      FAKE_CODEX_STATE: stateFile,
    };
    const readFakeState = async () => JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}"));

    return {
      async startSession() {
        const session = new CodexJobSession({ env });
        const opened = await session.open({ cwd: workspace });
        return { session, providerSessionId: opened.sessionRef };
      },
      runTurn(handle, input, { onEvent = () => {}, onToolRequest } = {}) {
        let tool = null;
        const turn = handle.session.runTurn({ inputId: input.inputId, text: `${input.text} [scenario:${input.scenario || "echo"}]` }, {
          onEvent(event) {
            if (event.type !== "message") return;
            onEvent({ type: event.phase === "final_answer" ? "final" : "progress", text: event.text });
          },
          async onServerRequest({ method, params }) {
            if (method !== "item/commandExecution/requestApproval") return { error: "unsupported" };
            const decision = onToolRequest ? await onToolRequest({ tool: "codex.command", input: params }) : "deny";
            tool = { requested: true, decision };
            return { result: { decision: decision === "approve" ? "accept" : "decline" } };
          },
        });
        return turn.then(async (result) => {
          const fake = await readFakeState();
          const executed = Boolean(fake.toolDecisions?.find((entry) => entry.turnId === result.turnId)?.executed);
          return {
            turnId: result.turnId,
            status: result.status,
            duplicate: result.duplicate,
            providerSessionId: handle.session.codexThreadId,
            output: result.status === "completed" ? { text: result.finalText } : null,
            error: result.error ? { class: result.error.class, code: result.error.message } : null,
            ...(tool ? { tool: { ...tool, executed } } : {}),
          };
        });
      },
      async cancelTurn(handle) {
        for (let i = 0; i < 250 && !handle.session.turn; i += 1) await sleep(20);
        return { cancelled: (await handle.session.interrupt()).interrupted === true };
      },
      async restart() {
        stopCodexJobClients();
      },
      async resumeSession(handle) {
        handle.session.close();
        handle.session = new CodexJobSession({ env });
        const opened = await handle.session.open({ sessionRef: handle.providerSessionId, cwd: workspace });
        const calls = (await readFakeState()).calls || [];
        return { providerSessionId: opened.sessionRef, resumed: opened.resumed && calls.some((call) => call.method === "thread/resume" && call.threadId === opened.sessionRef) };
      },
      async providerTurnCount() {
        return (await readFakeState()).turnStarts || 0;
      },
      async teardown() {
        stopCodexJobClients();
        await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  },
};
