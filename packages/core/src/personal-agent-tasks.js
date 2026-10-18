import { newId, nowIso, openAgentJobDb, stableStringify, tx } from "./agent-job-store.js";
import { personalAgentFeature } from "./personal-agent-feature.js";

export const PERSONAL_AGENT_TASK_STATES = Object.freeze([
  "queued", "running", "blocked", "needs_approval", "succeeded", "failed", "cancelled",
]);

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
const transitions = Object.freeze({
  queued: new Set(["running", "cancelled", "blocked", "needs_approval"]),
  running: new Set(["blocked", "needs_approval", "succeeded", "failed", "cancelled"]),
  blocked: new Set(["queued", "running", "needs_approval", "cancelled", "failed"]),
  needs_approval: new Set(["queued", "running", "blocked", "cancelled", "failed"]),
});
const actorKinds = new Set(["owner", "assistant", "worker", "system", "connector"]);
const priorities = new Set(["low", "normal", "high"]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function nonEmpty(value, code) {
  const result = String(value ?? "").trim();
  if (!result) fail(code);
  return result;
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function normalizeContract(input) {
  object(input, "personal_agent_task_contract_invalid");
  const acceptanceCriteria = input.acceptanceCriteria;
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) fail("personal_agent_task_acceptance_required");
  const criteria = acceptanceCriteria.map((criterion, index) => {
    if (typeof criterion === "string") {
      return { id: `criterion-${index + 1}`, description: nonEmpty(criterion, "personal_agent_task_acceptance_invalid") };
    }
    object(criterion, "personal_agent_task_acceptance_invalid");
    return {
      id: nonEmpty(criterion.id, "personal_agent_task_acceptance_invalid"),
      description: nonEmpty(criterion.description, "personal_agent_task_acceptance_invalid"),
    };
  });
  if (new Set(criteria.map(({ id }) => id)).size !== criteria.length) fail("personal_agent_task_acceptance_duplicate_id");

  const scope = object(input.scope, "personal_agent_task_scope_required");
  if (!Array.isArray(scope.permissions) || scope.permissions.some((permission) => typeof permission !== "string" || !permission.trim())) {
    fail("personal_agent_task_permissions_invalid");
  }
  if (!Array.isArray(input.dependencies ?? [])) fail("personal_agent_task_dependencies_invalid");
  const priority = input.priority ?? "normal";
  if (!priorities.has(priority)) fail("personal_agent_task_priority_invalid");
  const budget = object(input.budget, "personal_agent_task_budget_required");
  for (const key of ["maxAttempts", "maxRuntimeMs"]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0) fail("personal_agent_task_budget_invalid");
  }
  const dependencies = [...new Set((input.dependencies ?? []).map((item) => nonEmpty(item, "personal_agent_task_dependencies_invalid")))];
  return {
    title: nonEmpty(input.title, "personal_agent_task_title_required"),
    outcome: nonEmpty(input.outcome, "personal_agent_task_outcome_required"),
    nextAction: nonEmpty(input.nextAction, "personal_agent_task_next_action_required"),
    acceptanceCriteria: criteria,
    scope: { ...scope, permissions: [...new Set(scope.permissions.map((value) => value.trim()))] },
    dependencies,
    assignedWorker: input.assignedWorker == null ? null : nonEmpty(input.assignedWorker, "personal_agent_task_worker_invalid"),
    priority,
    budget: { maxAttempts: budget.maxAttempts, maxRuntimeMs: budget.maxRuntimeMs },
  };
}

