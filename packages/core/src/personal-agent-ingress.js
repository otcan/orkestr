import { newId, nowIso, openAgentJobDb, sha256, tx } from "./agent-job-store.js";
import { requirePersonalAgentOwner } from "./personal-agent-capability.js";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { dispatchPersonalAgentEvents, queuePersonalAgentEvent } from "./personal-agent-events.js";

const priorities = Object.freeze({ low: 0, normal: 1, high: 2 });
const controlFlagNames = new Set(["cancel", "hold", "pause"]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function requiredText(value, code, max = 512) {
  if (typeof value !== "string") fail(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) fail(code);
  return normalized;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) fail("personal_agent_ingress_scope_invalid");
  if (scope.kind === "global" && scope.projectId == null) return { kind: "global", projectId: null };
  if (scope.kind === "project") return { kind: "project", projectId: requiredText(scope.projectId, "personal_agent_ingress_project_required") };
  fail("personal_agent_ingress_scope_invalid");
}

function normalizeControlFlags(flags = {}) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) fail("personal_agent_ingress_control_flags_invalid");
  const keys = Object.keys(flags);
  if (keys.some((key) => !controlFlagNames.has(key)) || keys.some((key) => typeof flags[key] !== "boolean")) {
    fail("personal_agent_ingress_control_flags_invalid");
  }
  return Object.fromEntries([...controlFlagNames].map((key) => [key, flags[key] === true]));
}

function conversationFor(db, scope, at) {
  const prior = scope.kind === "global"
    ? db.prepare("select * from personal_agent_conversations where scope_kind = 'global'").get()
    : db.prepare("select * from personal_agent_conversations where scope_kind = 'project' and project_id = ?").get(scope.projectId);
  if (prior) return prior;
  const id = newId("pac");
  db.prepare(`insert into personal_agent_conversations
    (id, scope_kind, project_id, next_causal_sequence, created_at, updated_at)
    values (?, ?, ?, 1, ?, ?)`)
    .run(id, scope.kind, scope.projectId, at, at);
  return db.prepare("select * from personal_agent_conversations where id = ?").get(id);
}

