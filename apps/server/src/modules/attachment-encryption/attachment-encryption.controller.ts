import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { inboundAttachmentPreviewStream } from "../../../../../packages/core/src/inbound-attachment-preview.js";
import { attachmentFeaturePolicy } from "../../../../../packages/core/src/attachment-feature-policy.js";
import {
  attachmentEncryptionStatus,
  registerAttachmentEncryptionRecipient,
  revokeAttachmentEncryptionRecipient,
  setAttachmentEncryptionPolicy,
  verifyAttachmentEncryptionRecipient,
} from "../../../../../packages/core/src/attachment-encryption-registry.js";
import {
  cancelInboundAttachmentUpload,
  createInboundAttachmentUploadSessions,
  inboundAttachmentUploadSession,
  inboundAttachmentUploadStatus,
  ingestInboundAttachmentCiphertext,
  processInboundAttachmentUpload,
} from "../../../../../packages/core/src/inbound-attachment-quarantine.js";
import {
  inboundAttachmentKeyStatus,
  revokeInboundAttachmentKey,
  rotateInboundAttachmentKey,
} from "../../../../../packages/core/src/inbound-attachment-keys.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { migrateThreadAttachmentsToEncryption } from "../../../../../packages/core/src/attachment-encryption-migration.js";
import {
  attachmentEncryptionMigrationSchema,
  attachmentEncryptionPolicySchema,
  attachmentEncryptionRecipientSchema,
  attachmentEncryptionRevokeSchema,
  attachmentEncryptionVerifySchema,
  inboundAttachmentSessionCreateSchema,
  inboundAttachmentKeyParamsSchema,
  inboundAttachmentSessionParamsSchema,
  inboundAttachmentStatusSchema,
} from "../../../../../packages/shared/src/api-schemas.js";
import { validateRequestSchema } from "../../common/http.js";

function fail(error: any): never {
  if (error instanceof HttpException) throw error;
  const status = Number(error?.statusCode || 500) || 500;
  throw new HttpException({ error: String(error?.message || error || "attachment_encryption_error") }, status);
}

@Controller("api/attachment-encryption")
export class AttachmentEncryptionController {
  @Get("features")
  features() { return attachmentFeaturePolicy(); }

