import { sessionError, sessionId } from "./personal-agent-session-records.js";

export const activeSessionLifecycles = ["starting", "ready", "busy", "blocked"];
export const storedSessionProfile = row => ({ provider: row.provider, accountProfileId: row.accountProfileId, model: row.modelProfile?.model, effort: row.modelProfile?.effort ?? null });

// The prepared store's short methods are synchronous. Each mutation owns its
// BEGIN IMMEDIATE/CAS transaction; a provider await never holds a transaction.
// resolveConversation is a trusted, owner-authorized projection of the canonical
// conversation, not a synthetic HTTP principal or a new owner column in SQLite.
export function sessionAccess({ store, ownerUserId, resolveConversation, enabled, now, holderId, leaseMs }) {
  const time = () => new Date(now()).toISOString();
  function conversation(id) {
    enabled();
    return resolveConversation?.(sessionId(id), { ownerUserId }) || null;
  }
  function owned(id) {
    enabled();
    const row = store.get(sessionId(id));
    if (!row) throw sessionError("agent_session_not_found", 404);
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
    const row = owned(id);
    // Even if the store can reclaim an expired lease, this manager cannot prove
    // the former provider turn stopped. No expired-token takeover here.
    available(row);
    const result = store.acquireLease(id, { expectedVersion: row.version, holderId, ttlMs: leaseMs });
    if (!result || result.leaseToken !== result.session.leaseToken) throw sessionError("agent_session_lease_conflict");
    return result.session;
  }
  function currentLease(row) {
    const current = owned(row.id);
    if (current.leaseToken !== row.leaseToken || !Number.isSafeInteger(current.leaseExpiresAt) || current.leaseExpiresAt <= now()) throw sessionError("agent_session_lease_lost");
    return current;
  }
  function fenced(row, patch, release = false) {
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
    return result;
  }
  return { conversation, owned, available, claim, currentLease, fenced, time };
}
