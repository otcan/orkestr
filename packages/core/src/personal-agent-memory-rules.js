import { createHash } from "node:crypto";

export const MEMORY_CATEGORIES = Object.freeze(["preference", "fact", "decision", "commitment", "open_loop", "project_summary"]);
const sourceKinds = ["owner", "assistant", "worker", "web", "connector", "automation"];
const contentFields = {
  preference: ["key", "value"], fact: ["statement"], decision: ["summary", "rationale"],
  commitment: ["summary", "taskId", "dueAt"], open_loop: ["summary", "taskId", "dueAt"], project_summary: ["summary"],
};

export function memoryError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

export function memoryObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !fields.includes(key))) throw memoryError("memory_invalid_fields");
}

export function memoryText(value, max = 4096) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw memoryError("memory_invalid_text");
  return value.trim();
}

export function memoryId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw memoryError("memory_invalid_id");
  return value;
}

export function memoryTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw memoryError("memory_invalid_time");
  return value;
}

function reference(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[!-~]{1,256}$/.test(value)) throw memoryError("memory_invalid_reference");
  return value;
}

export function normalizeMemoryCandidate(input) {
  memoryObject(input, ["category", "scope", "content", "source", "sourceEventId", "sourceCursor", "idempotencyKey"]);
  if (!MEMORY_CATEGORIES.includes(input.category)) throw memoryError("memory_invalid_category");
  memoryObject(input.scope, ["kind", "id"]);
  const scope = { kind: input.scope.kind, id: input.scope.id ?? null };
  if (scope.kind === "owner") { if (scope.id !== null) throw memoryError("memory_invalid_scope"); }
  else if (scope.kind === "project") memoryId(scope.id);
  else throw memoryError("memory_invalid_scope");
  if (input.category === "project_summary" && scope.kind !== "project") throw memoryError("memory_project_scope_required");
  memoryObject(input.content, contentFields[input.category]);
  const content = {};
  const required = input.category === "preference" ? ["key", "value"] : input.category === "fact" ? ["statement"] : ["summary"];
  for (const key of required) content[key] = memoryText(input.content[key], key === "key" ? 128 : input.category === "project_summary" ? 8192 : 4096);
  if (input.content.rationale !== undefined) content.rationale = memoryText(input.content.rationale, 2048);
  if (input.content.taskId !== undefined) content.taskId = memoryId(input.content.taskId);
  if (input.content.dueAt !== undefined) content.dueAt = memoryTime(input.content.dueAt);
  memoryObject(input.source, ["sourceKind", "actorId", "origin", "capturedAt", "taskId"]);
  if (!sourceKinds.includes(input.source.sourceKind)) throw memoryError("memory_invalid_source");
  const origin = memoryId(input.source.origin);
  if (origin.length > 64) throw memoryError("memory_invalid_source");
  const source = { schemaVersion: 1, sourceKind: input.source.sourceKind, actorId: memoryId(input.source.actorId), origin, capturedAt: memoryTime(input.source.capturedAt) };
  if (input.source.taskId !== undefined) source.taskId = memoryId(input.source.taskId);
  if (source.taskId && content.taskId && source.taskId !== content.taskId) throw memoryError("memory_task_mismatch");
  if ((source.taskId || content.taskId) && scope.kind !== "project") throw memoryError("memory_project_scope_required");
  return { category: input.category, scope, content, source, sourceEventId: reference(input.sourceEventId), sourceCursor: reference(input.sourceCursor), idempotencyKey: input.idempotencyKey == null ? null : memoryId(input.idempotencyKey) };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function memoryDigest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }

export function prepareMemoryCapture(input, { operation = "create", memoryId: target = null, expectedUpdatedAt = null } = {}) {
  if (!["create", "correct"].includes(operation)) throw memoryError("memory_invalid_operation");
  if (operation === "create" && (target !== null || expectedUpdatedAt !== null)) throw memoryError("memory_invalid_operation");
  if (operation === "correct") { memoryId(target); memoryTime(expectedUpdatedAt); }
  const candidate = normalizeMemoryCandidate(input);
  const proposal = { operation, memoryId: target, expectedUpdatedAt, candidate };
  return { ...proposal, digest: memoryDigest(proposal) };
}

export function verifyMemoryProposal(value) {
  memoryObject(value, ["operation", "memoryId", "expectedUpdatedAt", "candidate", "digest"]);
  const source = value.candidate?.source;
  // schemaVersion is generated by the normalizer, not accepted from source text.
  if (source?.schemaVersion !== 1) throw memoryError("memory_invalid_source");
  const { schemaVersion, ...baseSource } = source;
  const normalized = prepareMemoryCapture({ ...value.candidate, source: baseSource }, value);
  if (value.digest !== normalized.digest) throw memoryError("memory_proposal_changed", 409);
  return normalized;
}

export function memoryConsent(proposal, consent, ownerUserId) {
  if (!consent) throw memoryError("memory_explicit_consent_required", 403);
  memoryObject(consent, ["action", "digest"]);
  if (consent.digest !== proposal.digest) throw memoryError("memory_consent_mismatch", 403);
  const source = proposal.candidate.source;
  if (source.sourceKind === "owner" && source.actorId !== ownerUserId) throw memoryError("memory_source_owner_mismatch", 403);
  if (proposal.operation === "correct") {
    if (consent.action !== "correct") throw memoryError("memory_explicit_consent_required", 403);
  } else if (!["remember", "approve"].includes(consent.action)) throw memoryError("memory_explicit_consent_required", 403);
  if (consent.action === "remember" && source.sourceKind !== "owner") throw memoryError("memory_owner_confirmation_required", 403);
  return source.sourceKind === "owner" && consent.action !== "approve" ? "owner_authored" : "owner_confirmed";
}
