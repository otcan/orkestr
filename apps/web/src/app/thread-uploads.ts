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

export function appendPendingFiles(current: PendingFile[], files: FileList | null): PendingFile[] {
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
      const attachment = session.attachment || null;
      recovered.push({
        id,
        file: null,
        name: String(attachment?.["filename"] || attachment?.["name"] || "attachment"),
        size: Math.max(0, Number(attachment?.["size"] || 0) || 0),
        type: String(attachment?.["mimetype"] || "application/octet-stream"),
        uploadState: attachment ? "ready" : session.state,
        uploadError: attachment ? "" : "Select this file again to retry securely.",
        uploadSessionId: session.id,
        restoredAttachment: attachment,
      });
    } catch {
      // Session expiry and authorization changes remain server-authoritative.
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

async function encryptAndUpload(api: ApiService, pending: PendingFile, session: InboundAttachmentUploadSession): Promise<InboundAttachmentUploadSession> {
  if (!session.descriptor?.recipient || !pending.file?.stream) throw new Error("inbound_upload_descriptor_invalid");
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(session.descriptor.recipient);
  const payload = createInboundAttachmentPayloadStream(pending.file, { descriptor: session.descriptor });
  const ciphertext = await encrypter.encrypt(payload);
  return api.uploadInboundAttachmentCiphertext(session.id, ciphertext);
}

export async function uploadPendingFiles(
  api: ApiService,
  threadId: string,
  pendingFiles: PendingFile[],
  onStatus?: (id: string, patch: Pick<PendingFile, "uploadState" | "uploadError" | "uploadSessionId">) => void,
): Promise<Array<Record<string, unknown>>> {
  if (!pendingFiles.length) return [];
  const ingress = await firstValueFrom(api.inboundAttachmentUploadStatus(threadId));
  if (!ingress.enabled) {
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
  const unavailable = sourceFiles.filter((pending) => !pending.file);
  if (unavailable.length) {
    for (const pending of unavailable) updateState(pendingFiles, pending.id, { uploadState: "retryable", uploadError: "Select this file again to retry securely." }, onStatus);
    persistInboundUploadDraft(threadId, pendingFiles);
    throw new Error("Select the missing file again before retrying its encrypted upload.");
  }
  if (!sourceFiles.length) return attachments;
  const created = await firstValueFrom(api.createInboundAttachmentUploadSessions(threadId, sourceFiles.map((pending) => ({
    idempotencyKey: pending.id,
    plaintextSize: pending.size,
  }))));
  const sessions = new Map((created.sessions || []).map((session) => [session.id, session]));
  const byPendingId = new Map(sourceFiles.map((pending, index) => [pending.id, created.sessions?.[index]]));
  for (const pending of sourceFiles) {
    let session = byPendingId.get(pending.id);
    if (!session || !sessions.has(session.id)) throw new Error("inbound_upload_session_missing");
    updateState(pendingFiles, pending.id, { uploadState: session.state, uploadError: "", uploadSessionId: session.id }, onStatus);
    persistInboundUploadDraft(threadId, pendingFiles);
    if (session.state === "ready" && session.attachment) {
      attachments.push(session.attachment);
      continue;
    }
    try {
      if (session.state === "receiving") {
        updateState(pendingFiles, pending.id, { uploadState: "encrypting", uploadError: "", uploadSessionId: session.id }, onStatus);
        session = await encryptAndUpload(api, pending, session);
      }
      if (session.state === "quarantined" || session.state === "retryable") {
        updateState(pendingFiles, pending.id, { uploadState: "scanning", uploadError: "", uploadSessionId: session.id }, onStatus);
        session = (await firstValueFrom(api.processInboundAttachmentUpload(session.id))).session;
      }
      if (session.state !== "ready" || !session.attachment) throw new Error(session.error || `inbound_upload_${session.state}`);
      updateState(pendingFiles, pending.id, { uploadState: "ready", uploadError: "", uploadSessionId: session.id }, onStatus);
      attachments.push(session.attachment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "inbound_upload_failed";
      updateState(pendingFiles, pending.id, { uploadState: "retryable", uploadError: detail, uploadSessionId: session.id }, onStatus);
      persistInboundUploadDraft(threadId, pendingFiles);
      throw error;
    }
  }
  persistInboundUploadDraft(threadId, pendingFiles);
  return attachments;
}

export function messageWithAttachmentPaths(text: string, attachments: Array<Record<string, unknown>>): string {
  if (!attachments.length) return text;
  const paths = attachments
    .map((attachment) => String(attachment["path"] || attachment["saved_path"] || ""))
    .filter(Boolean)
    .map((savedPath) => `- ${savedPath}`)
    .join("\n");
  return [text, "Attached files saved for this Orkestr thread:", paths].filter(Boolean).join("\n\n");
}
