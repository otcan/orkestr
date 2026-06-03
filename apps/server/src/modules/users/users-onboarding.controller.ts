import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import {
  buildExternalUserInviteTemplate,
  buildProvisioningChecklist,
  offboardUser,
  readUserOnboardingState,
  recordUserSupportRequest,
  resumeOnboardedUser,
  setUserOnboardingState,
} from "../../../../../packages/core/src/user-onboarding.js";
import {
  approveWaitlistEntry,
  listWaitlistEntries,
  updateWaitlistEntry,
} from "../../../../../packages/core/src/user-waitlist.js";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import { createAndBindWhatsAppThreadGroup } from "../../../../../packages/connectors/src/whatsapp-thread-groups.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

function assertSelfOrAdmin(request: any, userId: string): void {
  const principal = requestPrincipal(request);
  if (isAdminPrincipal(principal)) return;
  if (String(principal?.userId || "").trim().toLowerCase() === String(userId || "").trim().toLowerCase()) return;
  throw httpError("user_onboarding_forbidden", 403);
}

function requestedUserId(value: string, request: any) {
  if (String(value || "").trim().toLowerCase() === "me") {
    const principal = requestPrincipal(request);
    if (!principal?.userId) throw httpError("user_required", 403);
    return principal.userId;
  }
  return String(value || "").trim();
}

function inviteInput(query: Record<string, unknown> = {}) {
  return {
    channel: String(query.channel || "whatsapp").trim(),
    name: String(query.name || query.displayName || "").trim(),
    inviter: String(query.inviter || "").trim(),
    consentPhrase: String(query.consentPhrase || "").trim(),
  };
}

function checklistInput(query: Record<string, unknown> = {}) {
  return {
    userId: String(query.userId || query.id || "").trim(),
    displayName: String(query.displayName || query.name || "").trim(),
    email: String(query.email || "").trim(),
    phoneNumber: String(query.phoneNumber || query.phone || "").trim(),
    connectionName: String(query.connectionName || query.chatName || "").trim(),
    consented: query.consented,
  };
}

function supportInput(body: Record<string, unknown> = {}) {
  return {
    type: String(body.type || body.kind || "help").trim(),
    message: String(body.message || body.text || "").trim(),
  };
}

function onboardingPatch(body: Record<string, unknown> = {}) {
  return {
    state: String(body.state || "").trim(),
    invite: body.invite === undefined ? undefined : body.invite,
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function offboardingInput(body: Record<string, unknown> = {}, request: any) {
  const principal = requestPrincipal(request);
  return {
    action: String(body.action || "pause").trim(),
    revokeConnectors: body.revokeConnectors,
    stopTimers: body.stopTimers,
    actorUserId: principal?.userId || "admin",
  };
}

function waitlistStatusPatch(body: Record<string, unknown> = {}, request: any) {
  const principal = requestPrincipal(request);
  return {
    status: String(body.status || "").trim(),
    adminNote: String(body.adminNote || body.note || "").trim(),
    reviewedBy: principal?.userId || "admin",
  };
}

function waitlistApprovalInput(body: Record<string, unknown> = {}, request: any) {
  const principal = requestPrincipal(request);
  return {
    userId: String(body.userId || "").trim(),
    connectionName: String(body.connectionName || body.chatName || "").trim(),
    threadId: String(body.threadId || "").trim(),
    chatId: String(body.chatId || body.whatsappChatId || "").trim(),
    whatsappAccountId: String(body.whatsappAccountId || body.accountId || "").trim(),
    senderAccountId: String(body.senderAccountId || "").trim(),
    responderAccountId: String(body.responderAccountId || "").trim(),
    outboundAccountId: String(body.outboundAccountId || "").trim(),
    adminNote: String(body.adminNote || body.note || "").trim(),
    actorUserId: principal?.userId || "admin",
    createWhatsAppGroup: optionalBoolean(body.createWhatsAppGroup),
    sendFirstPrompt: optionalBoolean(body.sendFirstPrompt),
    requireWhatsAppGroup: optionalBoolean(body.requireWhatsAppGroup),
    requireFirstPrompt: optionalBoolean(body.requireFirstPrompt),
  };
}

@Controller("api/users")
export class UsersOnboardingController {
  @Get("onboarding/invite-template")
  async inviteTemplate(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return buildExternalUserInviteTemplate(inviteInput(query));
  }

  @Get("onboarding/provisioning-checklist")
  async provisioningChecklist(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return buildProvisioningChecklist(checklistInput(query));
  }

  @Get("onboarding/waitlist")
  async waitlist(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return listWaitlistEntries({
      status: String(query.status || "").trim(),
      limit: Number(query.limit || 100),
    });
  }

  @Patch("onboarding/waitlist/:entryId")
  async updateWaitlist(@Req() request: any, @Param("entryId") entryId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return updateWaitlistEntry(entryId, waitlistStatusPatch(body, request));
  }

  @Post("onboarding/waitlist/:entryId/approve")
  @HttpCode(200)
  async approveWaitlist(@Req() request: any, @Param("entryId") entryId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return approveWaitlistEntry(entryId, waitlistApprovalInput(body, request), process.env, {
      createWhatsAppThreadGroup: createAndBindWhatsAppThreadGroup,
      deliverWhatsAppReplies,
    });
  }

  @Get(":userId/onboarding")
  async onboarding(@Req() request: any, @Param("userId") userId: string) {
    const requested = requestedUserId(userId, request);
    assertSelfOrAdmin(request, requested);
    return { ok: true, onboarding: await readUserOnboardingState(requested) };
  }

  @Patch(":userId/onboarding")
  async updateOnboarding(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return setUserOnboardingState(requestedUserId(userId, request), onboardingPatch(body));
  }

  @Post("me/support")
  @HttpCode(200)
  async mySupport(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    if (!principal?.userId) throw httpError("user_required", 403);
    return recordUserSupportRequest(principal.userId, supportInput(body));
  }

  @Post(":userId/offboard")
  @HttpCode(200)
  async offboard(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return offboardUser(requestedUserId(userId, request), offboardingInput(body, request));
  }

  @Post(":userId/resume")
  @HttpCode(200)
  async resume(@Req() request: any, @Param("userId") userId: string) {
    assertAdminRequest(request);
    return resumeOnboardedUser(requestedUserId(userId, request));
  }
}
