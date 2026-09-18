import { firstValueFrom } from "rxjs";
import * as age from "age-encryption";
import { createInboundAttachmentPayloadStream } from "../../../../packages/core/src/browser-inbound-attachment-payload.js";
import { ApiService, InboundAttachmentUploadSession } from "./api.service";

export interface PendingFile {
  id: string;
  file: File | null;
  name: string;
  size: number;
  type: string;
  uploadState?: string;
  uploadError?: string;
  uploadSessionId?: string;
  restoredAttachment?: Record<string, unknown> | null;
}

export function appendPendingFiles(current: PendingFile[], files: FileList | File[] | null): PendingFile[] {
  if (!files?.length) return current;
  const next = [...current];
  for (const file of Array.from(files)) {
    next.push({
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      name: file.name,
      size: file.size,
      type: file.type,
    });
  }
  return next;
}

export function removePendingFile(current: PendingFile[], id: string): PendingFile[] {
  return current.filter((file) => file.id !== id);
}

export function updatePendingFileUploadState(current: PendingFile[], id: string, patch: Pick<PendingFile, "uploadState" | "uploadError" | "uploadSessionId">): PendingFile[] {
  return current.map((file) => file.id === id ? { ...file, ...patch } : file);
}

function browserDraftKey(threadId: string): string {
  return `orkestr.inbound-upload-draft.v1:${threadId}`;
}

export function persistInboundUploadDraft(threadId: string, pendingFiles: PendingFile[]): void {
  try {
    const sessions = pendingFiles
      .filter((file) => file.uploadSessionId)
      .map((file) => ({ id: file.id, sessionId: file.uploadSessionId, state: file.uploadState || "" }));
    if (sessions.length) globalThis.sessionStorage?.setItem(browserDraftKey(threadId), JSON.stringify({ version: 1, sessions }));
    else globalThis.sessionStorage?.removeItem(browserDraftKey(threadId));
  } catch {
    // A restricted browser can still retain the in-memory retry state.
  }
}

export function clearInboundUploadDraft(threadId: string): void {
  try {
    globalThis.sessionStorage?.removeItem(browserDraftKey(threadId));
  } catch {
    // An inaccessible browser store cannot retain a recoverable draft.
  }
}

export async function recoverInboundUploadDraft(api: ApiService, threadId: string): Promise<PendingFile[]> {
  let saved: { version?: number; sessions?: Array<{ id?: string; sessionId?: string }> } | null = null;
  try {
    saved = JSON.parse(globalThis.sessionStorage?.getItem(browserDraftKey(threadId)) || "null");
  } catch {
    clearInboundUploadDraft(threadId);
  }
  if (saved?.version !== 1 || !Array.isArray(saved.sessions)) return [];
  const recovered: PendingFile[] = [];
  for (const savedSession of saved.sessions.slice(0, 20)) {
    const id = String(savedSession?.id || "").trim();
    const sessionId = String(savedSession?.sessionId || "").trim();
    if (!id || !sessionId || recovered.some((pending) => pending.id === id)) continue;
    try {
      const session = (await firstValueFrom(api.inboundAttachmentUploadSession(sessionId))).session;
      if (["claimed", "cancelled", "expired", "rejected"].includes(session.state)) continue;
      const attachment = session.attachment || null;
      recovered.push({
        id,
        file: null,
        name: String(attachment?.["filename"] || attachment?.["name"] || "attachment"),
        size: Math.max(0, Number(attachment?.["size"] || 0) || 0),
        type: String(attachment?.["mimetype"] || "application/octet-stream"),
        uploadState: attachment ? "ready" : "retryable",
        uploadError: attachment ? "" : session.state === "receiving" ? "Select this file again to retry securely." : "Retry to check processing and recover this attachment.",
        uploadSessionId: session.id,
        restoredAttachment: attachment,
      });
    } catch {
      // A transient read failure must not erase the only recovery reference.
      // No file metadata is persisted; authorization is rechecked on retry.
      recovered.push({ id, file: null, name: "Attachment awaiting recovery", size: 0,
        type: "application/octet-stream", uploadState: "retryable", uploadSessionId: sessionId,
        uploadError: "Could not recover this attachment. Retry or remove it." });
    }
  }
  persistInboundUploadDraft(threadId, recovered);
  return recovered;
}

function updateState(
  pendingFiles: PendingFile[],
  id: string,
  patch: Pick<PendingFile, "uploadState" | "uploadError" | "uploadSessionId">,
  onStatus?: (id: string, patch: Pick<PendingFile, "uploadState" | "uploadError" | "uploadSessionId">) => void,
): void {
  onStatus?.(id, patch);
  const pending = pendingFiles.find((file) => file.id === id);
  if (pending) Object.assign(pending, patch);
}

async function encryptAndUpload(api: ApiService, pending: PendingFile, session: InboundAttachmentUploadSession, signal?: AbortSignal): Promise<InboundAttachmentUploadSession> {
  if (!session.descriptor?.recipient || !pending.file?.stream) throw new Error("inbound_upload_descriptor_invalid");
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(session.descriptor.recipient);
  const payload = createInboundAttachmentPayloadStream(pending.file, { descriptor: session.descriptor });
  const ciphertext = await encrypter.encrypt(payload);
  return api.uploadInboundAttachmentCiphertext(session.id, ciphertext, signal);
}

