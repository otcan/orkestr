import { randomUUID } from "node:crypto";
import { isAdminPrincipal } from "./policy.js";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { memoryConsent, memoryDigest, memoryError, memoryId, memoryObject, memoryTime, prepareMemoryCapture, verifyMemoryProposal } from "./personal-agent-memory-rules.js";
import { candidateFromMemoryRecord, memoryRecord, memoryRow } from "./personal-agent-memory-records.js";
import { assembleMemoryContext, memoryQuery, scopedMemoryRecords } from "./personal-agent-memory-context.js";

// Inject a single-owner store. All transaction callback methods are synchronous;
// an SQL binding must supply atomicity, not a second database or memory schema.
export function createPersonalAgentMemoryService({ store, ownerUserId, env = process.env, now = () => new Date().toISOString(), newId = () => `mem_${randomUUID()}` }) {
  memoryId(ownerUserId);
  if (!store || store.ownerUserId !== ownerUserId || typeof store.transaction !== "function") throw memoryError("memory_store_required", 503);
  const authorize = request => {
    if (!personalAgentFeature(env)) throw memoryError("personal_agent_disabled", 404);
    const principal = request?.orkestrPrincipal;
    if (request?.orkestrAnonymous || request?.orkestrMachineAuth || principal?.kind !== "user" || principal?.userId !== ownerUserId || !isAdminPrincipal(principal)) throw memoryError("memory_owner_required", 403);
  };
  const transaction = fn => {
    const result = store.transaction(fn);
    if (result && typeof result.then === "function") throw memoryError("memory_store_must_be_synchronous", 503);
    return result;
  };
  const get = (tx, id) => {
    const row = tx.get(memoryId(id));
    if (!row) throw memoryError("memory_not_found", 404);
    return { row, record: memoryRecord(row, ownerUserId) };
  };
  const links = (tx, candidate) => {
    if (candidate.scope.kind === "project" && !tx.hasProject(candidate.scope.id)) throw memoryError("memory_project_not_found", 404);
    for (const taskId of new Set([candidate.source.taskId, candidate.content.taskId].filter(Boolean))) {
      if (tx.taskProjectId(taskId) !== candidate.scope.id) throw memoryError("memory_task_scope_mismatch", 403);
    }
  };
  const records = (tx, options = {}) => {
    const rows = tx.list();
    if (!Array.isArray(rows) || rows.length > 5000) throw memoryError("memory_store_limit", 503);
    const selected = options.allProjects ? rows : rows.filter(row => row.scope_kind === "owner" || options.projectId != null && row.scope_kind === "project" && row.scope_id === options.projectId);
    return selected.map(row => memoryRecord(row, ownerUserId));
  };
  const ensureQueryProject = (tx, projectId) => { if (projectId !== null && !tx.hasProject(projectId)) throw memoryError("memory_project_not_found", 404); };
  return Object.freeze({
    // A proposal is transient data, never a persisted approval or bearer token.
    propose(input, request) {
      authorize(request);
      return prepareMemoryCapture(input);
    },
    create(proposal, request, consent) {
      authorize(request);
      const prepared = verifyMemoryProposal(proposal);
      if (prepared.operation !== "create") throw memoryError("memory_invalid_operation");
      if (!prepared.candidate.idempotencyKey) throw memoryError("memory_idempotency_required");
      const trust = memoryConsent(prepared, consent, ownerUserId);
      return transaction(tx => {
        links(tx, prepared.candidate);
        const previous = tx.findByIdempotencyKey(prepared.candidate.idempotencyKey);
        if (previous) {
          const record = memoryRecord(previous, ownerUserId);
          if (memoryDigest(candidateFromMemoryRecord(record, previous.idempotency_key)) !== memoryDigest(prepared.candidate)) throw memoryError("memory_idempotency_conflict", 409);
          return { record, deduplicated: true };
        }
        const row = memoryRow(prepared.candidate, { id: newId(), ownerUserId, at: now(), trust });
        tx.insert(row);
        return { record: memoryRecord(row, ownerUserId), deduplicated: false };
      });
    },
    proposeCorrection(id, input, request) {
      authorize(request);
      memoryObject(input, ["content", "source", "sourceEventId", "sourceCursor"]);
      return transaction(tx => {
        const { row, record } = get(tx, id);
        return prepareMemoryCapture({ ...input, category: record.category, scope: record.scope, idempotencyKey: row.idempotency_key }, { operation: "correct", memoryId: id, expectedUpdatedAt: record.updatedAt });
      });
    },
    correct(proposal, request, consent) {
      authorize(request);
      const prepared = verifyMemoryProposal(proposal);
      if (prepared.operation !== "correct") throw memoryError("memory_invalid_operation");
      const trust = memoryConsent(prepared, consent, ownerUserId);
      return transaction(tx => {
        const { row, record } = get(tx, prepared.memoryId);
        if (prepared.expectedUpdatedAt !== row.updated_at) throw memoryError("memory_correction_stale", 409);
        if (prepared.candidate.category !== record.category || memoryDigest(prepared.candidate.scope) !== memoryDigest(record.scope) || prepared.candidate.idempotencyKey !== row.idempotency_key) throw memoryError("memory_correction_scope_changed", 409);
        links(tx, prepared.candidate);
        const at = new Date(Math.max(Date.parse(memoryTime(now())), Date.parse(row.updated_at) + 1)).toISOString();
        const replacement = memoryRow(prepared.candidate, { id: row.id, ownerUserId, at, trust, createdAt: row.created_at });
        tx.replace(row.id, replacement);
        return memoryRecord(replacement, ownerUserId);
      });
    },
    proposeForget(id, request) {
      authorize(request);
      return transaction(tx => {
        const { row } = get(tx, id);
        const proposal = { operation: "forget", memoryId: row.id, expectedUpdatedAt: row.updated_at };
        return { ...proposal, digest: memoryDigest(proposal) };
      });
    },
    forget(proposal, request, consent) {
      authorize(request);
      memoryObject(proposal, ["operation", "memoryId", "expectedUpdatedAt", "digest"]);
      memoryObject(consent, ["action", "digest"]);
      const bound = { operation: "forget", memoryId: memoryId(proposal.memoryId), expectedUpdatedAt: memoryTime(proposal.expectedUpdatedAt) };
      if (proposal.operation !== "forget" || proposal.digest !== memoryDigest(bound) || consent.action !== "forget" || consent.digest !== proposal.digest) throw memoryError("memory_consent_mismatch", 403);
      return transaction(tx => {
        const { row } = get(tx, bound.memoryId);
        if (row.updated_at !== bound.expectedUpdatedAt) throw memoryError("memory_forget_stale", 409);
        tx.delete(row.id); return { id: row.id, forgotten: true };
      });
    },
    retrieve(options, request) {
      authorize(request);
      const query = memoryQuery(options);
      return transaction(tx => { ensureQueryProject(tx, query.projectId); return scopedMemoryRecords(records(tx, query), { ...query, ownerUserId }).slice(0, query.limit); });
    },
    context(options = {}, request) {
      authorize(request);
      const query = memoryQuery(options);
      return transaction(tx => { ensureQueryProject(tx, query.projectId); return assembleMemoryContext(records(tx, query), { ...options, ownerUserId }); });
    },
    export(request) {
      authorize(request);
      return transaction(tx => ({ schemaVersion: 1, records: records(tx, { allProjects: true }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }));
    },
  });
}
