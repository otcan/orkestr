import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ingestMailboxMessage } from "../../../../../packages/connectors/src/mailbox-inbox.js";
import {
  createMailboxForPrincipal,
  deleteMailboxForPrincipal,
  mailboxInfrastructureStatus,
  listMailboxDeadLetters,
  listMailboxRelayAudits,
  listMailboxesForPrincipal,
  publicMailbox,
  replayMailboxDeadLetterForPrincipal,
  retryMailboxRelayForPrincipal,
  rotateMailboxForPrincipal,
  verifyMailboxForPrincipal,
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
    "idempotencyKey",
    "requestId",
    "provider",
    "state",
    "lastError",
    "verifiedAt",
    "confirm",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.target && typeof body.target === "object") output.target = body.target;
  if (body.verification && typeof body.verification === "object") output.verification = body.verification;
  if (body.limits && typeof body.limits === "object") output.limits = body.limits;
  if (body.confirm === true) output.confirm = true;
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

  @Get("infrastructure")
  async infrastructure(@Req() request: any) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("mailbox_infrastructure_admin_required", 403);
    return { ok: true, infrastructure: mailboxInfrastructureStatus({}, process.env) };
  }

  @Patch(":mailboxId/verification")
  async verify(@Req() request: any, @Param("mailboxId") mailboxId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return { ok: true, mailbox: await verifyMailboxForPrincipal(mailboxId, mailboxBody(body), requestPrincipal(request)) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Delete(":mailboxId")
  async delete(@Req() request: any, @Param("mailboxId") mailboxId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return { ok: true, mailbox: await deleteMailboxForPrincipal(mailboxId, mailboxBody(body), requestPrincipal(request)) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post(":mailboxId/rotate")
  @HttpCode(200)
  async rotate(@Req() request: any, @Param("mailboxId") mailboxId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return { ok: true, ...(await rotateMailboxForPrincipal(mailboxId, mailboxBody(body), requestPrincipal(request))) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("ingest")
  @HttpCode(202)
  async ingest(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("mailbox_ingest_admin_required", 403);
    try {
      return await ingestMailboxMessage(body, process.env);
    } catch (error) {
      rethrowHttp(error, "mailbox_ingest_failed");
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

  @Post("relay-audits/:relayAuditId/retry")
  @HttpCode(200)
  async retryRelay(@Req() request: any, @Param("relayAuditId") relayAuditId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return { ok: true, relayAudit: await retryMailboxRelayForPrincipal(relayAuditId, mailboxBody(body), requestPrincipal(request)) };
    } catch (error) {
      rethrowHttp(error, "mailbox_relay_retry_failed");
    }
  }

  @Post("dead-letters/:deadLetterId/replay")
  @HttpCode(200)
  async replayDeadLetter(@Req() request: any, @Param("deadLetterId") deadLetterId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return { ok: true, relayAudit: await replayMailboxDeadLetterForPrincipal(deadLetterId, mailboxBody(body), requestPrincipal(request)) };
    } catch (error) {
      rethrowHttp(error, "mailbox_dead_letter_replay_failed");
    }
  }
}