function normalizeActor(actor) {
  object(actor, "personal_agent_task_actor_required");
  if (!actorKinds.has(actor.kind)) fail("personal_agent_task_actor_invalid");
  return {
    kind: actor.kind,
    id: actor.id == null ? null : nonEmpty(actor.id, "personal_agent_task_actor_invalid"),
    origin: nonEmpty(actor.origin, "personal_agent_task_actor_origin_required"),
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function criteriaForRow(row) {
  const stored = parseJson(row.acceptance_json, []);
  if (!Array.isArray(stored)) return [];
  return stored.map((criterion, index) => typeof criterion === "string"
    ? { id: `criterion-${index + 1}`, description: criterion }
    : criterion);
}

function taskFromRow(row) {
  if (!row) return null;
  const contract = parseJson(row.contract_json, {});
  return {
    id: row.id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key || null,
    ...contract,
    title: contract.title ?? row.title,
    outcome: contract.outcome ?? row.outcome,
    acceptanceCriteria: contract.acceptanceCriteria ?? criteriaForRow(row),
    state: row.state,
    threadId: row.thread_id || null,
    runId: row.run_id || null,
    completion: parseJson(row.completion_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireFeature(env) {
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
}

function taskRow(db, taskId) {
  return db.prepare("select * from personal_agent_tasks where id = ?").get(String(taskId || ""));
}

export async function createPersonalAgentTask(input, env = process.env) {
  requireFeature(env);
  object(input, "personal_agent_task_contract_invalid");
  const projectId = nonEmpty(input.projectId, "personal_agent_task_project_required");
  const contract = normalizeContract(input);
  const idempotencyKey = input.idempotencyKey == null ? null : nonEmpty(input.idempotencyKey, "personal_agent_task_idempotency_invalid");
  const actor = normalizeActor(input.actor ?? { kind: "owner", id: null, origin: "api" });
  const threadId = input.threadId == null ? null : nonEmpty(input.threadId, "personal_agent_task_thread_invalid");
  const db = await openAgentJobDb(env);
  return tx(db, () => {
    if (!db.prepare("select 1 from personal_agent_projects where id = ?").get(projectId)) fail("personal_agent_project_not_found", 404);
    if (idempotencyKey) {
      const existing = db.prepare("select * from personal_agent_tasks where project_id = ? and idempotency_key = ?").get(projectId, idempotencyKey);
      if (existing) {
        if (stableStringify(parseJson(existing.contract_json, {})) !== stableStringify(contract) || (existing.thread_id || null) !== threadId) {
          fail("personal_agent_task_idempotency_conflict", 409);
        }
        return { task: taskFromRow(existing), created: false };
      }
    }
    for (const dependencyId of contract.dependencies) {
      if (!db.prepare("select 1 from personal_agent_tasks where id = ? and project_id = ?").get(dependencyId, projectId)) {
        fail("personal_agent_task_dependency_not_found", 409);
      }
    }
    const id = newId("tsk");
    const now = nowIso();
    db.prepare(`insert into personal_agent_tasks
      (id, project_id, idempotency_key, title, outcome, acceptance_json, state, thread_id, contract_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(id, projectId, idempotencyKey, contract.title, contract.outcome, JSON.stringify(contract.acceptanceCriteria), threadId, JSON.stringify(contract), now, now);
    db.prepare(`insert into personal_agent_task_transitions
      (task_id, seq, from_state, to_state, actor_json, reason, evidence_json, idempotency_key, created_at)
      values (?, 1, null, 'queued', ?, 'task_created', ?, ?, ?)`)
      .run(id, JSON.stringify(actor), JSON.stringify({ contractValidated: true }), idempotencyKey ? `create:${idempotencyKey}` : null, now);
    return { task: taskFromRow(taskRow(db, id)), created: true };
  });
}

export async function getPersonalAgentTask(taskId, env = process.env) {
  requireFeature(env);
  const db = await openAgentJobDb(env);
  return taskFromRow(taskRow(db, taskId));
}

// ADR 0002: a start requires an admitted execution or explicit transition
// evidence. The controller (system) proves admission with a run or thread
// reference; the owner may instead start explicitly with a reason. Workers,
// connectors and the assistant cannot mark their own task running. Admission
// references are bound to the task and must match any already bound.
function startAdmission(row, actor, reason, evidence) {
  const raw = evidence.admission;
  const admission = raw == null ? null : object(raw, "personal_agent_task_admission_invalid");
  const runId = admission?.runId == null ? null : nonEmpty(admission.runId, "personal_agent_task_admission_invalid");
  const threadId = admission?.threadId == null ? null : nonEmpty(admission.threadId, "personal_agent_task_admission_invalid");
  const admitted = Boolean(runId || threadId);
  const explicitOwnerStart = actor.kind === "owner" && Boolean(reason) && evidence.explicit === true;
  if (!["system", "owner"].includes(actor.kind) || (!admitted && !(actor.kind === "owner" && explicitOwnerStart))) {
    fail("personal_agent_task_start_unadmitted", 403);
  }
  if ((runId && row.run_id && row.run_id !== runId) || (threadId && row.thread_id && row.thread_id !== threadId)) {
    fail("personal_agent_task_admission_conflict", 409);
  }
  return { runId: runId ?? row.run_id ?? null, threadId: threadId ?? row.thread_id ?? null };
}

export async function transitionPersonalAgentTask(input, env = process.env) {
  requireFeature(env);
  object(input, "personal_agent_task_transition_invalid");
  const taskId = nonEmpty(input.taskId, "personal_agent_task_id_required");
  const nextState = nonEmpty(input.to, "personal_agent_task_state_required");
  if (!PERSONAL_AGENT_TASK_STATES.includes(nextState)) fail("personal_agent_task_state_invalid");
  const actor = normalizeActor(input.actor);
  const reason = input.reason == null ? null : nonEmpty(input.reason, "personal_agent_task_reason_invalid");
  const evidence = object(input.evidence ?? {}, "personal_agent_task_evidence_invalid");
  const idempotencyKey = input.idempotencyKey == null ? null : nonEmpty(input.idempotencyKey, "personal_agent_task_idempotency_invalid");
  // Everything the command can change, so a reused key with different content
  // is a conflict rather than a silent replay.
  const request = { completion: input.completion ?? null, nextAction: input.nextAction ?? null };
  const db = await openAgentJobDb(env);

  return tx(db, () => {
    const row = taskRow(db, taskId);
    if (!row) fail("personal_agent_task_not_found", 404);
    if (idempotencyKey) {
      const prior = db.prepare("select to_state, actor_json, reason, evidence_json, request_json from personal_agent_task_transitions where task_id = ? and idempotency_key = ?").get(taskId, idempotencyKey);
      if (prior) {
        if (
          prior.to_state !== nextState ||
          stableStringify(parseJson(prior.actor_json, null)) !== stableStringify(actor) ||
          prior.reason !== reason ||
          stableStringify(parseJson(prior.evidence_json, {})) !== stableStringify(evidence) ||
          // A transition recorded before request_json existed cannot prove the
          // same completion/nextAction, so it only replays a bare command.
          stableStringify(parseJson(prior.request_json, { completion: null, nextAction: null })) !== stableStringify(request)
        ) {
          fail("personal_agent_task_idempotency_conflict", 409);
        }
        return { task: taskFromRow(row), replayed: true };
      }
    }
    if (terminalStates.has(row.state) || !transitions[row.state]?.has(nextState)) fail("personal_agent_task_transition_not_allowed", 409);
    if (!reason && ["blocked", "failed", "cancelled"].includes(nextState)) fail("personal_agent_task_transition_reason_required");
    const admission = nextState === "running" ? startAdmission(row, actor, reason, evidence) : null;

    let completionJson = row.completion_json;
    if (nextState === "succeeded") {
      const completion = object(input.completion, "personal_agent_task_completion_required");
      if (actor.kind !== "system" || completion.status !== "succeeded" || !nonEmpty(completion.summary, "personal_agent_task_completion_invalid")) {
        fail("personal_agent_task_completion_unverified", 403);
      }
      if (evidence.verified !== true || !nonEmpty(evidence.verifiedBy, "personal_agent_task_completion_unverified") || !Array.isArray(evidence.references) || evidence.references.length === 0) {
        fail("personal_agent_task_completion_unverified", 403);
      }
      const criteria = criteriaForRow(row);
      const results = completion.acceptanceResults;
      if (!criteria.length || !Array.isArray(results) || results.length !== criteria.length || criteria.some((criterion) => !results.some((result) => result?.criterionId === criterion.id && result?.passed === true))) {
        fail("personal_agent_task_acceptance_not_satisfied", 409);
      }
      completionJson = JSON.stringify({ ...completion, evidenceReferences: evidence.references });
    }

    let contractJson = row.contract_json;
    if (input.nextAction !== undefined) {
      const contract = parseJson(row.contract_json, {});
      contract.nextAction = nonEmpty(input.nextAction, "personal_agent_task_next_action_required");
      contractJson = JSON.stringify(contract);
    }

    const seq = Number(db.prepare("select coalesce(max(seq), 0) as seq from personal_agent_task_transitions where task_id = ?").get(taskId).seq) + 1;
    const now = nowIso();
    db.prepare("update personal_agent_tasks set state = ?, completion_json = ?, contract_json = ?, thread_id = ?, run_id = ?, updated_at = ? where id = ?")
      .run(nextState, completionJson, contractJson, admission?.threadId ?? row.thread_id, admission?.runId ?? row.run_id, now, taskId);
    db.prepare(`insert into personal_agent_task_transitions
      (task_id, seq, from_state, to_state, actor_json, reason, evidence_json, request_json, idempotency_key, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, seq, row.state, nextState, JSON.stringify(actor), reason, JSON.stringify(evidence), JSON.stringify(request), idempotencyKey, now);
    return { task: taskFromRow(taskRow(db, taskId)), replayed: false };
  });
}

export async function listPersonalAgentTaskTransitions(taskId, env = process.env) {
  requireFeature(env);
  const db = await openAgentJobDb(env);
  if (!taskRow(db, taskId)) return null;
  return db.prepare("select seq, from_state, to_state, actor_json, reason, evidence_json, created_at from personal_agent_task_transitions where task_id = ? order by seq")
    .all(String(taskId)).map((row) => ({
      seq: Number(row.seq),
      from: row.from_state,
      to: row.to_state,
      actor: parseJson(row.actor_json, null),
      reason: row.reason,
      evidence: parseJson(row.evidence_json, {}),
      createdAt: row.created_at,
    }));
}
