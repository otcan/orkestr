import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import {
  cancelClaudeCodeLogin,
  claudeCodeEnabled,
  claudeCodeLoginSession,
  claudeCodeLoginStatus,
  startClaudeCodeLogin,
  submitClaudeCodeLoginCode,
} from "../../../../../packages/core/src/claude-code-client.js";
import {
  createLlmAccountProfile,
  listLlmAccountProfiles,
  publicLlmAccountProfile,
  resolveLlmAccountProfile,
  revokeLlmAccountProfile,
  updateLlmAccountProfileState,
} from "../../../../../packages/core/src/llm-account-profiles.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { interruptClaudeCodeThread, threadUsesClaudeCode } from "../../../../../packages/core/src/runtime-claude-code-adapter.js";
import { listThreads } from "../../../../../packages/core/src/threads.js";
import { adminUserId, normalizeUserId } from "../../../../../packages/core/src/users.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import { httpError } from "../../common/http.js";

function ownerForRequest(request: any, requested = ""): string {
  const principal = requestPrincipal(request);
  const own = normalizeUserId(principal?.userId || process.env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const target = normalizeUserId(requested || own);
  if (!target) throw httpError("llm_account_owner_required", 403);
  if (!isAdminPrincipal(principal) && target !== own) throw httpError("llm_account_owner_mismatch", 403);
  return target;
}

function assertClaudeCodeEnabled(): void {
  if (!claudeCodeEnabled(process.env)) throw httpError("claude_code_disabled", 409);
}

@Controller("api/llm-accounts")
export class LlmAccountsController {
  @Get()
  async list(@Req() request: any, @Query("ownerUserId") requestedOwner = "", @Query("provider") provider = "") {
    const ownerUserId = ownerForRequest(request, requestedOwner);
    return { enabled: claudeCodeEnabled(process.env), accounts: await listLlmAccountProfiles(ownerUserId, { provider }) };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertClaudeCodeEnabled();
    const ownerUserId = ownerForRequest(request, String(body.ownerUserId || ""));
    const account = await createLlmAccountProfile(ownerUserId, {
      provider: String(body.provider || "claude-code"),
      label: String(body.label || ""),
      authMode: String(body.authMode || "subscription"),
    });
    return { account };
  }

  @Post(":profileId/verify")
  @HttpCode(200)
  async verify(@Req() request: any, @Param("profileId") profileId: string, @Body() body: Record<string, unknown> = {}) {
    assertClaudeCodeEnabled();
    const ownerUserId = ownerForRequest(request, String(body.ownerUserId || ""));
    const profile = await resolveLlmAccountProfile({ ownerUserId, profileId, provider: "claude-code", requireReady: false });
    if (profile.authMode !== "subscription") throw httpError("llm_account_auth_mode_unsupported", 409);
    const status = await claudeCodeLoginStatus(profile, {}, process.env);
    const state = status.authenticated ? "ready" : status.reason === "claude_code_cli_missing" ? "error" : "login_required";
    const account = await updateLlmAccountProfileState(ownerUserId, profileId, state, {
      verified: status.authenticated,
      failureCode: status.authenticated ? "" : status.reason,
    });
    await appendEvent({
      type: "llm_account_profile_verified",
      ownerUserId,
      profileId,
      provider: "claude-code",
      authenticated: status.authenticated,
      failureCode: status.authenticated ? null : status.reason,
    });
    return { account: publicLlmAccountProfile(account), status };
  }

  @Post(":profileId/login")
  @HttpCode(200)
  async login(@Req() request: any, @Param("profileId") profileId: string, @Body() body: Record<string, unknown> = {}) {
    assertClaudeCodeEnabled();
    const ownerUserId = ownerForRequest(request, String(body.ownerUserId || ""));
    const profile = await resolveLlmAccountProfile({ ownerUserId, profileId, provider: "claude-code", requireReady: false });
    if (profile.state === "revoked") throw httpError("llm_account_profile_revoked", 410);
    const login = await startClaudeCodeLogin(profile, {}, process.env);
    await appendEvent({ type: "llm_account_login_started", ownerUserId, profileId, provider: "claude-code", state: login.state });
    return { login };
  }

  @Get(":profileId/login")
  async loginStatus(@Req() request: any, @Param("profileId") profileId: string, @Query("ownerUserId") requestedOwner = "") {
    const ownerUserId = ownerForRequest(request, requestedOwner);
    await resolveLlmAccountProfile({ ownerUserId, profileId, provider: "claude-code", requireReady: false });
    return { login: claudeCodeLoginSession(profileId) };
  }

  @Post(":profileId/login/code")
  @HttpCode(200)
  async submitLoginCode(@Req() request: any, @Param("profileId") profileId: string, @Body() body: Record<string, unknown> = {}) {
    assertClaudeCodeEnabled();
    const ownerUserId = ownerForRequest(request, String(body.ownerUserId || ""));
    await resolveLlmAccountProfile({ ownerUserId, profileId, provider: "claude-code", requireReady: false });
    const login = await submitClaudeCodeLoginCode(profileId, String(body.code || ""));
    await appendEvent({
      type: "llm_account_login_code_submitted",
      ownerUserId,
      profileId,
      provider: "claude-code",
    });
    return { login };
  }

  @Delete(":profileId")
  @HttpCode(200)
  async revoke(@Req() request: any, @Param("profileId") profileId: string, @Query("ownerUserId") requestedOwner = "") {
    const ownerUserId = ownerForRequest(request, requestedOwner);
    const account = await revokeLlmAccountProfile(ownerUserId, profileId);
    cancelClaudeCodeLogin(profileId);
    const threads = (await listThreads()).filter((thread: any) =>
      threadUsesClaudeCode(thread) &&
      String(thread.ownerUserId || thread.userId || "") === ownerUserId &&
      String(thread.executor?.accountProfileId || thread.executor?.metadata?.accountProfileId || "") === profileId
    );
    await Promise.all(threads.map((thread: any) => interruptClaudeCodeThread(thread).catch(() => ({ interrupted: false }))));
    return { ok: true, account, interruptedThreads: threads.length };
  }
}
