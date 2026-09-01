import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { getThread, getThreadForPrincipal, getThreadMessage, listThreadMessages, updateThreadMessage } from "../../../../../packages/core/src/threads.js";
import { resolveStoredThreadAttachment, resolveThreadAttachments } from "../../../../../packages/core/src/thread-attachments.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { threadMessagesQuerySchema, threadUploadSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { ensureAttachmentsArray, httpError, validateRequestSchema } from "../../common/http.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { attachmentEncryptionPolicy } from "../../../../../packages/core/src/attachment-encryption-registry.js";
import { hydrateEncryptedPublishedAttachmentPaths, validateEncryptedPublishedAttachment } from "../../../../../packages/core/src/encrypted-attachment-publication.js";
import { ThreadActionSanitizerService } from "./thread-application.services.js";
import { scheduleNativeCodexHistorySync, syncNativeCodexHistory, threadHistoryPayload, threadMessagePage } from "./thread-message-page.js";

function safeUploadName(name: unknown): string {
  const base = path.basename(String(name || "upload.bin")).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return base || "upload.bin";
}

function uploadBuffer(file: any): Buffer {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  const encoded = String(file?.contentBase64 || "").trim();
  if (!encoded) throw httpError("upload_content_required", 400);
  return Buffer.from(encoded, "base64");
}

function contentDispositionFilename(name: string): string {
  return path.basename(String(name || "attachment")).replace(/["\r\n\\]/g, "_") || "attachment";
}

@Controller("api/threads")
export class ThreadMessagesController {
  constructor(
    private readonly threadActionSanitizer: ThreadActionSanitizerService,
  ) {}

  @Get(":threadId/messages")
  async messages(@Param("threadId") threadId: string, @Query() query: Record<string, unknown>) {
    validateRequestSchema(threadMessagesQuerySchema, { params: { threadId }, querystring: query || {} });
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    scheduleNativeCodexHistorySync(thread);
    return threadMessagePage(thread, await listThreadMessages(thread.id), query, null);
  }

  @Patch(":threadId/messages/:messageId/whatsapp-inbound-revision")
  async reviseWhatsAppInbound(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    ensureAttachmentsArray(body);
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    const current: any = await getThreadMessage(thread.id, messageId);
    if (!current) throw httpError("message_not_found", 404);
    if (String(current.role || "").trim().toLowerCase() !== "user" || String(current.source || "").trim() !== "whatsapp_inbound") {
      throw httpError("whatsapp_inbound_revision_target_invalid", 409);
    }
    const publicMessageId = String(body.publicMessageId || "").trim();
    if (!publicMessageId || (current.publicMessageId && String(current.publicMessageId) !== publicMessageId)) {
      throw httpError("whatsapp_inbound_revision_source_mismatch", 409);
    }
    const revisionId = String(body.revisionId || body.sourceEventId || "").trim();
    if (!revisionId) throw httpError("whatsapp_inbound_revision_id_required", 400);
    const revisionIds = [...new Set([
      ...(Array.isArray(current.whatsappInboundRevisionIds) ? current.whatsappInboundRevisionIds : []),
      revisionId,
    ].map((value) => String(value || "").trim()).filter(Boolean))];
    const message = await updateThreadMessage(thread.id, current.id, {
      text: String(body.text || current.text || ""),
      attachments: Array.isArray(body.attachments) ? body.attachments : current.attachments,
      whatsappInboundRevisionIds: revisionIds,
      whatsappInboundRevisedAt: new Date().toISOString(),
      whatsappInboundRevisionSource: "remote_whatsapp_router",
    }, process.env, {
      expectedStates: ["queued", "pending_delivery"],
      stateConflictError: "whatsapp_inbound_revision_expired",
      idempotencyField: "whatsappInboundRevisionIds",
      idempotencyKey: revisionId,
    });
    return { ok: true, duplicate: message.duplicate === true, threadId: thread.id, message };
  }

  @Post(":threadId/uploads")
  @HttpCode(201)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 20 } }))
  async uploads(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Body() body: Record<string, unknown> = {},
    @UploadedFiles() uploadedFiles: any[] = [],
  ) {
    validateRequestSchema(threadUploadSchema, { params: { threadId }, body });
    const principal = requestPrincipal(request);
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const files = uploadedFiles.length ? uploadedFiles : Array.isArray(body.files) ? body.files : [];
    if (!files.length) throw httpError("upload_files_required", 400);
    await this.threadActionSanitizer.assertAllowed("thread.upload", principal, thread, {
      ...body,
      files: files.map((file: any) => ({
        name: file?.originalname || file?.name || "",
        mimetype: file?.mimetype || file?.type || "",
        size: uploadBuffer(file).length,
      })),
    });
    const paths = await ensureDataDirs();
    const uploadDir = path.join(paths.home, "uploads", thread.id);
    await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
    const attachments: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const name = safeUploadName((file as any)?.originalname || (file as any)?.name);
      const buffer = uploadBuffer(file);
      if (buffer.length > 25 * 1024 * 1024) throw httpError(`upload_too_large:${name}`, 413);
      const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${name}`;
      const savedPath = path.join(uploadDir, storedName);
      await fs.writeFile(savedPath, buffer, { mode: 0o600 });
      attachments.push({
        name,
        filename: name,
        mimetype: String((file as any)?.mimetype || (file as any)?.type || "application/octet-stream"),
        size: buffer.length,
        path: savedPath,
        saved_path: savedPath,
        source: "browser_upload",
      });
    }
    const resolved = await (resolveThreadAttachments as any)({ thread, attachments, env: process.env });
    return { ok: true, threadId: thread.id, attachments: resolved.attachments.length ? resolved.attachments : attachments };
  }

  @Get(":threadId/attachments/:attachmentId/download")
  async downloadAttachment(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() response: any,
  ) {
    const principal = requestPrincipal(request);
    const thread = await getThreadForPrincipal(threadId, principal);
    if (!thread) throw httpError("thread_not_found", 404);
    const storedMessages = await listThreadMessages(thread.id);
    const resolved = await resolveStoredThreadAttachment({
      thread,
      messages: storedMessages.map((message) => ({
        ...message,
        attachments: hydrateEncryptedPublishedAttachmentPaths(thread, message.attachments, process.env),
      })),
      attachmentId,
      env: process.env,
    });
    if (!resolved.found) throw httpError("attachment_not_found", 404);
    if (!resolved.allowed) throw httpError(resolved.reason || "attachment_forbidden", 403);
    const attachment = resolved.attachment || {};
    const encryptionPolicy = await attachmentEncryptionPolicy(thread.ownerUserId);
    if (encryptionPolicy.enabled && attachment.encrypted !== true) {
      throw httpError("attachment_encryption_required", 409);
    }
    if (attachment.encrypted === true) {
      const validation = await validateEncryptedPublishedAttachment(attachment, { thread, env: process.env });
      if (!validation.ok) throw httpError(`attachment_encryption_${validation.reason}`, 409);
    }
    const filePath = String(resolved.path || "");
    if (!filePath) throw httpError("attachment_path_missing", 403);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw httpError("attachment_file_missing", 404);
    response.setHeader("content-type", String(attachment.mimetype || "application/octet-stream"));
    response.setHeader("content-length", String(stat.size));
    response.setHeader("content-disposition", `attachment; filename="${contentDispositionFilename(String(attachment.filename || attachment.name || "attachment"))}"`);
    return createReadStream(filePath).pipe(response);
  }

  @Get(":threadId/history")
  async history(@Param("threadId") threadId: string) {
    let thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    thread = await syncNativeCodexHistory(thread, { force: true });
    return threadHistoryPayload(thread);
  }
}
