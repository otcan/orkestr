import { firstValueFrom } from "rxjs";
import { ApiService } from "./api.service";
import { appendPendingFiles, PendingFile, persistInboundUploadDraft, recoverInboundUploadDraft, uploadPendingFiles } from "./thread-uploads";

// A single bounded pump keeps encryption responsive on phones. State belongs
// to the original thread, not whichever conversation happens to be open now.
export class DraftUploadQueue {
  private drafts = new Map<string, PendingFile[]>();
  private running = false;
  private generation = 0;
  private aborts = new Map<string, AbortController>();
  constructor(private api: ApiService, private changed: (threadId: string) => void) {}
  files(threadId: string): PendingFile[] { return this.drafts.get(threadId) || []; }
  dispose(): void { this.generation++; for (const abort of this.aborts.values()) abort.abort(); this.drafts.clear(); }
  private publish(threadId: string): void {
    persistInboundUploadDraft(threadId, this.files(threadId));
    this.changed(threadId);
  }
  async restore(threadId: string): Promise<void> {
    if (this.drafts.has(threadId)) return;
    const generation = this.generation;
    const recovered = await recoverInboundUploadDraft(this.api, threadId);
    if (generation !== this.generation) return;
    if (!this.drafts.has(threadId)) this.drafts.set(threadId, recovered);
    this.publish(threadId);
  }
  add(threadId: string, files: FileList | File[]): void {
    const current = this.files(threadId);
    if (current.length + files.length > 20) throw Error("Attach at most 20 files.");
    if (Array.from(files).some(file => file.size > 25 * 1024 * 1024 || !file.size)) throw Error("Files must be between 1 byte and 25 MB.");
    const next = appendPendingFiles(current, files);
    for (const item of next.slice(current.length)) item.uploadState = "queued";
    this.drafts.set(threadId, next); this.publish(threadId); void this.pump();
  }
  remove(threadId: string, id: string): void {
    const item = this.files(threadId).find(file => file.id === id);
    this.drafts.set(threadId, this.files(threadId).filter(file => file.id !== id));
    this.aborts.get(id)?.abort();
    if (item?.uploadSessionId) void firstValueFrom(this.api.cancelInboundAttachmentUpload(item.uploadSessionId)).catch(() => {});
    this.publish(threadId);
  }
  retry(threadId: string, id: string): void {
    const item = this.files(threadId).find(file => file.id === id);
    if (!item) return;
    item.uploadState = "queued"; item.uploadError = "";
    this.publish(threadId); void this.pump();
  }
  submitted(threadId: string, ids: string[]): void {
    this.drafts.set(threadId, this.files(threadId).filter(file => !ids.includes(file.id)));
    this.publish(threadId);
  }
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const entry = [...this.drafts].flatMap(([threadId, files]) => files.map(file => ({threadId, file})))
          .find(item => item.file.uploadState === "queued");
        if (!entry) break;
        const { threadId, file } = entry;
        const abort = new AbortController(); this.aborts.set(file.id, abort);
        const present = () => this.files(threadId).includes(file);
        try {
          // Eager upload must never fall back to legacy plaintext multipart.
          const status = await firstValueFrom(this.api.inboundAttachmentUploadStatus(threadId));
          if (status.features?.eagerUploads === false) throw Error("New eager uploads are paused. Existing ready attachments can still be sent.");
          if (!status.enabled || !status.ready) throw Error("Encrypted uploads are unavailable. Retry when ready.");
          if (!present()) continue;
          const attachments = await uploadPendingFiles(this.api, threadId, [file], (_id, patch) => {
            Object.assign(file, patch);
            if (!present()) throw Error("Upload removed.");
            this.publish(threadId);
          }, { signal: abort.signal, requireEncryption: true, persist: () => this.publish(threadId) });
          if (present()) { file.restoredAttachment = attachments[0]; file.uploadState = "ready"; }
        } catch (error) {
          if (present()) { file.uploadState = "retryable"; file.uploadError = error instanceof Error ? error.message : "Upload failed."; }
        } finally {
          if (!present() && file.uploadSessionId) await firstValueFrom(this.api.cancelInboundAttachmentUpload(file.uploadSessionId)).catch(() => {});
          this.aborts.delete(file.id); this.publish(threadId);
        }
      }
    } finally { this.running = false; }
  }
}
