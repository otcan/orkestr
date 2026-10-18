import { sessionError, sessionId } from "./personal-agent-session-records.js";

export const activeSessionLifecycles = ["starting", "ready", "busy", "blocked"];
export const storedSessionProfile = row => ({ provider: row.provider, accountProfileId: row.accountProfileId, model: row.modelProfile?.model, effort: row.modelProfile?.effort ?? null });

// The canonical store groups validation and CAS writes in one short transaction.
// Persisted ownership supplements the single-user app's authenticated context.
export function sessionAccess({ store, ownerUserId, authorizeOwner, resolveConversation, enabled, now, leaseMs }) {
  const time = () => new Date(now()).toISOString();
  function authorized() {
    enabled();
    if (typeof authorizeOwner !== "function" || authorizeOwner(ownerUserId) !== true) throw sessionError("agent_session_owner_required", 403);
  }
  function atomic(operation) {
    authorized();
    if (typeof store?.transaction !== "function") throw sessionError("agent_session_store_unavailable", 503);
    const result = store.transaction(operation);
    if (result && typeof result.then === "function") throw sessionError("agent_session_store_unavailable", 503);
    return result;
  }
  function conversation(id) {
    authorized();
    if (typeof resolveConversation !== "function") throw sessionError("agent_session_store_unavailable", 503);
    const canonical = resolveConversation(sessionId(id), { ownerUserId });
    if (canonical && typeof canonical.then === "function") throw sessionError("agent_session_store_unavailable", 503);
    if (canonical && (canonical.id !== id || !(canonical.scopeKind === "global" && canonical.scopeId === null || canonical.scopeKind === "project" && typeof canonical.scopeId === "string" && canonical.scopeId.length > 0))) throw sessionError("agent_session_scope_unavailable", 404);
    return canonical;
  }
  function owned(id) {
    authorized();
    const row = store.get(sessionId(id));
    if (!row || row.id !== id) throw sessionError("agent_session_not_found", 404);
    if (row.ownerUserId !== ownerUserId) throw sessionError("agent_session_owner_required", 403);
    const scope = conversation(row.conversationId);
    if (!scope) throw sessionError("agent_session_not_found", 404);
    if (scope.id !== row.conversationId || scope.scopeKind !== row.scopeKind || scope.scopeId !== row.scopeId) throw sessionError("agent_session_scope_unavailable", 404);
    return row;
  }
  function available(row) {
    if (row.leaseToken) throw sessionError(row.leaseExpiresAt <= now() ? "agent_session_reconciliation_required" : "agent_session_busy");
    if (row.lifecycle === "stopped") throw sessionError("agent_session_stopped");
    if (row.lifecycle === "busy") throw sessionError("agent_session_reconciliation_required");
  }
  function claim(id) {
    return atomic(() => {
      const row = owned(id);
      // Expiry alone never proves that a native turn has stopped.
      available(row);
      const result = store.acquireLease(id, { expectedVersion: row.version, ttlMs: leaseMs });
      if (!result || result.leaseToken !== result.session.leaseToken) throw sessionError("agent_session_lease_conflict");
      sameBinding(row, result.session);
      return result.session;
    });
  }
  function sameBinding(before, after) {
    for (const key of ["id", "ownerUserId", "conversationId", "scopeKind", "scopeId", "role", "provider", "accountProfileId", "forkFromSessionId"]) {
      if (before[key] !== after[key]) throw sessionError("agent_session_binding_changed");
    }
  }
  function currentLease(row) {
    const current = owned(row.id);
    sameBinding(row, current);
    if (current.leaseToken !== row.leaseToken || !Number.isSafeInteger(current.leaseExpiresAt) || current.leaseExpiresAt <= now()) throw sessionError("agent_session_lease_lost");
    return current;
  }
  function fenced(row, patch, release = false) {
    return atomic(() => {
      const current = currentLease(row);
      let result;
      try {
        result = store.update(row.id, { expectedVersion: current.version, leaseToken: row.leaseToken,
          patch: { ...patch, releaseLease: release, heartbeatAt: time() } });
      } catch (error) {
        // SQLite's native-identity unique constraint is the final authority,
        // including sessions in other conversations and stopped sessions.
        if (error?.code === "agent_session_native_identity_reused" || /UNIQUE constraint failed: personal_agent_sessions\.provider, personal_agent_sessions\.account_profile_id, personal_agent_sessions\.native_session_id/.test(String(error?.message))) {
          throw sessionError("agent_session_native_identity_reused");
        }
        throw error;
      }
      if (!result) throw sessionError("agent_session_lease_lost");
      sameBinding(current, result);
      return result;
    });
  }
  return { atomic, conversation, owned, available, claim, currentLease, fenced, time };
}
