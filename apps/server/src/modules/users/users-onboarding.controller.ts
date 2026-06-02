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

function offboardingInput(body: Record<string, unknown> = {}, request: any) {
  const principal = requestPrincipal(request);
  return {
    action: String(body.action || "pause").trim(),
    revokeConnectors: body.revokeConnectors,
    stopTimers: body.stopTimers,
    actorUserId: principal?.userId || "admin",
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
