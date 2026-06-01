import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ThreadSummary } from "./api.service";
import { PendingFile } from "./thread-uploads";

@Component({
  selector: "ork-thread-composer",
  imports: [FormsModule],
  templateUrl: "./thread-composer.component.html",
})
export class ThreadComposerComponent {
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

  @Output() draftChange = new EventEmitter<string>();
  @Output() queueFiles = new EventEmitter<FileList | null>();
  @Output() removeFile = new EventEmitter<string>();
  @Output() send = new EventEmitter<void>();
  @Output() sendNow = new EventEmitter<void>();
  @Output() openHelp = new EventEmitter<void>();

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

  handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
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
    return this.sending || this.sendingNow || this.implementingPlan || !this.inputReady || (!this.draft.trim() && this.pendingFiles.length === 0);
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
