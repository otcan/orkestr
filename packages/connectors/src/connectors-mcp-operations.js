import crypto from "node:crypto";
import {
  applyConnectorOutboxJobAction,
  claimConnectorOutboxJob,
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
  markConnectorOutboxJob,
} from "./connector-outbox.js";
import { resolveConnectorAttachmentRefs } from "./connector-staged-attachments.js";
import {
  connectorAuthStatus,
  disconnectConnectorAuth,
  startConnectorAuth,
} from "./connector-auth.js";
import {
  listWhatsAppBindingStatuses,
  retireWhatsAppThreadBinding,
  updateWhatsAppThreadBinding,
  upsertWhatsAppBinding,
} from "./whatsapp-account-bindings.js";
import {
  whatsappWorkerAuth,
  whatsappWorkerConversation,
  whatsappWorkerConversations,
  whatsappWorkerCreateConversation,
  whatsappWorkerHealth,
  whatsappWorkerSend,
} from "./whatsapp-worker-client.js";
import {
  consumeApprovedPairingChallengeForAction,
  createPairingChallenge,
} from "../../core/src/security.js";
import {
  connectorMcpStructuredResult,
  connectorsMcpInputSchemas,
} from "./connectors-mcp-contract.js";
import { assertConnectorMcpScope } from "./connectors-mcp-auth.js";

function clean(value = "") {
  return String(value || "").trim();
}

function operationAction(tool = "", input = {}) {
  return `connectors_mcp:${clean(tool)}:${clean(input.service)}:${clean(input.action)}`;
}

function operationIntent(tool = "", input = {}) {
  const stable = {
    tool: clean(tool),
    service: clean(input.service),
    action: clean(input.action),
    accountId: clean(input.account_id),
    conversationId: clean(input.conversation_id),
    bindingId: clean(input.binding_id),
    targetThreadId: clean(input.target_thread_id),
    operationRef: clean(input.operation_ref),
    accountHint: clean(input.account_hint),
    target: clean(input.target),
  };
  return {
    connectorMcpAction: operationAction(tool, input),
    operationHash: crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
  };
}

async function challengeRequired(tool = "", input = {}, auth = {}, env = process.env) {
  if (tool === "orkestr_auth") return input.action !== "status";
  if (tool === "orkestr_conversation") return input.action === "create";
  if (tool === "orkestr_routing") return input.action !== "status";
  if (tool !== "orkestr_messaging" || !auth.operator) return false;
  const statuses = await listWhatsAppBindingStatuses({ env }).catch(() => ({ bindings: [] }));
  return !statuses.bindings.some((binding) =>
    clean(binding.chatId).toLowerCase() === clean(input.conversation_id).toLowerCase() &&
    binding.enabled !== false &&
    binding.routeEligible !== false
  );
}

async function requireAttendedApproval(tool = "", input = {}, auth = {}, request = null, env = process.env) {
  if (!(await challengeRequired(tool, input, auth, env))) return null;
  const action = operationAction(tool, input);
  const authIntent = operationIntent(tool, input);
  if (clean(input.approval)) {
    await consumeApprovedPairingChallengeForAction(input.approval, {
      env,
      action,
      authIntent,
      consumedBy: `connector-mcp:${auth.tokenId || auth.principalId || "unknown"}`,
    });
    return null;
  }
  const created = await createPairingChallenge({
    request: request || { headers: {}, socket: {} },
    env,
    userId: auth.ownerUserId || auth.principalId || "",
    role: auth.operator ? "admin" : "user",
    instanceId: auth.instanceId || clean(input.instance_id),
    requestedPath: "/connectors",
    allowedActions: [action],
    authIntent,
  });
  return {
    id: created.challengeId,
    approve_code: created.challenge?.approveCode || "",
    status: "pending",
    expires_at: created.expiresAt,
    approve_command: `orkestr security approve ${created.challenge?.approveCode || created.challengeId}`,
  };
}

function unsupported(input = {}) {
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    status: "error",
    error: { code: "connector_service_not_available", retryable: false, requiresUserAction: false },
  });
}

function challengeResult(input = {}, challenge = null) {
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    status: "approval_required",
    accountId: input.account_id,
    conversationId: input.conversation_id,
    challenge,
    error: { code: "connector_operation_approval_required", requiresUserAction: true },
  });
}

function scopedAccounts(payload = {}, auth = {}) {
  if (!auth.accountId) return payload;
  return {
    ...payload,
    accounts: (Array.isArray(payload.accounts) ? payload.accounts : []).filter((account) =>
      clean(account.accountId || account.id).toLowerCase() === auth.accountId.toLowerCase()
    ),
  };
}

function allowedConversationIds(auth = {}) {
  return new Set([
    ...(auth.allowedChatIds || []),
    ...(auth.allowedRecipients || []),
    auth.chatId,
  ].map((value) => clean(value).toLowerCase()).filter(Boolean));
}

