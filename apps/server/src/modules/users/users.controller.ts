import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
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
  listUsers,
  publicUser,
  updateUser,
  updateUserLimits,
} from "../../../../../packages/core/src/users.js";
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

  @Get(":userId")
  async get(@Req() request: any, @Param("userId") userId: string) {
    assertAdminRequest(request);
    const user = await getUser(userId);
    if (!user) throw httpError("user_not_found", 404);
    const [threads, timers] = await Promise.all([listThreads(), listTimers()]);
    return { user: userSummary(user, threads, timers) };
  }

  @Get(":userId/credit-usage")
  async userCreditUsage(@Req() request: any, @Param("userId") userId: string) {
    assertSelfOrAdmin(request, userId);
    return { usage: await creditUsageSummary({ tenantId: userId }) };
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
