import { AfterViewChecked, Component, ElementRef, HostListener, ViewChild, inject, signal } from "@angular/core";
import { AttachmentPreviewService } from "./attachment-preview.service";

@Component({
  selector: "ork-attachment-preview",
  template: `@if (preview.state(); as state) { @if (state.open) {
    <aside #panel class="attachment-panel" [attr.role]="mobile ? 'dialog' : 'complementary'" [attr.aria-modal]="mobile ? 'true' : null" aria-labelledby="attachment-preview-title" tabindex="-1">
      <header><h2 id="attachment-preview-title">{{ state.title }}</h2><button type="button" (click)="preview.close()" aria-label="Close attachment preview">Back / Close</button></header>
      <p aria-live="polite">{{ state.busy ? 'Loading preview…' : '' }}</p>
      @if (state.error) { <p role="alert">{{ state.error }}</p> }
      @if (state.archive) {
        <nav aria-label="Archive contents">
          @for (entry of state.entries; track entry.id) {
            <button type="button" [disabled]="entry.directory || state.busy" (click)="preview.entry(entry)">{{ entry.name }} <small>{{ entry.size }} bytes</small></button>
          }
        </nav>
      }
      @if (state.truncated) { <p>Showing the first 256 KB. Download for the full content.</p> }
      <pre tabindex="0"><code>{{ state.text }}</code></pre>
    </aside>
  } }`,
  styleUrl: "./attachment-panel.css",
})
export class AttachmentPreviewComponent implements AfterViewChecked {
  readonly preview = inject(AttachmentPreviewService);
  @ViewChild("panel") panel?: ElementRef<HTMLElement>;
  private focused = false;
  private readonly mobileViewport = signal(globalThis.innerWidth <= 860);
  get mobile(): boolean { return this.mobileViewport(); }
  @HostListener("window:resize")
  resize(): void { this.mobileViewport.set(globalThis.innerWidth <= 860); }
  ngAfterViewChecked(): void {
    if (this.panel && !this.focused) { this.panel.nativeElement.focus(); this.focused = true; }
    if (!this.panel) this.focused = false;
  }
  @HostListener("document:keydown", ["$event"])
  key(event: KeyboardEvent): void {
    if (!this.panel) return;
    if (event.key === "Escape") { event.preventDefault(); this.preview.close(); }
    if (event.key !== "Tab" || !this.mobile) return;
    const items = [...this.panel.nativeElement.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")];
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && current <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && (current === items.length - 1 || current < 0)) { event.preventDefault(); items[0]?.focus(); }
  }
}
