import { firstValueFrom } from "rxjs";
import { ApiService } from "./api.service";

export interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
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

export async function uploadPendingFiles(
  api: ApiService,
  threadId: string,
  pendingFiles: PendingFile[],
): Promise<Array<Record<string, unknown>>> {
  if (!pendingFiles.length) return [];
  for (const pending of pendingFiles) {
    if (pending.size > 25 * 1024 * 1024) throw new Error(`${pending.name} is larger than 25 MB`);
  }
  const payload = await firstValueFrom(api.uploadThreadFiles(threadId, pendingFiles.map((pending) => pending.file)));
  return payload.attachments || [];
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