function filterConversations(payload = {}, auth = {}) {
  if (auth.operator) return payload;
  const allowed = allowedConversationIds(auth);
  const key = Array.isArray(payload) ? null : Array.isArray(payload.chats) ? "chats" : Array.isArray(payload.conversations) ? "conversations" : null;
  if (Array.isArray(payload)) return payload.filter((item) => allowed.has(clean(item.id || item.chatId).toLowerCase()));
  if (!key) return payload;
  return { ...payload, [key]: payload[key].filter((item) => allowed.has(clean(item.id || item.chatId).toLowerCase())) };
}

async function runAuth(input, auth, env) {
  const accountId = auth.accountId || clean(input.account_id) || "sender";
  if (input.service !== "whatsapp") {
    const principal = {
      id: auth.ownerUserId || auth.principalId || "",
      userId: auth.ownerUserId || auth.principalId || "",
      ownerUserId: auth.ownerUserId || auth.principalId || "",
      instanceId: auth.instanceId || "",
      role: auth.operator ? "admin" : "user",
      source: "connector-mcp",
    };
    let payload;
    if (input.action === "status") payload = await connectorAuthStatus(input.service, env, { principal });
    else if (["connect", "reconnect"].includes(input.action)) {
      payload = await startConnectorAuth({
        provider: input.service,
        account: clean(input.account_hint),
        shop: clean(input.target),
      }, principal, env, fetch, { thread: auth.threadId ? { id: auth.threadId } : null });
    } else {
      payload = await disconnectConnectorAuth({ provider: input.service, account: clean(input.account_hint) }, principal, env);
    }
    return connectorMcpStructuredResult({ service: input.service, action: input.action, accountId: clean(input.account_hint), data: payload });
  }
  const payload = input.action === "status"
    ? scopedAccounts(await whatsappWorkerHealth(env), { ...auth, accountId })
    : await whatsappWorkerAuth(accountId, input.action, env);
  return connectorMcpStructuredResult({ service: input.service, action: input.action, accountId, data: payload });
}

async function runMessaging(input, auth, env) {
  const accountId = auth.accountId || clean(input.account_id) || "sender";
  const ensured = await ensureConnectorOutboxJob({
    connector: input.service,
    tenantId: auth.instanceId || auth.ownerUserId || "admin",
    ownerUserId: auth.ownerUserId || "admin",
    accountId,
    chatId: input.conversation_id,
    threadId: auth.threadId || clean(input.thread_id),
    sourceMessageId: input.idempotency_key,
    sourceRevision: "1",
    deliveryType: "mcp_send_text",
    idempotencyKey: input.idempotency_key,
    payload: { text: input.text, attachmentRefs: input.attachment_refs || [] },
    metadata: { source: "connector_mcp", tokenId: auth.tokenId || "" },
  }, env);
  if (ensured.job.state === "delivered") {
    return connectorMcpStructuredResult({
      service: input.service,
      action: input.action,
      status: "delivered",
      operationRef: ensured.job.id,
      accountId,
      conversationId: input.conversation_id,
      data: { duplicate: true, delivery: ensured.job.brokerAck },
    });
  }
  const claimed = await claimConnectorOutboxJob(ensured.job.id, { claimant: `connector-mcp:${process.pid}` }, env);
  if (!claimed.acquired) {
    return connectorMcpStructuredResult({
      service: input.service,
      action: input.action,
      status: claimed.terminal ? claimed.job?.state || "terminal" : "queued",
      operationRef: ensured.job.id,
      accountId,
      conversationId: input.conversation_id,
      data: { duplicate: !ensured.created, state: claimed.job?.state || ensured.job.state, reason: claimed.reason },
    });
  }
  try {
    const attachments = await resolveConnectorAttachmentRefs(input.attachment_refs || [], env);
    const delivered = await whatsappWorkerSend({
      accountId,
      conversationId: input.conversation_id,
      text: input.text,
      attachmentPaths: attachments.map((item) => item.path),
    }, env);
    const job = await markConnectorOutboxJob(ensured.job.id, {
      state: "delivered",
      deliveredAt: new Date().toISOString(),
      brokerAck: delivered,
    }, env);
    return connectorMcpStructuredResult({
      service: input.service,
      action: input.action,
      status: "delivered",
      operationRef: job.id,
      accountId,
      conversationId: input.conversation_id,
      data: delivered,
    });
  } catch (error) {
    const uncertain = /not_confirmed|timeout/i.test(clean(error?.message));
    const state = uncertain ? "delivery_uncertain" : "failed_retryable";
    await markConnectorOutboxJob(ensured.job.id, { state, failedAt: new Date().toISOString(), error: clean(error?.message) }, env);
    throw Object.assign(error, { operationRef: ensured.job.id, deliveryState: state });
  }
}

