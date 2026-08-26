import crypto from "node:crypto";
import {
  connectorOutboxPayloadHash,
  listConnectorOutboxJobs,
} from "./connector-outbox.js";
import { listWhatsAppBindingStatuses } from "./whatsapp-account-bindings.js";
import {
  consumeApprovedPairingChallengeForAction,
  createPairingChallenge,
} from "../../core/src/security.js";
import { connectorMcpStructuredResult } from "./connectors-mcp-contract.js";
import {
  outboundMessageApprovalPreview,
  outboundMessageApprovalRequired,
  outboundMessageIntent,
} from "./outbound-message-approval.js";

function clean(value = "") {
  return String(value || "").trim();
}

function operationAction(tool = "", input = {}) {
  return `connectors_mcp:${clean(tool)}:${clean(input.service)}:${clean(input.action)}`;
}

function operationIntent(tool = "", input = {}, auth = {}) {
  const action = operationAction(tool, input);
  if (tool === "orkestr_messaging") return outboundMessageIntent(input, auth, action);
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
    resourceTarget: [clean(input.resource_type), clean(input.resource_id), clean(input.resource_action)],
    target: clean(input.target),
    alias: clean(input.alias),
    useMode: clean(input.use_mode),
    oauthAppId: clean(input.oauth_app),
    name: clean(input.name),
    participantIds: (input.participant_ids || []).map(clean).filter(Boolean),
    adminParticipantIds: (input.admin_participant_ids || []).map(clean).filter(Boolean),
    promoteParticipantsAsAdmins: input.promote_participants_as_admins === true,
    generatePicture: input.generate_picture !== false,
    setAsMain: input.set_as_main === true,
    setAsThreadDefault: input.set_as_thread_default === true,
  };
  return {
    connectorMcpAction: action,
    operationHash: crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
  };
}

async function approvalRequired(tool = "", input = {}, auth = {}, env = process.env) {
  if (tool === "orkestr_auth") return input.action !== "status";
  if (tool === "orkestr_conversation") {
    return ["create", "promote_admins", "demote_admins", "set_picture"].includes(input.action) && !auth.operator;
  }
  if (tool === "orkestr_routing") return input.action !== "status";
  if (tool === "orkestr_messaging" && input.action === "set_typing") return false;
  if (tool === "orkestr_messaging" && (typeof input.text !== "string" || !clean(input.idempotency_key))) return false;
  if (tool === "orkestr_messaging" && outboundMessageApprovalRequired(input, auth, env)) {
    const accountId = clean(auth.accountId || input.account_id || "sender");
    const tenantId = clean(auth.instanceId || auth.ownerUserId || "admin");
    const existing = (await listConnectorOutboxJobs({ connector: input.service }, env).catch(() => ({ jobs: [] }))).jobs
      .find((job) =>
        clean(job.idempotencyKey) === clean(input.idempotency_key) &&
        clean(job.accountId) === accountId &&
        clean(job.chatId) === clean(input.conversation_id) &&
        clean(job.tenantId) === tenantId
      );
    const payloadHash = connectorOutboxPayloadHash({ text: input.text, attachmentRefs: input.attachment_refs || [] });
    if (existing && existing.payloadHash === payloadHash && ["delivered", "partial_delivery"].includes(existing.state)) return false;
    return true;
  }
  if (tool !== "orkestr_messaging" || !auth.operator) return false;
  const statuses = await listWhatsAppBindingStatuses({ env }).catch(() => ({ bindings: [] }));
  return !statuses.bindings.some((binding) =>
    clean(binding.chatId).toLowerCase() === clean(input.conversation_id).toLowerCase() &&
    binding.enabled !== false &&
    binding.routeEligible !== false
  );
}

export async function requireConnectorMcpApproval(tool = "", input = {}, auth = {}, request = null, env = process.env) {
  if (!(await approvalRequired(tool, input, auth, env))) return null;
  const action = operationAction(tool, input);
  const authIntent = operationIntent(tool, input, auth);
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

export function connectorMcpChallengeResult(input = {}, challenge = null, auth = {}) {
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    status: "approval_required",
    accountId: input.account_id,
    conversationId: input.conversation_id,
    challenge,
    ...(input.action === "send_text" ? { data: { preview: outboundMessageApprovalPreview(input, auth) } } : {}),
    error: {
      code: input.action === "send_text" ? "outbound_confirmation_required" : "connector_operation_approval_required",
      requiresUserAction: true,
    },
  });
}