export async function acceptPersonalAgentMessage(request, input = {}, env = process.env) {
  requirePersonalAgentOwner(request);
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("personal_agent_ingress_invalid");
  const scope = normalizeScope(input.scope);
  const body = requiredText(input.message, "personal_agent_ingress_message_required", 32_000);
  const idempotencyKey = requiredText(input.idempotencyKey, "personal_agent_ingress_idempotency_required");
  const priorityName = input.priority ?? "normal";
  if (!Object.hasOwn(priorities, priorityName)) fail("personal_agent_ingress_priority_invalid");
  const controlFlags = normalizeControlFlags(input.controlFlags);
  const taskId = input.taskId == null ? null : requiredText(input.taskId, "personal_agent_ingress_task_invalid");
  const runId = input.runId == null ? null : requiredText(input.runId, "personal_agent_ingress_run_invalid");
  const principal = request.orkestrPrincipal;
  const actorUserId = requiredText(String(principal.userId), "personal_agent_ingress_actor_invalid");
  const payloadHash = sha256(JSON.stringify({ body, priority: priorityName, controlFlags, taskId, runId }));
  const db = await openAgentJobDb(env);
  let receipt;
  tx(db, () => {
    if (scope.kind === "project" && !db.prepare("select 1 from personal_agent_projects where id = ?").get(scope.projectId)) {
      fail("personal_agent_project_not_found", 404);
    }
    if (taskId) {
      const task = db.prepare("select project_id, run_id from personal_agent_tasks where id = ?").get(taskId);
      if (!task) fail("personal_agent_task_not_found", 404);
      if (scope.kind === "project" && task.project_id !== scope.projectId) fail("personal_agent_task_scope_mismatch", 409);
      if (runId && task.run_id !== runId) fail("personal_agent_task_run_mismatch", 409);
    }
    if (runId && !db.prepare("select 1 from runs where id = ?").get(runId)) fail("personal_agent_run_not_found", 404);
    const conversation = conversationFor(db, scope, nowIso());
    const prior = db.prepare(`select m.*, i.id as inbox_item_id from personal_agent_messages m
      join personal_agent_reasoning_inbox i on i.message_id = m.id
      where m.conversation_id = ? and m.actor_user_id = ? and m.idempotency_key = ?`)
      .get(conversation.id, actorUserId, idempotencyKey);
    if (prior) {
      if (prior.payload_hash !== payloadHash) fail("personal_agent_ingress_idempotency_conflict", 409);
      receipt = {
        accepted: true,
        replayed: true,
        conversationId: prior.conversation_id,
        messageId: prior.id,
        eventId: prior.event_id,
        cursor: prior.event_cursor,
        inboxItemId: prior.inbox_item_id,
        causalSequence: prior.causal_sequence,
        taskId: prior.task_id,
        runId: prior.run_id,
      };
      return;
    }

    const at = nowIso();
    const sequence = Number(conversation.next_causal_sequence);
    const messageId = newId("pam");
    const inboxItemId = newId("pai");
    const eventResult = queuePersonalAgentEvent(db, {
      type: "personal_agent.message.accepted",
      actor: { kind: "owner", id: actorUserId, origin: "owner_api" },
      projectId: scope.projectId,
      threadId: null,
      runId,
      causationId: null,
      idempotencyKey: `${conversation.id}:${actorUserId}:${idempotencyKey}`,
      taskId,
      data: { conversationId: conversation.id, messageId, inboxItemId, scopeKind: scope.kind, causalSequence: sequence },
    }, { source: "personal_agent_ingress", env });
    db.prepare(`insert into personal_agent_messages
      (id, conversation_id, actor_user_id, actor_origin, channel, idempotency_key, payload_hash, body, task_id, run_id, event_id, event_cursor, causal_sequence, created_at)
      values (?, ?, ?, 'owner_api', 'owner_api', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, conversation.id, actorUserId, idempotencyKey, payloadHash, body, taskId, runId, eventResult.eventId, eventResult.cursor, sequence, at);
    db.prepare(`insert into personal_agent_reasoning_inbox
      (id, conversation_id, message_id, scope_kind, scope_id, task_id, run_id, priority, causal_sequence, control_flags_json, state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(inboxItemId, conversation.id, messageId, scope.kind, scope.projectId, taskId, runId, priorities[priorityName], sequence, JSON.stringify(controlFlags), at, at);
    db.prepare("update personal_agent_conversations set next_causal_sequence = ?, updated_at = ? where id = ?")
      .run(sequence + 1, at, conversation.id);
    receipt = {
      accepted: true,
      replayed: eventResult.replayed,
      conversationId: conversation.id,
      messageId,
      eventId: eventResult.eventId,
      cursor: eventResult.cursor,
      inboxItemId,
      causalSequence: sequence,
      taskId,
      runId,
    };
  });
  void dispatchPersonalAgentEvents(env).catch(() => {});
  return receipt;
}

export async function listPersonalAgentReasoningInbox(request, { scope = null, limit = 100 } = {}, env = process.env) {
  requirePersonalAgentOwner(request);
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
  if (!scope) fail("personal_agent_ingress_scope_required");
  const db = await openAgentJobDb(env);
  const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
  const conditions = ["i.state in ('queued', 'running', 'blocked')"];
  const params = [];
  const normalized = normalizeScope(scope);
  conditions.push("i.scope_kind = ?");
  params.push(normalized.kind);
  if (normalized.kind === "project") {
    conditions.push("i.scope_id = ?");
    params.push(normalized.projectId);
  }
  return db.prepare(`select i.id as inboxItemId, i.scope_kind as scopeKind, i.scope_id as scopeId,
      i.priority, i.causal_sequence as causalSequence, i.control_flags_json as controlFlagsJson,
      i.state, i.created_at as createdAt, c.id as conversationId,
      m.id as messageId, m.body, m.task_id as taskId, m.run_id as runId,
      m.event_id as eventId, m.event_cursor as cursor,
      m.actor_user_id as actorUserId, m.channel
    from personal_agent_reasoning_inbox i
    join personal_agent_conversations c on c.id = i.conversation_id
    join personal_agent_messages m on m.id = i.message_id
    where ${conditions.join(" and ")}
    order by i.causal_sequence asc limit ?`).all(...params, pageSize).map((row) => ({
    ...row,
    controlFlags: JSON.parse(row.controlFlagsJson),
    controlFlagsJson: undefined,
  }));
}