  @Get()
  async status(@Req() request: any) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, ...(await attachmentEncryptionStatus(principal.userId)) };
    } catch (error) {
      fail(error);
    }
  }

  @Get("inbound/status")
  async inboundStatus(@Req() request: any, @Query("threadId") threadId = "") {
    try {
      validateRequestSchema(inboundAttachmentStatusSchema, { querystring: { threadId } });
      return { ok: true, ...(await inboundAttachmentUploadStatus({ threadId, principal: requestPrincipal(request) } as any)) };
    } catch (error) {
      fail(error);
    }
  }

  @Get("inbound/keys")
  async inboundKeys(@Req() request: any) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, keys: await inboundAttachmentKeyStatus(principal.userId) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("inbound/keys/rotate")
  @HttpCode(201)
  async rotateInboundKey(@Req() request: any) {
    try {
      const principal = requestPrincipal(request);
      return { ok: true, key: await rotateInboundAttachmentKey(principal.userId) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("inbound/keys/:keyId/revoke")
  async revokeInboundKey(@Req() request: any, @Param("keyId") keyId: string) {
    try {
      validateRequestSchema(inboundAttachmentKeyParamsSchema, { params: { keyId } });
      const principal = requestPrincipal(request);
      return { ok: true, key: await revokeInboundAttachmentKey(principal.userId, keyId) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("inbound/sessions")
  @HttpCode(201)
  async createInboundSessions(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      validateRequestSchema(inboundAttachmentSessionCreateSchema, { body });
      return {
        ok: true,
        ...(await createInboundAttachmentUploadSessions({
          threadId: String(body.threadId || ""),
          files: Array.isArray(body.files) ? body.files : [],
          principal: requestPrincipal(request),
        } as any)),
      };
    } catch (error) {
      fail(error);
    }
  }

  @Get("inbound/sessions/:sessionId")
  async inboundSession(@Req() request: any, @Param("sessionId") sessionId: string) {
    try {
      validateRequestSchema(inboundAttachmentSessionParamsSchema, { params: { sessionId } });
      return { ok: true, session: await inboundAttachmentUploadSession({ sessionId, principal: requestPrincipal(request) } as any) };
    } catch (error) {
      fail(error);
    }
  }

  @Get("inbound/sessions/:sessionId/preview")
  async inboundPreview(@Req() request: any, @Param("sessionId") sessionId: string, @Res() response: any) {
    try {
      const stream = await inboundAttachmentPreviewStream({ sessionId, principal: requestPrincipal(request) } as any);
      response.setHeader("content-type", "application/age");
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.on("close", () => stream.destroy());
      stream.on("error", () => response.destroy());
      return stream.pipe(response);
    } catch (error) { fail(error); }
  }

  @Post("inbound/sessions/:sessionId/cancel")
  async cancelInboundSession(@Req() request: any, @Param("sessionId") sessionId: string) {
    try {
      validateRequestSchema(inboundAttachmentSessionParamsSchema, { params: { sessionId } });
      return { ok: true, session: await cancelInboundAttachmentUpload({ sessionId, principal: requestPrincipal(request) } as any) };
    } catch (error) {
      fail(error);
    }
  }

  @Put("inbound/sessions/:sessionId/ciphertext")
  @HttpCode(201)
  async uploadInboundCiphertext(@Req() request: any, @Param("sessionId") sessionId: string) {
    try {
      validateRequestSchema(inboundAttachmentSessionParamsSchema, { params: { sessionId } });
      const contentType = String(request?.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/age") {
        const error: any = new Error("inbound_upload_ciphertext_content_type_required");
        error.statusCode = 415;
        throw error;
      }
      return {
        ok: true,
        session: await ingestInboundAttachmentCiphertext({ sessionId, principal: requestPrincipal(request), input: request } as any),
      };
    } catch (error) {
      fail(error);
    }
  }

  @Post("inbound/sessions/:sessionId/process")
  async processInboundSession(@Req() request: any, @Param("sessionId") sessionId: string) {
    try {
      validateRequestSchema(inboundAttachmentSessionParamsSchema, { params: { sessionId } });
      return { ok: true, session: await processInboundAttachmentUpload({ sessionId, principal: requestPrincipal(request) } as any) };
    } catch (error) {
      fail(error);
    }
  }

  @Post("recipients")
  @HttpCode(201)
  async register(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      validateRequestSchema(attachmentEncryptionRecipientSchema, { body });
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
      validateRequestSchema(attachmentEncryptionVerifySchema, { params: { recipientId }, body });
      const principal = requestPrincipal(request);
      return { ok: true, ...(await verifyAttachmentEncryptionRecipient(recipientId, String(body.proof || ""), principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Delete("recipients/:recipientId")
  async revoke(@Req() request: any, @Param("recipientId") recipientId: string, @Body() body: Record<string, unknown> = {}) {
    try {
      validateRequestSchema(attachmentEncryptionRevokeSchema, { params: { recipientId }, body });
      const principal = requestPrincipal(request);
      return { ok: true, ...(await revokeAttachmentEncryptionRecipient(recipientId, String(body.reason || ""), principal)) };
    } catch (error) {
      fail(error);
    }
  }

  @Put("policy")
  async policy(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    try {
      validateRequestSchema(attachmentEncryptionPolicySchema, { body });
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
      validateRequestSchema(attachmentEncryptionMigrationSchema, { body });
      const principal = requestPrincipal(request);
      const thread = await getThreadForPrincipal(String(body.threadId || ""), principal);
      return migrateThreadAttachmentsToEncryption(thread.id, { dryRun: body.dryRun !== false });
    } catch (error) {
      fail(error);
    }
  }
}