async function runConversation(input, auth, env) {
  const accountId = auth.accountId || clean(input.account_id) || "sender";
  let payload;
  if (input.action === "list") payload = filterConversations(await whatsappWorkerConversations(accountId, env), auth);
  else if (input.action === "create") {
    payload = await whatsappWorkerCreateConversation({ accountId, name: input.name, participantIds: input.participant_ids || [] }, env);
  } else {
    if (!clean(input.conversation_id)) throw Object.assign(new Error("connector_conversation_id_required"), { statusCode: 400 });
    payload = await whatsappWorkerConversation(accountId, input.conversation_id, input.action, {
      limit: input.limit,
      unreadOnly: input.unread_only,
      markSeen: input.mark_seen,
    }, env);
  }
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    accountId,
    conversationId: input.conversation_id,
    data: payload,
  });
}

function scopedBindings(bindings = [], auth = {}) {
  if (auth.operator) return bindings;
  const allowed = allowedConversationIds(auth);
  return bindings.filter((binding) =>
    (!auth.instanceId || clean(binding.instanceId) === auth.instanceId) &&
    (!auth.ownerUserId || clean(binding.ownerUserId || binding.userId) === auth.ownerUserId) &&
    (!allowed.size || allowed.has(clean(binding.chatId).toLowerCase()))
  );
}

async function runRouting(input, auth, env) {
  if (input.action === "status") {
    const [routing, operations] = await Promise.all([
      listWhatsAppBindingStatuses({ env }),
      listConnectorOutboxJobs({ connector: input.service, ownerUserId: auth.operator ? "" : auth.ownerUserId }, env),
    ]);
    return connectorMcpStructuredResult({
      service: input.service,
      action: input.action,
      accountId: auth.accountId || clean(input.account_id),
      conversationId: input.conversation_id,
      data: { ...routing, bindings: scopedBindings(routing.bindings, auth), operations },
    });
  }
  let payload;
  if (input.action === "bind") {
    if (!clean(input.conversation_id) || !clean(input.target_thread_id)) throw Object.assign(new Error("connector_routing_target_required"), { statusCode: 400 });
    payload = await upsertWhatsAppBinding({
      level: "thread",
      threadId: input.target_thread_id,
      chatId: input.conversation_id,
      accountId: auth.accountId || clean(input.account_id) || "sender",
      responderAccountId: auth.accountId || clean(input.account_id) || "sender",
      ownerUserId: auth.ownerUserId || clean(input.user_id),
      instanceId: auth.instanceId || clean(input.instance_id),
      enabled: true,
      routeEligible: true,
    }, env);
  } else if (input.action === "unbind") {
    if (!clean(input.binding_id)) throw Object.assign(new Error("connector_binding_id_required"), { statusCode: 400 });
    payload = await retireWhatsAppThreadBinding(input.binding_id, env);
  } else if (["pause", "resume"].includes(input.action)) {
    if (!clean(input.binding_id)) throw Object.assign(new Error("connector_binding_id_required"), { statusCode: 400 });
    const enabled = input.action === "resume";
    payload = await updateWhatsAppThreadBinding(input.binding_id, { enabled, routeEligible: enabled }, env);
  } else if (input.action === "retry") {
    if (!clean(input.operation_ref)) throw Object.assign(new Error("connector_operation_ref_required"), { statusCode: 400 });
    payload = await applyConnectorOutboxJobAction(input.operation_ref, "retry", {}, env);
  }
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    operationRef: input.operation_ref,
    accountId: auth.accountId || clean(input.account_id),
    conversationId: input.conversation_id,
    data: payload,
  });
}

export async function runConnectorMcpTool(tool = "", rawInput = {}, { auth = {}, request = null, env = process.env } = {}) {
  const schema = connectorsMcpInputSchemas[tool];
  if (!schema) throw Object.assign(new Error("connector_mcp_tool_not_found"), { statusCode: 404 });
  const input = schema.parse(rawInput);
  const scoped = assertConnectorMcpScope(auth, tool, input);
  if (input.service !== "whatsapp" && tool !== "orkestr_auth") return unsupported(input);
  if (["webui", "codex"].includes(input.service)) return unsupported(input);
  const challenge = await requireAttendedApproval(tool, input, scoped, request, env);
  if (challenge) return challengeResult(input, challenge);
  try {
    if (tool === "orkestr_auth") return await runAuth(input, scoped, env);
    if (tool === "orkestr_messaging") return await runMessaging(input, scoped, env);
    if (tool === "orkestr_conversation") return await runConversation(input, scoped, env);
    if (tool === "orkestr_routing") return await runRouting(input, scoped, env);
  } catch (error) {
    return connectorMcpStructuredResult({
      service: input.service,
      action: input.action,
      status: error?.deliveryState || "error",
      operationRef: error?.operationRef || input.operation_ref,
      accountId: scoped.accountId,
      conversationId: scoped.conversationId,
      error: {
        code: clean(error?.message) || "connector_operation_failed",
        retryable: Number(error?.statusCode || 500) >= 500 && error?.deliveryState !== "delivery_uncertain",
        requiresUserAction: Number(error?.statusCode || 0) === 401 || Number(error?.statusCode || 0) === 403,
      },
    });
  }
  throw Object.assign(new Error("connector_mcp_tool_not_found"), { statusCode: 404 });
}
