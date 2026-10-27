import fs from "node:fs/promises";
import { syncRemoteWhatsAppThreadMessages } from "../../../../../packages/connectors/src/whatsapp-remote-runtime.js";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encryptedAttachmentPreview } from "../../../../../packages/core/src/attachment-preview.js";
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { multipartUploadLimits } from "../../../../../packages/shared/src/multipart-limits.js";
import { getThread, getThreadForPrincipal, getThreadMessage, listThreadMessages, updateThreadMessage } from "../../../../../packages/core/src/threads.js";
import { attachmentDownloadUrl, resolveStoredThreadAttachment, resolveThreadAttachments } from "../../../../../packages/core/src/thread-attachments.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { threadMessagesQuerySchema, threadUploadSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { ensureAttachmentsArray, httpError, validateRequestSchema } from "../../common/http.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { attachmentEncryptionPolicy } from "../../../../../packages/core/src/attachment-encryption-registry.js";
import { inboundAttachmentUploadPolicy } from "../../../../../packages/core/src/inbound-attachment-config.js";
import { hydrateEncryptedPublishedAttachmentPaths, validateEncryptedPublishedAttachment } from "../../../../../packages/core/src/encrypted-attachment-publication.js";
import { reissueEncryptedThreadAttachment } from "../../../../../packages/core/src/encrypted-attachment-reissue.js";
import { publicEncryptedAttachment } from "../../../../../packages/core/src/encrypted-attachment-projection.js";
import { storedThreadMessagePage } from "./thread-message-store-page.js";
import { recordScopedRelayRemoteDelivery } from "../../../../../packages/connectors/src/whatsapp-scoped-relay-remote.js";
import { ThreadActionSanitizerService } from "./thread-application.services.js";
import {
  scheduleNativeCodexHistorySync,
  syncNativeCodexHistory,
  threadHistoryPayload,
  threadMessagePage,
  threadMessagePageOptions,
} from "./thread-message-page.js";

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
  async messages(@Req() request: any, @Param("threadId") threadId: string, @Query() query: Record<string, unknown>) {
    validateRequestSchema(threadMessagesQuerySchema, { params: { threadId }, querystring: query || {} });
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    scheduleNativeCodexHistorySync(thread);
    const options = threadMessagePageOptions(request, query || {});
    return await storedThreadMessagePage(thread, query, null, options) ||
      threadMessagePage(thread, await listThreadMessages(thread.id), query, null, options);
  }

  // The scoped group relay reports a confirmed provider send of a mirrored
  // remote-runtime reply; the mirror acknowledgement then settles the input.
  @Post(":threadId/messages/:messageId/scoped-relay-delivery")
  @HttpCode(200)
  async scopedRelayDelivery(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    try {
      const result = await recordScopedRelayRemoteDelivery({ thread, messageId, body });
      const synced = await syncRemoteWhatsAppThreadMessages(process.env, fetch, {threadIds: [thread.id], push: true});
      if (synced.results.some((row: any) => row.error || row.acks?.rejected)) throw httpError('remote_delivery_ack_pending', 502);
      return { ok: true, threadId: thread.id, duplicate: result.duplicate, messageId: result.message.id,
        deliveryState: result.message.deliveryState };
    } catch (error: any) {
      throw httpError(error.message, error.statusCode || 500);
    }
  }

  // The scoped group relay sends the files of an assistant reply from their
  // plaintext outbound snapshots. Only snapshots V1 staged itself qualify:
  // the path, display name, type and the digest the worker must re-verify.
  @Get(":threadId/messages/:messageId/scoped-relay-files")
  async scopedRelayFiles(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Param("messageId") messageId: string,
  ) {
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    const message: any = await getThreadMessage(thread.id, messageId);
    if (!message) throw httpError("message_not_found", 404);
    if (String(message.role || "").trim().toLowerCase() !== "assistant") return { ok: true, files: [] };
    const files = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((attachment: any) => {
      const source = attachment?.encrypted === true ? attachment.deliverySource : attachment;
      const sha256 = String(source?.outboundSnapshot?.sha256 || "");
      const filePath = String(source?.path || "");
      if (!attachment?.id || !/^[0-9a-f]{64}$/.test(sha256) || !path.isAbsolute(filePath)) return [];
      return [{
        id: String(attachment.id),
        path: filePath,
        filename: path.basename(String(source.filename || source.name || "")) || "attachment",
        mimetype: String(source.mimetype || ""),
        sha256,
      }];
    });
    return { ok: true, files };
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
  @UseInterceptors(AnyFilesInterceptor({ limits: multipartUploadLimits() }))
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
    // Required encrypted ingress never accepts a plaintext browser fallback.
    if (inboundAttachmentUploadPolicy(process.env).required) {
      throw httpError("inbound_upload_encryption_required", 409);
    }
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

  @Get(":threadId/attachments/:attachmentId/preview")
  async previewAttachment(@Req() request: any, @Param("threadId") threadId: string,
    @Param("attachmentId") attachmentId: string, @Res() response: any) {
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    const resolved = await resolveStoredThreadAttachment({ thread, messages: await listThreadMessages(thread.id), attachmentId, env: process.env });
    if (!resolved.found || !resolved.allowed) throw httpError("attachment_not_found", 404);
    if (resolved.attachment?.encrypted === true) throw httpError("attachment_preview_use_encrypted_download", 409);
    const stream = await encryptedAttachmentPreview({ thread, attachment: { ...resolved.attachment, path: resolved.path } });
    response.setHeader("content-type", "application/age");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.on("close", () => stream.destroy());
    stream.on("error", () => response.destroy());
    return stream.pipe(response);
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

  @Post(":threadId/attachments/:attachmentId/reissue")
  @HttpCode(200)
  async reissueAttachment(
    @Req() request: any,
    @Param("threadId") threadId: string,
    @Param("attachmentId") attachmentId: string,
  ) {
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    try {
      const result = await reissueEncryptedThreadAttachment({ thread, attachmentId, env: process.env });
      const attachment = publicEncryptedAttachment({
        ...result.attachment,
        downloadUrl: attachmentDownloadUrl(thread.id, result.attachment),
      });
      return { ok: true, attachment };
    } catch (error: any) {
      throw httpError(String(error?.message || "attachment_reissue_failed"), Number(error?.statusCode || 409));
    }
  }

  @Get(":threadId/history")
  async history(@Param("threadId") threadId: string) {
    let thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    thread = await syncNativeCodexHistory(thread, { force: true });
    return threadHistoryPayload(thread);
  }
}
