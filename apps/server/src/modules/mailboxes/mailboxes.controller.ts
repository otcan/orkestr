import { Body, Controller, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import {
  createMailboxForPrincipal,
  listMailboxDeadLetters,
  listMailboxRelayAudits,
  listMailboxesForPrincipal,
  publicMailbox,
} from "../../../../../packages/core/src/mailboxes.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function mailboxBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const key of [
    "id",
    "mailboxId",
    "ownerUserId",
    "userId",
    "address",
    "localPart",
    "displayName",
    "label",
    "purpose",
    "suffix",
    "status",
    "targetType",
    "tenantVmId",
    "selectionSource",
    "overrideReason",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.target && typeof body.target === "object") output.target = body.target;
  if (body.verification && typeof body.verification === "object") output.verification = body.verification;
  if (body.limits && typeof body.limits === "object") output.limits = body.limits;
  return output;
}

function auditQuery(query: Record<string, unknown> = {}) {
  return {
    mailboxId: String(query.mailboxId || "").trim(),
    tenantVmId: String(query.tenantVmId || "").trim(),
    states: String(query.state || query.states || "").trim().split(",").filter(Boolean),
    limit: Number(query.limit || 100) || 100,
  };
}

function rethrowHttp(error: any, fallback = "mailbox_request_failed"): never {
  throw httpError(String(error?.message || fallback), Number(error?.statusCode || 400) || 400);
}

@Controller("api/mailboxes")
export class MailboxesController {
  @Get()
  async list(@Req() request: any) {
    const principal = requestPrincipal(request);
    return {
      ok: true,
      mailboxes: (await listMailboxesForPrincipal(principal)).map((mailbox) => publicMailbox(mailbox)),
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      const mailbox = await createMailboxForPrincipal(mailboxBody(body), principal);
      return { ok: true, mailbox: publicMailbox(mailbox) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("relay-audits")
  async relayAudits(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("mailbox_relay_audit_admin_required", 403);
    return { ok: true, relayAudits: await listMailboxRelayAudits(auditQuery(query) as any) };
  }

  @Get("dead-letters")
  async deadLetters(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("mailbox_dead_letter_admin_required", 403);
    return { ok: true, deadLetters: await listMailboxDeadLetters(auditQuery(query) as any) };
  }
}
