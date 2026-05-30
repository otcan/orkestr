import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { isAdminPrincipal, resourceOwnerUserId } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
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
import {
  listUserSkillsForPrincipal,
  setUserSkillForPrincipal,
} from "../../../../../packages/core/src/user-skills.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
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
  if (body.enabled !== undefined) output.enabled = body.enabled;
  return output;
}

function requestedUserId(value: string, request: any) {
  if (String(value || "").trim().toLowerCase() === "me") {
    const principal = requestPrincipal(request);
    if (!principal?.userId) throw httpError("user_required", 403);
    return principal.userId;
  }
  return String(value || "").trim();
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
    return { ok: true, user: userSummary(user || fallback, threads, timers) };
  }

  @Get("me/skills")
  async mySkills(@Req() request: any) {
    const principal = requestPrincipal(request);
    return listUserSkillsForPrincipal(principal.userId, principal);
  }

  @Patch("me/skills/:skillId")
  async updateMySkill(@Req() request: any, @Param("skillId") skillId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return setUserSkillForPrincipal(principal.userId, skillId, skillBody(body), principal);
  }

  @Get(":userId/skills")
  async skills(@Req() request: any, @Param("userId") userId: string) {
    const principal = requestPrincipal(request);
    return listUserSkillsForPrincipal(requestedUserId(userId, request), principal);
  }

  @Patch(":userId/skills/:skillId")
  async updateSkill(@Req() request: any, @Param("userId") userId: string, @Param("skillId") skillId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return setUserSkillForPrincipal(requestedUserId(userId, request), skillId, skillBody(body), principal);
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
