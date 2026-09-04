import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Put, Req } from "@nestjs/common";
import {
  attachmentEncryptionStatus,
  registerAttachmentEncryptionRecipient,
  revokeAttachmentEncryptionRecipient,
  setAttachmentEncryptionPolicy,
  verifyAttachmentEncryptionRecipient,
} from "../../../../../packages/core/src/attachment-encryption-registry.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { migrateThreadAttachmentsToEncryption } from "../../../../../packages/core/src/attachment-encryption-migration.js";

function fail(error: any): never {
  if (error instanceof HttpException) throw error;
  const status = Number(error?.statusCode || 500) || 500;
  throw new HttpException({ error: String(error?.message || error || "attachment_encryption_error") }, status);
}

@Controller("api/attachment-encryption")
export class AttachmentEncryptionController {
  @Get()
  async status(@Req() request: any) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await attachmentEncryptionStatus(principal.userId)) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("recipients")
  @HttpCode(201)
  async register(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await registerAttachmentEncryptionRecipient({
        recipient: String(body.recipient || ""),
        label: String(body.label || ""),
      }, principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("recipients/:recipientId/verify")
  async verify(@Req() request: any, @Param("recipientId") recipientId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await verifyAttachmentEncryptionRecipient(recipientId, String(body.proof || ""), principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Delete("recipients/:recipientId")
  async revoke(@Req() request: any, @Param("recipientId") recipientId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await revokeAttachmentEncryptionRecipient(recipientId, String(body.reason || ""), principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Put("policy")
  async policy(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await setAttachmentEncryptionPolicy({
        enabled: body.enabled === true,
        required: body.required === true,
      }, principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("migrate")
  async migrate(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const principal = requestPrincipal(request);
      const thread = await getThreadForPrincipal(String(body.threadId || ""), principal);
      return migrateThreadAttachmentsToEncryption(thread.id, { dryRun: body.dryRun !== false });
    } catch (error) {
      fail(error);
    }
  }
}
