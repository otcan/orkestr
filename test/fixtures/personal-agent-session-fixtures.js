import { createPersonalAgentSessionManager } from "../../packages/core/src/personal-agent-session-manager.js";

// Trusted synthetic authorization projection; canonical conversations have no
// owner column. Production must inject its actual owner-authenticated resolver.
export function resolveSessionConversation(id, { ownerUserId }) {
  const rows = {
    "conversation-global": { id, scopeKind: "global", scopeId: null },
    "conversation-project": { id, scopeKind: "project", scopeId: "project-example" },
  };
  return ownerUserId === "owner" ? rows[id] || null : null;
}

// A fake of Lane A's prepared CAS store, never a production database/schema.
export function sessionStore({ now = Date.now } = {}) {
  const rows = new Map();
  let sequence = 0;
  const clone = value => value == null ? null : structuredClone(value);
  const active = row => ["starting", "ready", "busy", "blocked"].includes(row.lifecycle);
  const error = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
  function required(id) {
    const row = rows.get(id);
    if (!row) throw error("personal_agent_session_not_found", 404);
    return row;
  }
  function persist(row) {
    for (const other of rows.values()) {
      if (other.id === row.id) continue;
      if (row.role !== "worker" && active(row) && active(other) && other.conversationId === row.conversationId && other.role === row.role) throw new Error("active role conflict");
      if (row.nativeSessionId !== null && row.provider === other.provider && row.accountProfileId === other.accountProfileId && row.nativeSessionId === other.nativeSessionId) {
        throw Object.assign(new Error("agent_session_native_identity_reused"), { code: "agent_session_native_identity_reused" });
      }
    }
    rows.set(row.id, clone(row));
    return clone(row);
  }
  return {
    create(input) {
      if (rows.has(input.id)) throw new Error("duplicate session");
      const { ownerUserId: _transientOwner, ...record } = input;
      return persist({ ...record, scopeId: input.scopeId ?? null, modelProfile: input.modelProfile ?? {},
        nativeSessionId: input.nativeSessionId ?? null, forkFromSessionId: input.forkFromSessionId ?? null,
        lifecycle: input.lifecycle ?? "starting", blockedReason: input.blockedReason ?? null, heartbeatAt: input.heartbeatAt ?? null,
        version: 0, leaseToken: null, leaseExpiresAt: null });
    },
    get: id => clone(rows.get(id)),
    list: ({ conversationId, scopeKind, scopeId = null, roles, lifecycles }) => [...rows.values()]
      .filter(row => row.conversationId === conversationId && row.scopeKind === scopeKind && row.scopeId === scopeId && (!roles || roles.includes(row.role)) && (!lifecycles || lifecycles.includes(row.lifecycle))).map(clone),
    acquireLease(id, { expectedVersion, ttlMs }) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw error("personal_agent_session_invalid_lease_ttl", 400);
      const row = required(id);
      if (row.version !== expectedVersion || (row.leaseToken !== null || row.lifecycle === "busy")) return null;
      const session = persist({ ...row, version: row.version + 1, leaseToken: `lease-${++sequence}`, leaseExpiresAt: now() + ttlMs, updatedAt: new Date(now()).toISOString() });
      return { session, leaseToken: session.leaseToken };
    },
    update(id, { expectedVersion, leaseToken, patch }) {
      const row = required(id);
      if (row.version !== expectedVersion || leaseToken == null || row.leaseToken !== leaseToken || row.leaseExpiresAt <= now()) return null;
      const next = { ...row };
      for (const key of ["lifecycle", "blockedReason", "nativeSessionId", "heartbeatAt", "modelProfile"]) if (patch[key] !== undefined) next[key] = key === "lifecycle" ? patch[key] ?? row[key] : patch[key];
      next.leaseToken = patch.releaseLease ? null : leaseToken;
      next.leaseExpiresAt = patch.releaseLease ? null : now() + (patch.leaseTtlMs ?? Math.max(1, row.leaseExpiresAt - now()));
      if (next.leaseExpiresAt !== null && !Number.isSafeInteger(next.leaseExpiresAt)) throw error("personal_agent_session_invalid_lease_ttl", 400);
      return persist({ ...next, version: row.version + 1, updatedAt: new Date(now()).toISOString() });
    },
    // Explicit test-only fault injection. Normal manager writes use CAS above.
    tamper(id, patch) { rows.set(id, { ...rows.get(id), ...clone(patch) }); },
  };
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
  const store = options.store || sessionStore({ now: options.now });
  const settings = { store, resolveConversation: resolveSessionConversation, ownerUserId: "owner", authorizeOwner: owner => owner === "owner", runtimes: { codex: adapter }, env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" }, ...options };
  return { store, adapter, calls, manager: createPersonalAgentSessionManager(settings), another: () => createPersonalAgentSessionManager(settings) };
}
