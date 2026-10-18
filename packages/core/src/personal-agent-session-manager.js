import { randomUUID } from "node:crypto";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { activeSessionLifecycles, sessionAccess, storedSessionProfile } from "./personal-agent-session-access.js";
import { sessionBlockedReason, sessionError, sessionId, sessionIntegrityReason, sessionProfile, sessionScope } from "./personal-agent-session-records.js";

// Native IDs are persisted synchronously before their announcement/effects.
// Lane A supplies the prepared SQLite store; no schema is created here.
export function createPersonalAgentSessionManager({ store, ownerUserId, authorizeOwner, resolveConversation, runtimes, env = process.env, now = Date.now, newId = randomUUID, leaseMs = 30_000 } = {}) {
  sessionId(ownerUserId);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw sessionError("agent_session_lease_invalid", 400);
  const enabled = () => { if (!personalAgentFeature(env)) throw sessionError("personal_agent_disabled", 404); };
  const { conversation, owned, available, claim, currentLease, fenced, time } = sessionAccess({ store, ownerUserId, authorizeOwner, resolveConversation, enabled, now, leaseMs });
  // Transient account/profile authorization context, never persisted ownership.
  const runtimeRow = row => ({ ...row, ...storedSessionProfile(row), ownerUserId });
  async function leased(id, operation, { blockOnFailure = true, cancelSignal } = {}) {
    const row = claim(id);
    const controller = new AbortController();
    let lost = false, admitted = false, setBusy = false;
    const timer = setInterval(() => {
      try { fenced(row, { leaseTtlMs: leaseMs }); }
      catch { lost = true; controller.abort("lease_lost"); }
    }, Math.max(25, Math.floor(leaseMs / 3)));
    timer.unref?.();
    try {
      const result = await operation(row, controller.signal, patch => {
        const updated = fenced(row, patch);
        if (patch.lifecycle === "busy") setBusy = true;
        return updated;
      }, () => { admitted = true; });
      if (lost) throw sessionError("agent_session_lease_lost");
      return result;
    } catch (error) {
      // Stop the provider immediately on failed persistence; never replay it.
      controller.abort("session_operation_failed");
      // A child's error does not identify this session's fence. Revalidate
      // our own token/expiry/CAS history before any cleanup write.
      if (lost) throw sessionError("agent_session_lease_lost");
      const current = currentLease(row);
      // Integrity failures cannot become successful cancellations. An uncertain
      // own fence has already failed above and is never retried for cleanup.
      const integrityReason = sessionIntegrityReason(error);
      if (blockOnFailure && admitted && integrityReason) {
        fenced(row, { lifecycle: "blocked", blockedReason: integrityReason }, true);
        throw error;
      }
      // Discovery cancellation leaves status untouched. Once this turn set busy,
      // restore the same starting/ready state as normal cancellation finalization.
      if (cancelSignal?.aborted) {
        fenced(row, setBusy ? { lifecycle: row.lifecycle === "starting" || !current.nativeSessionId ? "starting" : "ready" } : {}, true);
        return { type: "cancelled" };
      }
      // Eligibility refusals borrow a fence, but must not rewrite status. Once
      // admitted, retain any specific diagnosis already stored by supervision.
      fenced(row, blockOnFailure && admitted ? { lifecycle: "blocked", blockedReason: current.blockedReason ?? sessionBlockedReason(error) } : {}, true);
      throw error;
    } finally { clearInterval(timer); }
  }
  async function runtime(row) {
    const adapter = runtimes[row.provider];
    if (!adapter) throw sessionError("agent_session_runtime_unavailable", 503);
    const status = await adapter.probe(runtimeRow(row));
    if (!status.available) throw sessionError(status.reason === "rate_limited" ? "agent_session_rate_limited" : status.reason === "authentication_required" ? "agent_session_auth_required" : "agent_session_runtime_unavailable", 503);
    return adapter;
  }
  function ensure({ conversationId, scope: rawScope, role, profile: rawProfile, forkFromSessionId = null }) {
    const scope = sessionScope(rawScope);
    const profile = sessionProfile(rawProfile);
    if (!["fast", "deep", "worker"].includes(role)) throw sessionError("agent_session_role_invalid", 400);
    const canonical = conversation(conversationId);
    if (!canonical || canonical.id !== conversationId || canonical.scopeKind !== scope.kind || canonical.scopeId !== scope.id) throw sessionError("agent_session_conversation_not_found", 404);
    const previousRole = () => role === "worker" ? null : store.list({ conversationId, scopeKind: scope.kind, scopeId: scope.id, roles: [role] })
      .find(row => activeSessionLifecycles.includes(row.lifecycle));
    const matching = row => {
      owned(row.id);
      if (JSON.stringify(storedSessionProfile(row)) !== JSON.stringify(profile)) throw sessionError("agent_session_use_change_profile");
      return row;
    };
    const previous = previousRole();
    if (previous) return matching(previous);
    if (forkFromSessionId) {
      const parent = owned(forkFromSessionId);
      if (parent.conversationId !== conversationId || parent.provider !== profile.provider || parent.accountProfileId !== profile.accountProfileId || !parent.nativeSessionId) throw sessionError("agent_session_fork_invalid");
    }
    const stamp = time();
    try {
      return store.create({ id: `ags_${newId()}`, conversationId, scopeKind: scope.kind, scopeId: scope.id, role,
        provider: profile.provider, accountProfileId: profile.accountProfileId, modelProfile: { model: profile.model, effort: profile.effort },
        nativeSessionId: null, forkFromSessionId, lifecycle: "starting", blockedReason: null, heartbeatAt: null, createdAt: stamp, updatedAt: stamp });
    } catch (error) {
      // A concurrent creator may have won the active-role unique constraint.
      const winner = previousRole();
      if (winner) return matching(winner);
      throw error;
    }
  }

  async function startOrResume(id) {
    return leased(id, async (row, signal, _update, admit) => {
      if (row.lifecycle === "blocked") throw sessionError("agent_session_reconnect_required");
      const parent = row.forkFromSessionId && !row.nativeSessionId ? owned(row.forkFromSessionId) : null;
      const open = async (source, dispatchSignal = signal) => {
        admit(); // Local eligibility (including the parent fence) is established.
        const adapter = await runtime(row);
        currentLease(row);
        dispatchSignal.throwIfAborted();
        if (source) currentLease(source);
        return adapter.open(runtimeRow(row), { ...(source ? { parent: runtimeRow(source) } : {}), signal: dispatchSignal });
      };
      // Fork only idle parents, with the same fence used for normal turns.
      // A refused fork leaves both sessions' existing status untouched.
      const result = parent
        ? await leased(parent.id, async (source, parentSignal) => {
          if (source.lifecycle !== "ready") throw sessionError("agent_session_reconciliation_required");
          // The parent heartbeat also cancels a dispatch waiting on discovery.
          const combined = AbortSignal.any([signal, parentSignal]);
          combined.throwIfAborted();
          const result = await open(source, combined);
          fenced(source, {}, true);
          return result;
        }, { blockOnFailure: false })
        : await open();
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
    return leased(id, async (row, leaseSignal, update, admit) => {
      if (row.lifecycle === "blocked") throw sessionError("agent_session_reconnect_required");
      if (row.forkFromSessionId && !row.nativeSessionId) throw sessionError("agent_session_fork_not_started");
      admit();
      const adapter = await runtime(row);
      ctx.signal.throwIfAborted();
      update({ lifecycle: "busy" });
      const failed = new AbortController();
      const signal = AbortSignal.any([ctx.signal, leaseSignal, failed.signal]);
      let persistenceError = null;
      const check = () => {
        if (persistenceError) throw persistenceError;
        signal.throwIfAborted();
        try { currentLease(row); }
        catch (error) { persistenceError = error; failed.abort("lease_lost"); throw error; }
      };
      const guard = callback => async (...args) => {
        check();
        const value = await callback(...args);
        check();
        return value;
      };
      // Native executors select tools synchronously; retain that contract.
      const guardedDecision = (...args) => {
        check();
        const value = ctx.toolDecision(...args);
        check();
        return value;
      };
      const result = await adapter.run(runtimeRow(row), { ...ctx, signal,
        prepareWorkspace: guard(ctx.prepareWorkspace),
        toolDecision: guardedDecision,
        authorizeTool: guard(ctx.authorizeTool), executeTool: guard(ctx.executeTool),
        emit(event) {
          if (persistenceError || signal.aborted) return;
          try { currentLease(row); }
          catch (error) { persistenceError = error; failed.abort("lease_lost"); return; }
          if (event.type === "session.started") {
            try {
              const nativeSessionId = sessionId(event.sessionRef);
              const current = owned(id);
              if (current.nativeSessionId && nativeSessionId !== current.nativeSessionId) throw sessionError("agent_session_native_identity_changed");
              update({ nativeSessionId });
            } catch (error) { persistenceError = error; failed.abort("lease_lost"); return; }
          }
          return ctx.emit(event);
        },
      }, input).catch(error => {
        // Preserve an earlier durable-identity/persistence error even when the
        // native executor subsequently propagates the resulting AbortError.
        throw persistenceError || error;
      });
      if (persistenceError) throw persistenceError;
      if (leaseSignal.aborted) throw sessionError("agent_session_lease_lost");
      const outcomeType = result?.type;
      if (!["final", "cancelled", "park", "expired"].includes(outcomeType)) throw sessionError("agent_session_outcome_invalid");
      const current = owned(id);
      if (outcomeType === "final" && !current.nativeSessionId) throw sessionError("agent_session_native_session_missing");
      // Validate integrity first; a late success still cannot become a reply
      // after owner cancellation. All cancellation cleanup belongs to leased().
      ctx.signal.throwIfAborted();
      fenced(row, { lifecycle: !current.nativeSessionId || (outcomeType === "cancelled" && row.lifecycle === "starting") ? "starting" : "ready", blockedReason: null }, true);
      return result;
    }, { cancelSignal: ctx.signal });
  }
  return Object.freeze({ ensure, startOrResume, runTurn,
    get: owned,
    async ensureScope(input) {
      enabled();
      const result = {};
      for (const role of ["fast", "deep"]) {
        const row = ensure({ ...input, role, profile: input.profiles[role] });
        try { result[role] = await startOrResume(row.id); }
        catch { result[role] = owned(row.id); }
      }
      return result;
    },
    changeProfile(id, input) {
      const profile = sessionProfile(input);
      const row = owned(id);
      available(row);
      // Different credentials/providers cannot resume the old native ID.
      if (row.provider !== profile.provider || row.accountProfileId !== profile.accountProfileId) throw sessionError("agent_session_profile_rebind_required");
      return fenced(claim(id), { modelProfile: { model: profile.model, effort: profile.effort } }, true);
    },
  });
}
