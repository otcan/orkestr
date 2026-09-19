import { Injectable, inject, signal } from "@angular/core";
import { ApiService } from "./api.service";
import { AttachmentDecryptionService } from "./attachment-decryption.service";
import { AttachmentEncryptionBootstrapService } from "./attachment-encryption-bootstrap.service";
import { PendingFile } from "./thread-uploads";
import { firstValueFrom } from "rxjs";

export interface PreviewEntry { id: number; name: string; size: number; directory: boolean; }
export interface PreviewState { open: boolean; busy: boolean; title: string; rootTitle: string; size: number; typeLabel: string; kind: string; mediaType: string; bytes: Uint8Array | null; error: string; text: string; entries: PreviewEntry[]; archive: boolean; truncated: boolean; }
const empty = (): PreviewState => ({ open: false, busy: false, title: "", rootTitle: "", size: 0, typeLabel: "Detecting type…", kind: "", mediaType: "", bytes: null, error: "", text: "", entries: [], archive: false, truncated: false });

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
  private retryAction: (() => Promise<void>) | null = null;
  private downloadAction: (() => Promise<unknown>) | null = null;
  close(): void {
    this.generation++; this.abort?.abort(); this.worker?.terminate(); this.worker = null;
    if (this.timer) clearTimeout(this.timer);
    this.state.set(empty()); this.previousFocus?.focus();
    this.retryAction = null; this.downloadAction = null;
  }
  async openAttachment(attachment: Record<string, unknown>): Promise<void> {
    const downloadUrl = String(attachment["downloadUrl"] || "");
    const url = attachment["encrypted"] === true ? downloadUrl : downloadUrl.replace(/\/download(?:[?#].*)?$/, "/preview");
    const opening = this.open(String(attachment["displayFilename"] || attachment["filename"] || attachment["name"] || "Attachment"), async signal => {
      await this.bootstrap.ensureReady();
      return this.decrypt.read({ ...attachment, downloadUrl: url }, signal, 26 * 1024 * 1024);
    });
    this.retryAction = () => this.openAttachment(attachment);
    this.downloadAction = async () => { await this.bootstrap.ensureReady(); return this.decrypt.download({ ...attachment, downloadUrl: url }); };
    await opening;
  }
  async openPending(file: PendingFile): Promise<void> {
    const opening = this.open(file.name, async signal => {
      if (file.file) {
        if (file.file.size > 25 * 1024 * 1024) throw Error("Preview limit is 25 MB. Download this file instead.");
        return { filename: file.name, bytes: new Uint8Array(await file.file.arrayBuffer()) };
      }
      if (!file.uploadSessionId) throw Error("Select this file again to preview it.");
      await this.bootstrap.ensureReady();
      return this.decrypt.read({ downloadUrl: this.api.inboundAttachmentPreviewUrl(file.uploadSessionId) }, signal, 26 * 1024 * 1024);
    });
    this.retryAction = () => this.openPending(file);
    this.downloadAction = async () => {
      if (file.file) {
        const url = URL.createObjectURL(file.file), link = document.createElement("a");
        link.href = url; link.download = file.name; link.rel = "noopener";
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      } else if (file.uploadSessionId) {
        await this.bootstrap.ensureReady();
        await this.decrypt.download({ downloadUrl: this.api.inboundAttachmentPreviewUrl(file.uploadSessionId) });
      }
    };
    await opening;
  }
  retry(): void { void this.retryAction?.(); }
  async download(): Promise<void> {
    const generation = this.generation;
    try { await this.downloadAction?.(); }
    catch { if (generation === this.generation) this.state.update(state => ({ ...state, error: "Download unavailable. Retry from the attachment in the conversation." })); }
  }
  private async open(title: string, read: (signal: AbortSignal) => Promise<{filename: string; bytes: Uint8Array}>): Promise<void> {
    this.close(); this.previousFocus = document.activeElement as HTMLElement;
    const generation = this.generation;
    const abort = new AbortController(); this.abort = abort;
    this.state.set({ ...empty(), open: true, busy: true, title, rootTitle: title });
    this.deadline(30000);
    try {
      const features = await firstValueFrom(this.api.attachmentFeatures());
      if (generation !== this.generation) return;
      if (!features.textPreview && !features.archivePreview && !features.pdfPreview && !features.imagePreview) throw Error("Attachment previews are paused. Downloads remain available.");
      const content = await read(abort.signal);
      if (generation !== this.generation) return;
      if (content.bytes.length > 25 * 1024 * 1024) throw Error("Preview limit is 25 MB. Download this file instead.");
      this.worker = new Worker(new URL("attachment-preview-worker.js", document.baseURI), { type: "module" });
      this.worker.onmessage = event => {
        if (generation !== this.generation) return;
        if (this.timer) clearTimeout(this.timer);
        this.state.update(state => ({ ...state, ...event.data, ...(event.data.error ? { bytes: null, kind: "unsupported", typeLabel: "Preview unavailable" } : {}), busy: false }));
      };
      this.worker.onerror = () => { if (generation === this.generation) this.failure("Preview unavailable. Download this file instead."); };
      this.state.update(state => ({ ...state, size: content.bytes.length }));
      this.deadline();
      this.worker.postMessage({ bytes: content.bytes, filename: content.filename, features }, [content.bytes.buffer as ArrayBuffer]);
    } catch (error) { if (generation === this.generation) this.failure(error instanceof Error ? error.message : "Preview failed."); }
  }
  entry(entry: PreviewEntry): void {
    if (!this.worker || entry.directory || this.state().busy) return;
    this.state.update(state => ({ ...state, busy: true, title: entry.name, size: entry.size, typeLabel: "Detecting type…", kind: "", bytes: null, truncated: false, text: "", error: "" }));
    this.deadline(); this.worker.postMessage({ entryId: entry.id });
  }
  private deadline(ms = 5000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.failure("Preview resource limit reached. Download the file instead."), ms);
  }
  private failure(error: string): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort(); this.worker?.terminate(); this.worker = null;
    this.state.update(state => ({ ...state, busy: false, bytes: null, kind: "unsupported", typeLabel: "Preview unavailable", error }));
  }
}
