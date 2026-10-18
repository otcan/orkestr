import { randomUUID } from "node:crypto";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { sessionBlockedReason, sessionError, sessionId, sessionProfile, sessionScope } from "./personal-agent-session-records.js";

// Store contract: synchronous transaction(fn) with get, conversation, findRole,
// findNative, insert, replace. Lane A owns its SQLite implementation/migration.
// All runtime awaits happen OUTSIDE the transaction. A fenced lease serializes
// even separate manager instances; expired busy leases require reconciliation,
// never an automatic overlapping turn on a possibly still-running provider.
export function createPersonalAgentSessionManager({ store, ownerUserId, runtimes, env = process.env, now = Date.now, newId = randomUUID, leaseMs = 30_000 } = {}) {
  sessionId(ownerUserId);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw sessionError("agent_session_lease_invalid", 400);
  const enabled = () => { if (!personalAgentFeature(env)) throw sessionError("personal_agent_disabled", 404); };
  const transaction = fn => { enabled(); return store.transaction(fn); };
  const time = () => new Date(now()).toISOString();
  const owned = (tx, id) => {
    const row = tx.get(sessionId(id));
    if (!row || row.ownerUserId !== ownerUserId) throw sessionError("agent_session_not_found", 404);
    const conversation = tx.conversation(row.conversationId);
    if (!conversation || conversation.ownerUserId !== ownerUserId || conversation.scopeKind !== row.scopeKind || conversation.scopeId !== row.scopeId) {
      throw sessionError("agent_session_scope_unavailable", 404);
    }
    return row;
  };
  const save = (tx, row, patch) => {
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: time() };
    if (next.nativeSessionId) {
      const other = tx.findNative(next.provider, next.accountProfileId, next.nativeSessionId);
      if (other && other.id !== next.id) throw sessionError("agent_session_native_identity_reused");
    }
    tx.replace(next);
    return next;
  };
  function claim(id) {
    return transaction(tx => {
      const row = owned(tx, id);
      if (row.leaseToken) {
        throw sessionError(Date.parse(row.leaseExpiresAt) <= now() ? "agent_session_reconciliation_required" : "agent_session_busy");
      }
      return save(tx, row, { leaseToken: newId(), leaseExpiresAt: new Date(now() + leaseMs).toISOString(), heartbeatAt: time() });
    });
  }
  function fenced(row, patch, release = false) {
    return transaction(tx => {
      const current = owned(tx, row.id);
      if (current.leaseToken !== row.leaseToken || Date.parse(current.leaseExpiresAt) <= now()) throw sessionError("agent_session_lease_lost");
      return save(tx, current, { ...patch, ...(release ? { leaseToken: null, leaseExpiresAt: null } : {}), heartbeatAt: time() });
    });
  }
  async function leased(id, operation) {
    const row = claim(id);
    const controller = new AbortController();
    let lost = false;
    const timer = setInterval(() => {
      try { fenced(row, { leaseExpiresAt: new Date(now() + leaseMs).toISOString() }); }
      catch { lost = true; controller.abort("lease_lost"); }
    }, Math.max(25, Math.floor(leaseMs / 3)));
    timer.unref?.();
    try {
      const result = await operation(row, controller.signal, patch => fenced(row, patch));
      if (lost) throw sessionError("agent_session_lease_lost");
      return result;
    } catch (error) {
      // A lost fence is intentionally retained for operator reconciliation.
      if (!lost && error?.code !== "agent_session_lease_lost") {
        fenced(row, { lifecycle: "blocked", blockedReason: sessionBlockedReason(error) }, true);
      }
      throw error;
    } finally { clearInterval(timer); }
  }
  async function runtime(row) {
    const adapter = runtimes[row.provider];
    if (!adapter) throw sessionError("agent_session_runtime_unavailable", 503);
    const status = await adapter.probe(row);
    if (!status.available) throw sessionError(status.reason === "rate_limited" ? "agent_session_rate_limited" : status.reason === "authentication_required" ? "agent_session_auth_required" : "agent_session_runtime_unavailable", 503);
    return adapter;
  }
  function ensure({ conversationId, scope: rawScope, role, profile: rawProfile, forkFromSessionId = null }) {
    const scope = sessionScope(rawScope);
    const profile = sessionProfile(rawProfile);
    if (!["fast", "deep", "worker"].includes(role)) throw sessionError("agent_session_role_invalid", 400);
    return transaction(tx => {
      const conversation = tx.conversation(sessionId(conversationId));
      if (!conversation || conversation.ownerUserId !== ownerUserId || conversation.scopeKind !== scope.kind || conversation.scopeId !== scope.id) throw sessionError("agent_session_conversation_not_found", 404);
      if (role !== "worker") {
        const previous = tx.findRole(conversationId, role);
        if (previous) {
          owned(tx, previous.id);
          if (JSON.stringify(previous.profile) !== JSON.stringify(profile)) throw sessionError("agent_session_use_change_profile");
          return previous;
        }
      }
      if (forkFromSessionId) {
        const parent = owned(tx, forkFromSessionId);
        if (parent.conversationId !== conversationId || parent.provider !== profile.provider || parent.accountProfileId !== profile.accountProfileId || !parent.nativeSessionId) throw sessionError("agent_session_fork_invalid");
      }
      const stamp = time();
      const row = { id: `ags_${newId()}`, ownerUserId, conversationId, scopeKind: scope.kind, scopeId: scope.id, role, ...profile, profile,
        nativeSessionId: null, forkFromSessionId, lifecycle: "starting", blockedReason: null, heartbeatAt: null,
        leaseToken: null, leaseExpiresAt: null, version: 1, createdAt: stamp, updatedAt: stamp };
      tx.insert(row);
      return row;
    });
  }
  async function startOrResume(id) {
    return leased(id, async (row, signal) => {
      const adapter = await runtime(row);
      const parent = row.forkFromSessionId && !row.nativeSessionId ? transaction(tx => owned(tx, row.forkFromSessionId)) : null;
      // Fork only idle parents, with the same fence used for normal turns.
      const open = parent
        ? () => leased(parent.id, async (source, parentSignal) => {
          if (source.lifecycle !== "ready") throw sessionError("agent_session_reconciliation_required");
          const result = await adapter.open(row, { parent: source, signal: AbortSignal.any([signal, parentSignal]) });
          fenced(source, {}, true);
          return result;
        })
        : () => adapter.open(row, { signal });
      const result = await open();
      if (result.nativeSessionId) sessionId(result.nativeSessionId);
      if (row.nativeSessionId && result.nativeSessionId !== row.nativeSessionId) throw sessionError("agent_session_native_identity_changed");
      if (!result.nativeSessionId && result.lifecycle !== "starting") throw sessionError("agent_session_native_session_missing");
      return fenced(row, { nativeSessionId: result.nativeSessionId || null, lifecycle: result.lifecycle || "ready", blockedReason: null }, true);
    });
  }
  async function runTurn(id, ctx, input) {
    enabled();
    // This entry point is internal to the Agent Job supervisor, never a raw
    // HTTP tool runner. Preserve its exact authorization/effect callbacks.
    for (const key of ["emit", "authorizeTool", "executeTool", "toolDecision", "prepareWorkspace", "fault"]) {
      if (typeof ctx?.[key] !== "function") throw sessionError("agent_session_supervisor_required", 403);
    }
    if (!ctx.signal || ctx.signal.aborted) throw sessionError("agent_session_cancelled");
    return leased(id, async (row, leaseSignal, update) => {
      const adapter = await runtime(row);
      if (ctx.signal.aborted) {
        fenced(row, {}, true);
        return { type: "cancelled" };
      }
      if (row.lifecycle === "blocked") throw sessionError("agent_session_reconnect_required");
      if (row.forkFromSessionId && !row.nativeSessionId) throw sessionError("agent_session_fork_not_started");
      update({ lifecycle: "busy" });
      const failed = new AbortController();
      const signal = AbortSignal.any([ctx.signal, leaseSignal, failed.signal]);
      let persistenceError = null;
      const check = () => {
        if (persistenceError) throw persistenceError;
        signal.throwIfAborted();
      };
      const guard = callback => async (...args) => {
        check();
        const value = await callback(...args);
        check();
        return value;
      };
      const result = await adapter.run(row, { ...ctx, signal,
        authorizeTool: guard(ctx.authorizeTool), executeTool: guard(ctx.executeTool),
        emit(event) {
          if (persistenceError || signal.aborted) return;
          if (event.type === "session.started") {
            try {
              const nativeSessionId = sessionId(event.sessionRef);
              const current = transaction(tx => owned(tx, id));
              if (current.nativeSessionId && nativeSessionId !== current.nativeSessionId) throw sessionError("agent_session_native_identity_changed");
              update({ nativeSessionId });
            } catch (error) { persistenceError = error; failed.abort("lease_lost"); return; }
          }
          return ctx.emit(event);
        },
      }, input);
      if (persistenceError) throw persistenceError;
      if (leaseSignal.aborted) throw sessionError("agent_session_lease_lost");
      // A late provider success cannot turn an owner cancellation into a reply.
      if (ctx.signal.aborted) {
        fenced(row, { lifecycle: row.lifecycle === "starting" ? "starting" : "ready", blockedReason: null }, true);
        return { type: "cancelled" };
      }
      if (!["final", "cancelled", "park", "expired"].includes(result?.type)) throw sessionError("agent_session_outcome_invalid");
      const current = transaction(tx => owned(tx, id));
      if (result.type === "final" && !current.nativeSessionId) throw sessionError("agent_session_native_session_missing");
      fenced(row, { lifecycle: result.type === "cancelled" && row.lifecycle === "starting" ? "starting" : "ready", blockedReason: null }, true);
      return result;
    });
  }
  return Object.freeze({ ensure, startOrResume, runTurn,
    get: id => transaction(tx => owned(tx, id)),
    async ensureScope(input) {
      enabled();
      const result = {};
      for (const role of ["fast", "deep"]) {
        const row = ensure({ ...input, role, profile: input.profiles[role] });
        try { result[role] = await startOrResume(row.id); }
        catch { result[role] = transaction(tx => owned(tx, row.id)); }
      }
      return result;
    },
    changeProfile(id, input) {
      const profile = sessionProfile(input);
      return transaction(tx => {
        const row = owned(tx, id);
        if (row.leaseToken) throw sessionError("agent_session_busy");
        // Different credentials/providers cannot resume the old native ID.
        if (row.provider !== profile.provider || row.accountProfileId !== profile.accountProfileId) throw sessionError("agent_session_profile_rebind_required");
        return save(tx, row, { ...profile, profile });
      });
    },
  });
}
