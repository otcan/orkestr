import { Component, ElementRef, EventEmitter, Input, Output, ViewChild, inject, signal } from "@angular/core";
import { AttachmentPreviewService } from "./attachment-preview.service";
import { ApiService } from "./api.service";
import { firstValueFrom } from "rxjs";
import { FormsModule } from "@angular/forms";
import { ThreadSummary } from "./api.service";
import { PendingFile } from "./thread-uploads";
import { shouldSubmitComposer } from "./composer-keyboard";

@Component({
  selector: "ork-thread-composer",
  imports: [FormsModule],
  templateUrl: "./thread-composer.component.html",
  styleUrl: "./thread-composer-attachments.css",
})
export class ThreadComposerComponent {
  readonly preview = inject(AttachmentPreviewService);
  pasteOpen = false;
  pasteName = "note.txt";
  pasteText = "";
  pasteError = "";
  readonly pasteEnabled = signal(false);
  constructor() {
    void firstValueFrom(inject(ApiService).attachmentFeatures()).then(features => { this.pasteEnabled.set(features.pastedAttachments); }).catch(() => {});
  }
  @Input() thread: ThreadSummary | null = null;
  @Input() draft = "";
  @Input() pendingFiles: PendingFile[] = [];
  @Input() sending = false;
  @Input() sendingNow = false;
  @Input() implementingPlan = false;
  @Input() inputReady = true;
  @Input() adminMode = false;
  @Input() slashHelpOpen = false;
  @Input() showPlanBanner = false;
  @Input() planReady = false;
  @Input() planHint = "";
  @Input() placeholder = "Message";
  @Input() rows = 2;
  @Input() replyToWhatsAppAvailable = false;
  @Input() replyToWhatsApp = true;

  @Output() draftChange = new EventEmitter<string>();
  @Output() queueFiles = new EventEmitter<FileList | File[] | null>();
  @Output() retryFile = new EventEmitter<string>();
  @Output() removeFile = new EventEmitter<string>();
  @Output() send = new EventEmitter<void>();
  @Output() sendNow = new EventEmitter<void>();
  @Output() openHelp = new EventEmitter<void>();
  @Output() replyToWhatsAppChange = new EventEmitter<boolean>();

  @ViewChild("composerInput") private readonly composerInput?: ElementRef<HTMLTextAreaElement>;

  draggingUpload = false;

  focusEnd(): void {
    this.composerInput?.nativeElement.focus();
    const value = this.composerInput?.nativeElement.value || "";
    this.composerInput?.nativeElement.setSelectionRange(value.length, value.length);
  }

  submit(): void {
    if (this.sendDisabled()) return;
    this.send.emit();
  }

  submitNow(): void {
    if (this.sendDisabled()) return;
    this.sendNow.emit();
  }

  handleDraftChange(value: string): void {
    this.draft = value;
    this.draftChange.emit(value);
  }

  handleReplyToWhatsAppChange(value: boolean): void {
    this.replyToWhatsApp = value;
    this.replyToWhatsAppChange.emit(value);
  }

  handleKeydown(event: KeyboardEvent): void {
    if (!shouldSubmitComposer(event, globalThis.matchMedia?.("(pointer: coarse)").matches === true)) return;
    event.preventDefault();
    this.submit();
  }

  handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  handleDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = true;
  }

  handleDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = false;
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = false;
    this.queueFiles.emit(event.dataTransfer?.files || null);
  }

  sendDisabled(): boolean {
    return this.sending || this.sendingNow || this.implementingPlan || !this.inputReady || this.pendingFiles.some(file => file.uploadState !== "ready") || (!this.draft.trim() && this.pendingFiles.length === 0);
  }

  addPaste(): void {
    if (!this.pasteEnabled()) return;
    const name = this.pasteName.trim();
    if (!name || name.length > 240 || /[\\/\x00-\x1f]/.test(name)) { this.pasteError = "Enter a filename without directory separators."; return; }
    const file = new File([this.pasteText], name, { type: "text/plain;charset=utf-8" });
    if (!file.size || file.size > 1024 * 1024) { this.pasteError = "Paste between 1 byte and 1 MB of text."; return; }
    this.queueFiles.emit([file]); this.pasteOpen = false; this.pasteText = ""; this.pasteError = "";
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
    return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
  }
}
