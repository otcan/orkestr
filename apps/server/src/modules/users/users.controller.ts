import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { startGmailOAuth as beginGmailOAuth } from "../../../../../packages/connectors/src/gmail.js";
import { startOutlookDeviceOAuth } from "../../../../../packages/connectors/src/outlook.js";
import { isAdminPrincipal, resourceOwnerUserId } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { creditUsageSummary, listCreditUsageRecords, summarizeCreditUsage } from "../../../../../packages/core/src/credit-usage.js";
import { listThreads } from "../../../../../packages/core/src/threads.js";
import { listTimers } from "../../../../../packages/core/src/timers.js";
import {
  createUser,
  disableUser,
  enableUser,
  getUser,
  linkUserPrivateIdentity,
  listUsers,
  publicUser,
  readUserPrivateIdentities,
  unlinkUserPrivateIdentity,
  updateUser,
  updateUserLimits,
} from "../../../../../packages/core/src/users.js";
import {
  createUserSkillForPrincipal,
  deleteUserSkillForPrincipal,
  getUserSkillForPrincipal,
  listUserSkillsForPrincipal,
  searchUserSkillsForPrincipal,
  setUserSkillForPrincipal,
} from "../../../../../packages/core/src/user-skills.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

function assertSelfOrAdmin(request: any, userId: string): void {
  const principal = requestPrincipal(request);
  if (isAdminPrincipal(principal)) return;
  if (String(principal?.userId || "").trim().toLowerCase() === String(userId || "").trim().toLowerCase()) return;
  throw httpError("user_usage_forbidden", 403);
}

function userBody(body: Record<string, unknown> = {}) {
  const limits = body.limits && typeof body.limits === "object" && !Array.isArray(body.limits)
    ? body.limits as Record<string, unknown>
    : {};
  if (Object.prototype.hasOwnProperty.call(body, "maxThreads")) {
    limits.maxThreads = body.maxThreads;
  }
  return {
    id: String(body.id || body.userId || "").trim(),
    displayName: String(body.displayName || body.name || "").trim(),
    email: String(body.email || "").trim(),
    phoneNumber: String(body.phoneNumber || body.phone || "").trim(),
    authProvider: String(body.authProvider || "").trim(),
    role: String(body.role || "").trim(),
    status: String(body.status || "").trim(),
    limits,
  };
}

function userSummary(user: any, threads: any[], timers: any[]) {
  const ownedThreads = threads.filter((thread) => resourceOwnerUserId(thread) === user.id && !thread.deletedAt);
  const ownedTimers = timers.filter((timer) => resourceOwnerUserId(timer) === user.id && !timer.deletedAt);
  const lastActivity = ownedThreads
    .map((thread) => String(thread.lastActivityAt || thread.lastMessageAt || thread.updatedAt || thread.createdAt || ""))
    .filter(Boolean)
    .sort()
    .at(-1) || user.updatedAt || user.createdAt || "";
  return {
    ...publicUser(user),
    resourceSummary: {
      threadCount: ownedThreads.length,
      timerCount: ownedTimers.length,
      lastActivityAt: lastActivity,
    },
  };
}

function skillBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  if (body.id !== undefined) output.id = body.id;
  if (body.skillId !== undefined) output.skillId = body.skillId;
  if (body.name !== undefined) output.name = body.name;
  if (body.label !== undefined) output.label = body.label;
  if (body.description !== undefined) output.description = body.description;
  if (body.summary !== undefined) output.summary = body.summary;
  if (body.instructions !== undefined) output.instructions = body.instructions;
  if (body.enabled !== undefined) output.enabled = body.enabled;
  if (body.metadata !== undefined) output.metadata = body.metadata;
  return output;
}

function whatsappIdentityBody(body: Record<string, unknown> = {}) {
  return {
    provider: "whatsapp",
    accountId: String(body.accountId || body.whatsappAccountId || "").trim(),
    externalId: String(body.externalId || body.senderId || body.participantId || "").trim(),
    chatId: String(body.chatId || body.waChatId || body.whatsappChatId || "").trim(),
    displayName: String(body.displayName || body.name || "").trim(),
    source: "manual",
  };
}

function mailIdentityBody(provider: "gmail" | "outlook", body: Record<string, unknown> = {}) {
  const account = String(body.account || body.email || body.externalId || body.accountId || "").trim().toLowerCase();
  return {
    provider,
    accountId: account,
    externalId: account,
    displayName: String(body.displayName || body.name || account).trim(),
    source: "manual",
  };
}

function identityProvider(provider: string): "gmail" | "outlook" {
  const normalized = String(provider || "").trim().toLowerCase();
  if (normalized === "gmail" || normalized === "outlook") return normalized;
  throw httpError("unsupported_mail_identity_provider", 400);
}

function requestedUserId(value: string, request: any) {
  if (String(value || "").trim().toLowerCase() === "me") {
    const principal = requestPrincipal(request);
    if (!principal?.userId) throw httpError("user_required", 403);
    return principal.userId;
  }
  return String(value || "").trim();
}

