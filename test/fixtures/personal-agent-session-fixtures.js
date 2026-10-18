import { createPersonalAgentSessionManager } from "../../packages/core/src/personal-agent-session-manager.js";

// Deliberately a fake store, not a second schema or database. The schema lane
// supplies the SQLite transaction implementation against agent-jobs.sqlite.
export function sessionStore() {
  let rows = new Map();
  const conversations = new Map([
    ["conversation-global", { id: "conversation-global", ownerUserId: "owner", scopeKind: "global", scopeId: null }],
    ["conversation-project", { id: "conversation-project", ownerUserId: "owner", scopeKind: "project", scopeId: "project-example" }],
    ["conversation-other", { id: "conversation-other", ownerUserId: "other", scopeKind: "global", scopeId: null }],
  ]);
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const store = {
    transaction(fn) {
      const before = clone(rows);
      const tx = {
        get: id => clone(rows.get(id)),
        conversation: id => clone(conversations.get(id)),
        findRole: (id, role) => clone([...rows.values()].find(row => row.conversationId === id && row.role === role)),
        findNative: (provider, profile, native) => clone([...rows.values()].find(row => row.provider === provider && row.accountProfileId === profile && row.nativeSessionId === native)),
        insert(row) { if (rows.has(row.id)) throw new Error("duplicate"); rows.set(row.id, clone(row)); },
        replace(row) { if (!rows.has(row.id)) throw new Error("missing"); rows.set(row.id, clone(row)); },
      };
      try { return clone(fn(tx)); } catch (error) { rows = before; throw error; }
    },
  };
  return store;
}

export const sessionProfile = { provider: "codex", accountProfileId: "profile-example", model: "gpt-example", effort: "high" };
export const sessionInput = { conversationId: "conversation-global", scope: { kind: "global" }, role: "fast", profile: sessionProfile };
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function supervisor(signal = new AbortController().signal) {
  const events = [];
  return { signal, events, emit: event => events.push(event), authorizeTool: async () => ({ decision: "deny" }),
    executeTool: async () => ({ status: "denied" }), toolDecision: () => "deny", fault() {},
    prepareWorkspace: async () => ({ path: "/tmp/example-project", kind: "project" }) };
}
export function sessionHarness(options = {}) {
  let sequence = 0;
  const calls = [];
  const adapter = {
    async probe(row) { calls.push(["probe", row.id]); return { available: true }; },
    async open(row, { parent } = {}) { calls.push(["open", row.id]); return { nativeSessionId: row.nativeSessionId || `native-${++sequence}`, lifecycle: "ready", ...(parent ? { forked: true } : {}) }; },
    async run(row, ctx) { calls.push(["run", row.id]); ctx.emit({ type: "session.started", sessionRef: row.nativeSessionId || `native-${++sequence}` }); return { type: "final", output: { text: "synthetic result" } }; },
  };
  const store = options.store || sessionStore();
  const settings = { store, ownerUserId: "owner", runtimes: { codex: adapter }, env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" }, ...options };
  return { store, adapter, calls, manager: createPersonalAgentSessionManager(settings), another: () => createPersonalAgentSessionManager(settings) };
}
