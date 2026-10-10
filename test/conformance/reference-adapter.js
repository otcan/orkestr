import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Minimal reference adapter: a credential-free simulated provider that
// implements every conformance capability. It doubles as executable
// documentation of the harness contract (see docs/spec/conformance.md).
//
// Durable state (sessions, the input ledger, provider turn count) lives in one
// JSON file so restart() can drop every in-memory structure and prove that
// resume and idempotency survive a process restart.

const ERROR_CODES = {
  auth: "reference_auth_required",
  transient: "reference_rate_limited",
  permanent: "reference_invalid_request",
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    }, { once: true });
  });
}

export class ReferenceAdapter {
  constructor({ stateFile, slowMs = 10_000 } = {}) {
    this.stateFile = stateFile;
    this.slowMs = slowMs;
    this.active = new Map();
  }

  async load() {
    try {
      return JSON.parse(await fs.readFile(this.stateFile, "utf8"));
    } catch {
      return { sessions: {}, inputs: {}, providerTurns: 0, nextTurn: 0 };
    }
  }

  async save(state) {
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, this.stateFile);
  }

  async startSession({ sessionKey }) {
    const state = await this.load();
    state.sessions[sessionKey] ||= { providerSessionId: `ref-session-${Object.keys(state.sessions).length + 1}` };
    await this.save(state);
    return { sessionKey, providerSessionId: state.sessions[sessionKey].providerSessionId };
  }

  async resumeSession(session) {
    const state = await this.load();
    const stored = state.sessions[session.sessionKey];
    if (!stored) throw new Error("reference_session_missing");
    return { providerSessionId: stored.providerSessionId, resumed: true };
  }

  async providerTurnCount() {
    return (await this.load()).providerTurns;
  }

  async runTurn(session, input, { onEvent = () => {}, onToolRequest } = {}) {
    let state = await this.load();
    const ledgerKey = `${session.sessionKey}:${input.inputId}`;
    const recorded = state.inputs[ledgerKey];
    if (recorded?.result) return { ...recorded.result, duplicate: true };
    // Record the claim durably before any provider side effect.
    state.nextTurn += 1;
    state.providerTurns += 1;
    const turnId = `ref-turn-${state.nextTurn}`;
    state.inputs[ledgerKey] = { turnId, state: "running" };
    await this.save(state);

    const controller = new AbortController();
    this.active.set(session.sessionKey, controller);
    const base = { turnId, providerSessionId: session.providerSessionId, duplicate: false };
    let result;
    try {
      result = { ...base, ...(await this.execute(input, controller.signal, { onEvent, onToolRequest })) };
    } catch (error) {
      result = error?.code === "cancelled"
        ? { ...base, status: "cancelled", output: null, error: null }
        : { ...base, status: "failed", output: null, error: { class: "permanent", code: String(error?.message || error) } };
    } finally {
      this.active.delete(session.sessionKey);
    }
    state = await this.load();
    state.inputs[ledgerKey] = { turnId, state: result.status, result };
    await this.save(state);
    return result;
  }

  async execute(input, signal, { onEvent, onToolRequest }) {
    const scenario = input.scenario || "echo";
    if (scenario.startsWith("fault:")) {
      const errorClass = scenario.slice("fault:".length);
      return { status: "failed", output: null, error: { class: errorClass, code: ERROR_CODES[errorClass] || "reference_failed" } };
    }
    if (scenario === "progress") onEvent({ type: "progress", text: "reference adapter is working" });
    if (scenario === "slow") await sleep(this.slowMs, signal);
    let tool;
    if (scenario === "tool") {
      const decision = onToolRequest ? await onToolRequest({ tool: "shell", input: { command: "echo conformance" } }) : "deny";
      tool = { requested: true, decision, executed: decision === "approve" };
      if (tool.executed) onEvent({ type: "progress", text: "tool shell executed" });
    }
    const text = `Reply to: ${input.text}`;
    onEvent({ type: "final", text });
    return { status: "completed", output: { text }, error: null, ...(tool ? { tool } : {}) };
  }

  async cancelTurn(session) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const controller = this.active.get(session.sessionKey);
      if (controller) {
        controller.abort();
        return { cancelled: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { cancelled: false };
  }

  async restart() {
    for (const controller of this.active.values()) controller.abort();
    this.active = new Map();
  }
}

export const referenceConformance = {
  name: "reference",
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-reference-"));
    const adapter = new ReferenceAdapter({ stateFile: path.join(dir, "state.json") });
    return {
      startSession: (options) => adapter.startSession(options),
      runTurn: (session, input, options) => adapter.runTurn(session, input, options),
      cancelTurn: (session) => adapter.cancelTurn(session),
      restart: () => adapter.restart(),
      resumeSession: (session) => adapter.resumeSession(session),
      providerTurnCount: () => adapter.providerTurnCount(),
      teardown: () => fs.rm(dir, { recursive: true, force: true }),
    };
  },
};
