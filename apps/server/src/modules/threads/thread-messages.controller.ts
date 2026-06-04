import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { getThread, getThreadForPrincipal, listThreadMessages } from "../../../../../packages/core/src/threads.js";
import { resolveStoredThreadAttachment, resolveThreadAttachments } from "../../../../../packages/core/src/thread-attachments.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { threadMessagesQuerySchema, threadUploadSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
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
    const resolved = await resolveStoredThreadAttachment({
      thread,
      messages: await listThreadMessages(thread.id),
      attachmentId,
      env: process.env,
    });
    if (!resolved.found) throw httpError("attachment_not_found", 404);
    if (!resolved.allowed) throw httpError(resolved.reason || "attachment_forbidden", 403);
    const attachment = resolved.attachment || {};
    const filePath = String(resolved.path || "");
    if (!filePath) throw httpError("attachment_path_missing", 403);
    const buffer = await fs.readFile(filePath);
    response.setHeader("content-type", String(attachment.mimetype || "application/octet-stream"));
    response.setHeader("content-length", String(buffer.length));
    response.setHeader("content-disposition", `attachment; filename="${contentDispositionFilename(String(attachment.filename || attachment.name || "attachment"))}"`);
    return response.send(buffer);
  }

  @Get(":threadId/history")
  async history(@Param("threadId") threadId: string) {
    let thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    thread = await syncNativeCodexHistory(thread, { force: true });
    return threadHistoryPayload(thread);
  }
}
