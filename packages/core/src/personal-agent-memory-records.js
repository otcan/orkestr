import { memoryError, memoryId, memoryObject, memoryTime, normalizeMemoryCandidate } from "./personal-agent-memory-rules.js";

export function memoryRow(candidate, { id, ownerUserId, at, trust, createdAt = at }) {
  return { id: memoryId(id), idempotency_key: candidate.idempotencyKey, category: candidate.category,
    scope_kind: candidate.scope.kind, scope_id: candidate.scope.id,
    content_json: JSON.stringify(candidate.content), provenance_json: JSON.stringify({ ...candidate.source, trust }),
    source_event_id: candidate.sourceEventId, source_cursor: candidate.sourceCursor,
    consented_by: ownerUserId, consented_at: memoryTime(at), created_at: memoryTime(createdAt), updated_at: at };
}

export function memoryRecord(row, ownerUserId) {
  try {
    if (row.consented_by !== ownerUserId) throw memoryError("memory_store_owner_mismatch");
    const provenance = JSON.parse(row.provenance_json);
    memoryObject(provenance, ["schemaVersion", "sourceKind", "actorId", "origin", "capturedAt", "taskId", "trust"]);
    if (provenance.schemaVersion !== 1 || !["owner_authored", "owner_confirmed"].includes(provenance.trust)) throw memoryError("memory_invalid_provenance");
    const { schemaVersion, trust, ...source } = provenance;
    const candidate = normalizeMemoryCandidate({ category: row.category, scope: { kind: row.scope_kind, id: row.scope_id }, content: JSON.parse(row.content_json), source, sourceEventId: row.source_event_id, sourceCursor: row.source_cursor, idempotencyKey: row.idempotency_key });
    if (trust === "owner_authored" && (source.sourceKind !== "owner" || source.actorId !== ownerUserId)) throw memoryError("memory_invalid_provenance");
    if (source.sourceKind === "owner" && source.actorId !== ownerUserId) throw memoryError("memory_invalid_provenance");
    return { id: memoryId(row.id), category: candidate.category, scope: candidate.scope, content: candidate.content,
      provenance: { ...candidate.source, trust }, sourceEventId: candidate.sourceEventId, sourceCursor: candidate.sourceCursor,
      consentedBy: ownerUserId, consentedAt: memoryTime(row.consented_at), createdAt: memoryTime(row.created_at), updatedAt: memoryTime(row.updated_at) };
  } catch { throw memoryError("memory_stored_record_invalid", 409); }
}

export function candidateFromMemoryRecord(record, idempotencyKey) {
  const { schemaVersion, trust, ...source } = record.provenance;
  return normalizeMemoryCandidate({ category: record.category, scope: record.scope, content: record.content, source,
    sourceEventId: record.sourceEventId, sourceCursor: record.sourceCursor, idempotencyKey });
}