function brokerProxyUserOverride(request: any, principal: any, user: any, fallback: any) {
  const context = request?.orkestrMachineAuthContext || {};
  if (request?.orkestrMachineAuth !== "broker_proxy") return user || fallback;
  if (String(context.role || principal?.role || "").trim().toLowerCase() !== "user") return user || fallback;
  return {
    ...(user && user.role !== "admin" ? user : fallback),
    id: principal.userId,
    role: "user",
    displayName: String(principal.displayName || context.displayName || (user?.role !== "admin" ? user?.displayName : "") || principal.userId).trim(),
    limits: user && user.role !== "admin" ? user.limits : fallback.limits,
  };
}

@Controller("api/users")
export class UsersController {
  @Get()
  async list(@Req() request: any) {
    assertAdminRequest(request);
    const [users, threads, timers] = await Promise.all([listUsers(), listThreads(), listTimers()]);
    return {
      users: users.map((user) => userSummary(user, threads, timers)),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post()
  @HttpCode(200)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const user = await createUser(userBody(body));
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { ok: true, user: userSummary(user, threads, timers) };
  }

  @Get("me/credit-usage")
  async myCreditUsage(@Req() request: any) {
    const principal = requestPrincipal(request);
    const userId = String(principal?.userId || "").trim();
    if (!userId) throw httpError("user_required", 403);
    return { usage: await creditUsageSummary({ tenantId: userId }) };
  }

  @Get("me")
  async me(@Req() request: any) {
    const principal = requestPrincipal(request);
    if (!principal?.userId) throw httpError("user_required", 403);
    const [user, threads, timers] = await Promise.all([
      getUser(principal.userId),
      listThreads(),
      listTimers(),
    ]);
    const fallback = {
      id: principal.userId,
      role: principal.role || "user",
      displayName: principal.displayName || principal.userId,
      email: "",
      phoneNumber: "",
      authProvider: principal.source || "browser_pairing",
      status: "active",
      limits: { maxThreads: principal.role === "admin" ? null : 1 },
    };
    return { ok: true, user: userSummary(brokerProxyUserOverride(request, principal, user, fallback), threads, timers) };
  }

  @Get("me/skills")
  async mySkills(@Req() request: any) {
    const principal = requestPrincipal(request);
    return listUserSkillsForPrincipal(principal.userId, principal);
  }

  @Get("me/skills/search")
  async searchMySkills(@Req() request: any, @Query("q") query = "") {
    const principal = requestPrincipal(request);
    return searchUserSkillsForPrincipal(principal.userId, query, principal);
  }

  @Post("me/skills")
  @HttpCode(200)
  async createMySkill(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return createUserSkillForPrincipal(principal.userId, skillBody(body), principal);
  }

  @Get("me/skills/:skillId")
  async mySkill(@Req() request: any, @Param("skillId") skillId: string) {
    const principal = requestPrincipal(request);
    return getUserSkillForPrincipal(principal.userId, skillId, principal);
  }

  @Patch("me/skills/:skillId")
  async updateMySkill(@Req() request: any, @Param("skillId") skillId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return setUserSkillForPrincipal(principal.userId, skillId, skillBody(body), principal);
  }

  @Delete("me/skills/:skillId")
  async deleteMySkill(@Req() request: any, @Param("skillId") skillId: string) {
    const principal = requestPrincipal(request);
    return deleteUserSkillForPrincipal(principal.userId, skillId, principal);
  }

  @Get(":userId/skills")
  async skills(@Req() request: any, @Param("userId") userId: string) {
    const principal = requestPrincipal(request);
    return listUserSkillsForPrincipal(requestedUserId(userId, request), principal);
  }

  @Get(":userId/skills/search")
  async searchSkills(@Req() request: any, @Param("userId") userId: string, @Query("q") query = "") {
    const principal = requestPrincipal(request);
    return searchUserSkillsForPrincipal(requestedUserId(userId, request), query, principal);
  }

  @Post(":userId/skills")
  @HttpCode(200)
  async createSkill(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return createUserSkillForPrincipal(requestedUserId(userId, request), skillBody(body), principal);
  }

  @Get(":userId/skills/:skillId")
  async skill(@Req() request: any, @Param("userId") userId: string, @Param("skillId") skillId: string) {
    const principal = requestPrincipal(request);
    return getUserSkillForPrincipal(requestedUserId(userId, request), skillId, principal);
  }

  @Get(":userId/identities")
  async identities(@Req() request: any, @Param("userId") userId: string) {
    assertAdminRequest(request);
    const requested = requestedUserId(userId, request);
    const user = await getUser(requested);
    if (!user) throw httpError("user_not_found", 404);
    return {
      ok: true,
      userId: user.id,
      identities: await readUserPrivateIdentities(user.id),
    };
  }

  @Post(":userId/identities/whatsapp")
  @HttpCode(200)
  async linkWhatsAppIdentity(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const identities = await linkUserPrivateIdentity(requested, whatsappIdentityBody(body), {
      actorUserId: principal.userId || "admin",
      migrate: body.migrate === true,
    });
    return { ok: true, userId: requested, identities };
  }

  @Post(":userId/identities/whatsapp/unlink")
  @HttpCode(200)
  async unlinkWhatsAppIdentity(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const identities = await unlinkUserPrivateIdentity(requested, whatsappIdentityBody(body), {
      actorUserId: principal.userId || "admin",
    });
    return { ok: true, userId: requested, identities };
  }

  @Post(":userId/identities/:provider")
  @HttpCode(200)
  async linkMailIdentity(@Req() request: any, @Param("userId") userId: string, @Param("provider") provider: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const normalizedProvider = identityProvider(provider);
    const identities = await linkUserPrivateIdentity(requested, mailIdentityBody(normalizedProvider, body), {
      actorUserId: principal.userId || "admin",
      migrate: body.migrate === true,
    });
    return { ok: true, userId: requested, identities };
  }

  @Post(":userId/identities/:provider/unlink")
  @HttpCode(200)
  async unlinkMailIdentity(@Req() request: any, @Param("userId") userId: string, @Param("provider") provider: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const normalizedProvider = identityProvider(provider);
    const identities = await unlinkUserPrivateIdentity(requested, mailIdentityBody(normalizedProvider, body), {
      actorUserId: principal.userId || "admin",
    });
    return { ok: true, userId: requested, identities };
  }

  @Post(":userId/connectors/gmail/oauth/start")
  @HttpCode(200)
  async startUserGmailOAuth(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const account = String(body.account || body.email || "").trim().toLowerCase();
    let identities = await readUserPrivateIdentities(requested);
    if (account) {
      identities = await linkUserPrivateIdentity(requested, mailIdentityBody("gmail", { ...body, account }), {
        actorUserId: principal.userId || "admin",
        migrate: body.migrate === true,
      });
    }
    const oauth = await beginGmailOAuth(process.env, { userId: requested, account });
    return { ok: true, userId: requested, identities, ...oauth };
  }

  @Post(":userId/connectors/outlook/oauth/start")
  @HttpCode(200)
  async startUserOutlookOAuth(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    const account = String(body.account || body.email || "").trim().toLowerCase();
    let identities = await readUserPrivateIdentities(requested);
    if (account) {
      identities = await linkUserPrivateIdentity(requested, mailIdentityBody("outlook", { ...body, account }), {
        actorUserId: principal.userId || "admin",
        migrate: body.migrate === true,
      });
    }
    const oauth = await startOutlookDeviceOAuth(process.env, { userId: requested, account });
    return { ...oauth, ok: oauth.ok !== false, userId: requested, identities };
  }

  @Patch(":userId/skills/:skillId")
  async updateSkill(@Req() request: any, @Param("userId") userId: string, @Param("skillId") skillId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return setUserSkillForPrincipal(requestedUserId(userId, request), skillId, skillBody(body), principal);
  }

  @Delete(":userId/skills/:skillId")
  async deleteSkill(@Req() request: any, @Param("userId") userId: string, @Param("skillId") skillId: string) {
    const principal = requestPrincipal(request);
    return deleteUserSkillForPrincipal(requestedUserId(userId, request), skillId, principal);
  }

  @Get("credit-usage")
  async creditUsage(@Req() request: any) {
    assertAdminRequest(request);
    const records = await listCreditUsageRecords();
    const tenantIds = [...new Set(records.map((record: any) => String(record.tenantId || "").trim()).filter(Boolean))].sort();
    return {
      generatedAt: new Date().toISOString(),
      tenants: tenantIds.map((tenantId) => summarizeCreditUsage(records, { tenantId })),
      total: summarizeCreditUsage(records),
    };
  }

  @Get(":userId/credit-usage")
  async userCreditUsage(@Req() request: any, @Param("userId") userId: string) {
    assertSelfOrAdmin(request, userId);
    return { usage: await creditUsageSummary({ tenantId: userId }) };
  }

  @Get(":userId")
  async get(@Req() request: any, @Param("userId") userId: string) {
    const principal = requestPrincipal(request);
    const requested = requestedUserId(userId, request);
    if (!isAdminPrincipal(principal) && requested !== principal.userId) assertAdminRequest(request);
    const user = await getUser(requested);
    if (!user) throw httpError("user_not_found", 404);
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { user: userSummary(user, threads, timers) };
  }

  @Patch(":userId")
  async update(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const user = await updateUser(userId, userBody(body));
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { ok: true, user: userSummary(user, threads, timers) };
  }

  @Post(":userId/disable")
  @HttpCode(200)
  async disable(@Req() request: any, @Param("userId") userId: string) {
    assertAdminRequest(request);
    const user = await disableUser(userId);
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { ok: true, user: userSummary(user, threads, timers) };
  }

  @Post(":userId/enable")
  @HttpCode(200)
  async enable(@Req() request: any, @Param("userId") userId: string) {
    assertAdminRequest(request);
    const user = await enableUser(userId);
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { ok: true, user: userSummary(user, threads, timers) };
  }

  @Post(":userId/limits")
  @HttpCode(200)
  async limits(@Req() request: any, @Param("userId") userId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const user = await updateUserLimits(userId, body.limits && typeof body.limits === "object" ? body.limits as Record<string, unknown> : body);
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { ok: true, user: userSummary(user, threads, timers) };
  }
}
