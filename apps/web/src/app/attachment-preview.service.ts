import { Injectable, inject, signal } from "@angular/core";
import { ApiService } from "./api.service";
import { AttachmentDecryptionService } from "./attachment-decryption.service";
import { AttachmentEncryptionBootstrapService } from "./attachment-encryption-bootstrap.service";
import { PendingFile } from "./thread-uploads";
import { firstValueFrom } from "rxjs";

export interface PreviewEntry { id: number; name: string; size: number; directory: boolean; }
export interface PreviewState { open: boolean; busy: boolean; title: string; error: string; text: string; entries: PreviewEntry[]; archive: boolean; truncated: boolean; }
const empty = (): PreviewState => ({ open: false, busy: false, title: "", error: "", text: "", entries: [], archive: false, truncated: false });

@Injectable({ providedIn: "root" })
export class AttachmentPreviewService {
  private decrypt = inject(AttachmentDecryptionService);
  private bootstrap = inject(AttachmentEncryptionBootstrapService);
  private api = inject(ApiService);
  readonly state = signal<PreviewState>(empty());
  private worker: Worker | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private previousFocus: HTMLElement | null = null;
  close(): void {
    this.generation++; this.abort?.abort(); this.worker?.terminate(); this.worker = null;
    if (this.timer) clearTimeout(this.timer);
    this.state.set(empty()); this.previousFocus?.focus();
  }
  async openAttachment(attachment: Record<string, unknown>): Promise<void> {
    const downloadUrl = String(attachment["downloadUrl"] || "");
    const url = attachment["encrypted"] === true ? downloadUrl : downloadUrl.replace(/\/download(?:[?#].*)?$/, "/preview");
    await this.open(String(attachment["displayFilename"] || attachment["filename"] || attachment["name"] || "Attachment"), async signal => {
      await this.bootstrap.ensureReady();
      return this.decrypt.read({ ...attachment, downloadUrl: url }, signal, 26 * 1024 * 1024);
    });
  }
  async openPending(file: PendingFile): Promise<void> {
    await this.open(file.name, async signal => {
      if (file.file) return { filename: file.name, bytes: new Uint8Array(await file.file.arrayBuffer()) };
      if (!file.uploadSessionId) throw Error("Select this file again to preview it.");
      await this.bootstrap.ensureReady();
      return this.decrypt.read({ downloadUrl: this.api.inboundAttachmentPreviewUrl(file.uploadSessionId) }, signal, 26 * 1024 * 1024);
    });
  }
  private async open(title: string, read: (signal: AbortSignal) => Promise<{filename: string; bytes: Uint8Array}>): Promise<void> {
    this.close(); this.previousFocus = document.activeElement as HTMLElement;
    const generation = this.generation;
    const abort = new AbortController(); this.abort = abort;
    this.state.set({ ...empty(), open: true, busy: true, title });
    try {
      const features = await firstValueFrom(this.api.attachmentFeatures());
      if (generation !== this.generation) return;
      if (!features.textPreview && !features.archivePreview) throw Error("Attachment previews are paused. Downloads remain available.");
      const content = await read(abort.signal);
      if (generation !== this.generation) return;
      if (content.bytes.length > 25 * 1024 * 1024) throw Error("Preview limit is 25 MB. Download this file instead.");
      this.worker = new Worker(new URL("attachment-preview-worker.js", document.baseURI), { type: "module" });
      this.worker.onmessage = event => {
        if (generation !== this.generation) return;
        if (this.timer) clearTimeout(this.timer);
        this.state.update(state => ({ ...state, ...event.data, busy: false }));
      };
      this.worker.onerror = () => this.failure("Preview unavailable. Download this file instead.");
      this.state.update(state => ({ ...state, title: content.filename }));
      this.deadline();
      this.worker.postMessage({ bytes: content.bytes, filename: content.filename, features }, [content.bytes.buffer as ArrayBuffer]);
    } catch (error) { if (generation === this.generation) this.failure(error instanceof Error ? error.message : "Preview failed."); }
  }
  entry(entry: PreviewEntry): void {
    if (!this.worker || entry.directory || this.state().busy) return;
    this.state.update(state => ({ ...state, busy: true, text: "", error: "" }));
    this.deadline(); this.worker.postMessage({ entryId: entry.id });
  }
  private deadline(): void { this.timer = setTimeout(() => this.failure("Preview resource limit reached. Download the file instead."), 5000); }
  private failure(error: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort(); this.worker?.terminate(); this.worker = null;
    this.state.update(state => ({ ...state, busy: false, error }));
  }
}
