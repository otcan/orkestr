import { Body, Controller, Param, Put, Req } from "@nestjs/common";
import { getThread } from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { defaultWhatsAppReplyPrefix } from "../../../../../packages/core/src/whatsapp-defaults.js";
import { threadBindingUpdateSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import {
  ThreadActionSanitizerService,
  ThreadBindingService,
} from "./thread-application.services.js";
import {
  hasOwn,
  optionalBodyBoolean,
  optionalBodyString,
  optionalBodyStringArray,
  optionalBodyStringMap,
} from "./thread-route-helpers.js";

function adminUserIdFromEnv(): string {
  return String(process.env.ORKESTR_ADMIN_USER_ID || "admin").trim().toLowerCase() || "admin";
}

function restrictedApprovalPolicy(thread: any): string {
  const requested = String(thread?.codexApprovalPolicy || thread?.executor?.metadata?.codexApprovalPolicy || "on-request").trim() || "on-request";
  return requested === "never" ? "on-request" : requested;
}

function threadSecurityProfile(thread: any): string {
  return String(thread?.securityProfile || thread?.executor?.metadata?.securityProfile || "").trim();
}

function restrictedSecurityProfile(thread: any): string {
  const requested = threadSecurityProfile(thread);
  if (["demo-isolated", "quarantined-demo", "external-user", "private-user", "generated-whatsapp"].includes(requested.toLowerCase())) return requested;
  return "generated-whatsapp";
}

function generatedWhatsAppBindingCodexPatch(thread: any, binding: Record<string, unknown>): Record<string, unknown> {
  if (binding.generated !== true) return {};
  const ownerUserId = String(thread?.ownerUserId || thread?.userId || "").trim().toLowerCase();
  if (!ownerUserId || ownerUserId === adminUserIdFromEnv()) return {};
  const securityProfile = restrictedSecurityProfile(thread);
  const codexApprovalPolicy = restrictedApprovalPolicy(thread);
  return {
    securityProfile,
    codexSandbox: "workspace-write",
    codexApprovalPolicy,
    executor: {
      ...(thread.executor || {}),
      metadata: {
        ...(thread.executor?.metadata || {}),
        securityProfile,
        codexSandbox: "workspace-write",
        codexApprovalPolicy,
      },
    },
  };
}

@Controller("api/threads")
export class ThreadBindingController {
  constructor(
    private readonly threadActionSanitizer: ThreadActionSanitizerService,
    private readonly threadBindingService: ThreadBindingService,
  ) {}

  @Put(":threadId/binding")
  async binding(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadBindingUpdateSchema, { params: { threadId }, body });
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.threadActionSanitizer.assertAllowed("thread.binding.update", requestPrincipal(request), thread, body);
    const current = thread.binding || {};
    const displayName = optionalBodyString(body, "displayName", current.displayName || thread.name || thread.id) || thread.name || thread.id;
    const additionalParticipantsEnabled = optionalBodyBoolean(body, "additionalParticipantsEnabled", current.additionalParticipantsEnabled === true);
    const additionalParticipantIds = additionalParticipantsEnabled
      ? optionalBodyStringArray(body, "additionalParticipantIds", current.additionalParticipantIds || [])
      : [];
    const rawAdditionalParticipantLabels = optionalBodyStringMap(body, "additionalParticipantLabels", current.additionalParticipantLabels || {});
    const additionalParticipantLabels = Object.fromEntries(
      additionalParticipantIds
        .map((id) => [id, rawAdditionalParticipantLabels[id]] as const)
        .filter((entry) => entry[1]),
    );
    const remoteBackend = optionalBodyString(body, "remoteBackend", current.remoteBackend || current.remoteRuntimeBackend || "") || null;
    const remoteThreadIdValue = optionalBodyString(body, "remoteThreadId", current.remoteThreadId || current.remoteRuntimeThreadId || "") || null;
    const hasRemoteRuntimeBinding =
      Boolean(remoteBackend || remoteThreadIdValue || current.remoteBackend || current.remoteThreadId || current.remoteRuntimeBackend || current.remoteRuntimeThreadId) ||
      hasOwn(body, "remoteRuntimeEnabled") ||
      hasOwn(body, "remoteMirrorEnabled");
    const binding = {
      ...current,
      connector: optionalBodyString(body, "connector", current.connector || "whatsapp") || "whatsapp",
      chatId: optionalBodyString(body, "chatId", current.chatId || ""),
      displayName,
      enabled: optionalBodyBoolean(body, "enabled", current.enabled !== false),
      allowOtherPeople: optionalBodyBoolean(body, "allowOtherPeople", current.allowOtherPeople !== false),
      additionalParticipantsEnabled,
      additionalParticipantIds,
      additionalParticipantLabels,
      mirrorToWhatsApp: optionalBodyBoolean(body, "mirrorToWhatsApp", current.mirrorToWhatsApp !== false),
      replyPrefix: optionalBodyString(body, "replyPrefix", current.replyPrefix || defaultWhatsAppReplyPrefix()) || defaultWhatsAppReplyPrefix(),
      senderAccountId: optionalBodyString(body, "senderAccountId", current.senderAccountId || "") || null,
      responderAccountId: optionalBodyString(body, "responderAccountId", current.responderAccountId || current.outboundAccountId || "") || null,
      senderContactId: optionalBodyString(body, "senderContactId", current.senderContactId || "") || null,
      responderContactId: optionalBodyString(body, "responderContactId", current.responderContactId || "") || null,
      generated: optionalBodyBoolean(body, "generated", current.generated === true),
      outboundAccountId: optionalBodyString(body, "outboundAccountId", current.outboundAccountId || "") || null,
      ownerAuthorTags: optionalBodyStringArray(body, "ownerAuthorTags", current.ownerAuthorTags || []),
      trustedOverrideAuthorTags: optionalBodyStringArray(body, "trustedOverrideAuthorTags", current.trustedOverrideAuthorTags || []),
      ...(hasRemoteRuntimeBinding ? {
        remoteBackend,
        remoteThreadId: remoteThreadIdValue,
        remoteRuntimeEnabled: optionalBodyBoolean(body, "remoteRuntimeEnabled", current.remoteRuntimeEnabled !== false),
        remoteMirrorEnabled: optionalBodyBoolean(body, "remoteMirrorEnabled", current.remoteMirrorEnabled !== false),
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    const updated = await this.threadBindingService.updateWhatsAppBinding(
      thread,
      binding,
      generatedWhatsAppBindingCodexPatch(thread, binding),
    );
    return { ok: true, thread: updated, binding };
  }
}