export async function uploadPendingFiles(
  api: ApiService,
  threadId: string,
  pendingFiles: PendingFile[],
  onStatus?: (id: string, patch: Pick<PendingFile, "uploadState" | "uploadError" | "uploadSessionId">) => void,
  options: { persist?: () => void; signal?: AbortSignal; requireEncryption?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const persist = () => options.persist ? options.persist() : persistInboundUploadDraft(threadId, pendingFiles);
  if (!pendingFiles.length) return [];
  if (pendingFiles.every(file => file.uploadState === "ready" && file.restoredAttachment)) {
    return pendingFiles.map(file => file.restoredAttachment as Record<string, unknown>);
  }
  const ingress = await firstValueFrom(api.inboundAttachmentUploadStatus(threadId));
  if (!ingress.enabled) {
    if (options.requireEncryption) throw new Error("Encrypted uploads are unavailable. Retry when ready.");
    for (const pending of pendingFiles) {
      if (pending.size > 25 * 1024 * 1024) throw new Error(`${pending.name} is larger than 25 MB`);
    }
    const files = pendingFiles.map((pending) => {
      if (!pending.file) throw new Error("Select this file again before using a legacy upload.");
      return pending.file;
    });
    const payload = await firstValueFrom(api.uploadThreadFiles(threadId, files));
    return payload.attachments || [];
  }
  if (!ingress.ready) throw new Error(ingress.reason || "inbound_upload_not_ready");
  const maximum = Number(ingress.limits?.maxFileBytes || 25 * 1024 * 1024);
  for (const pending of pendingFiles) {
    if (pending.size > maximum) throw new Error(`${pending.name} is larger than the encrypted upload limit`);
  }
  const attachments = pendingFiles
    .filter((pending) => pending.uploadState === "ready" && pending.restoredAttachment)
    .map((pending) => pending.restoredAttachment as Record<string, unknown>);
  const sourceFiles = pendingFiles.filter((pending) => !pending.restoredAttachment);
  const unavailable = sourceFiles.filter((pending) => !pending.file && !pending.uploadSessionId);
  if (unavailable.length) {
    for (const pending of unavailable) updateState(pendingFiles, pending.id, { uploadState: "retryable", uploadError: "Select this file again to retry securely." }, onStatus);
    persist();
    throw new Error("Select the missing file again before retrying its encrypted upload.");
  }
  if (!sourceFiles.length) return attachments;
  const fresh = sourceFiles.filter(pending => !pending.uploadSessionId);
  const created = fresh.length ? await firstValueFrom(api.createInboundAttachmentUploadSessions(threadId, fresh.map((pending) => ({
    idempotencyKey: pending.id,
    plaintextSize: pending.size,
  })))) : { sessions: [] };
  const byPendingId = new Map(fresh.map((pending, index) => [pending.id, created.sessions?.[index]]));
  for (const pending of sourceFiles) {
    let session = pending.uploadSessionId
      ? (await firstValueFrom(api.inboundAttachmentUploadSession(pending.uploadSessionId))).session : byPendingId.get(pending.id);
    if (!session) throw new Error("inbound_upload_session_missing");
    if (session.state === "receiving" && pending.file && !session.descriptor) {
      session = (await firstValueFrom(api.createInboundAttachmentUploadSessions(threadId, [{idempotencyKey: pending.id, plaintextSize: pending.size}]))).sessions[0];
    }
    updateState(pendingFiles, pending.id, { uploadState: session.state, uploadError: "", uploadSessionId: session.id }, onStatus);
    persist();
    if (session.state === "ready" && session.attachment) {
      attachments.push(session.attachment);
      continue;
    }
    try {
      if (session.state === "receiving") {
        if (!pending.file) throw Error("Select this file again to retry securely.");
        updateState(pendingFiles, pending.id, { uploadState: "encrypting", uploadError: "", uploadSessionId: session.id }, onStatus);
        session = await encryptAndUpload(api, pending, session, options.signal);
      }
      if (session.state === "quarantined" || session.state === "retryable") {
        updateState(pendingFiles, pending.id, { uploadState: "processing", uploadError: "", uploadSessionId: session.id }, onStatus);
        session = (await firstValueFrom(api.processInboundAttachmentUpload(session.id))).session;
      }
      if (session.state !== "ready" || !session.attachment) throw new Error(session.error || `inbound_upload_${session.state}`);
      updateState(pendingFiles, pending.id, { uploadState: "ready", uploadError: "", uploadSessionId: session.id }, onStatus);
      pending.restoredAttachment = session.attachment;
      attachments.push(session.attachment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "inbound_upload_failed";
      updateState(pendingFiles, pending.id, { uploadState: "retryable", uploadError: detail, uploadSessionId: session.id }, onStatus);
      persist();
      throw error;
    }
  }
  persist();
  return attachments;
}

export function messageWithAttachmentPaths(text: string, attachments: Array<Record<string, unknown>>): string {
  if (attachments.some(item => item["uploadSessionId"])) return text;
  if (!attachments.length) return text;
  const paths = attachments
    .map((attachment) => String(attachment["path"] || attachment["saved_path"] || ""))
    .filter(Boolean)
    .map((savedPath) => `- ${savedPath}`)
    .join("\n");
  return [text, "Attached files saved for this Orkestr thread:", paths].filter(Boolean).join("\n\n");
}
