import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild, signal } from "@angular/core";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker, RenderTask } from "pdfjs-dist";
import { assertPreviewPageCount, previewCanvasScale } from "../../public/attachment-visual-limits.js";

// Canvas only: no PDF scripting manager, annotation links, HTML or native plugin.
@Component({
  selector: "ork-attachment-visual-preview",
  template: `
    <div class="controls" aria-label="Preview controls">
      @if (kind === 'pdf') {
        <button type="button" (click)="turn(-1)" [disabled]="busy() || page() <= 1" aria-label="Previous page">‹</button>
        <span aria-live="polite">Page {{ page() }} / {{ pages() }}</span>
        <button type="button" (click)="turn(1)" [disabled]="busy() || page() >= pages()" aria-label="Next page">›</button>
      }
      <button type="button" (click)="scale(0.8)" [disabled]="busy() || zoom() <= 0.5" aria-label="Zoom out">−</button>
      <button type="button" (click)="fit()" [disabled]="busy()">Fit width</button>
      <button type="button" (click)="scale(1.25)" [disabled]="busy() || zoom() >= 4" aria-label="Zoom in">+</button>
    </div>
    @if (busy()) { <p role="status">Rendering preview…</p> }
    @if (error()) { <p role="alert">{{ error() }} Download the file instead.</p> }
    <div #viewport class="viewport" tabindex="0" aria-label="Document preview">
      <canvas #canvas role="img" [attr.aria-label]="kind === 'pdf' ? 'PDF page ' + page() : 'Image preview'"></canvas>
    </div>`,
  styles: `:host{display:block;min-width:0}.controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center}button{min-width:44px;min-height:44px}.viewport{overflow:auto;max-height:75dvh;touch-action:pan-x pan-y pinch-zoom}canvas{display:block;background:white}`,
})
export class AttachmentVisualPreviewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) bytes!: Uint8Array;
  @Input() kind = "pdf";
  @Input() mediaType = "application/pdf";
  @ViewChild("canvas") canvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild("viewport") viewport!: ElementRef<HTMLElement>;
  readonly busy = signal(true); readonly error = signal("");
  readonly page = signal(1); readonly pages = signal(0); readonly zoom = signal(1);
  private loading: PDFDocumentLoadingTask | null = null;
  private pdfWorker: PDFWorker | null = null;
  private port: Worker | null = null;
  private pdf: PDFDocumentProxy | null = null;
  private task: RenderTask | null = null;
  private bitmap: ImageBitmap | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private observer: ResizeObserver | null = null;
  private width = 0;
  private rendering = false;
  private renderPending = false;
  ngAfterViewInit(): void {
    this.observer = new ResizeObserver(() => {
      const width = this.viewport.nativeElement.clientWidth;
      if (width === this.width) return;
      this.width = width;
      if (!this.error()) void this.render();
    });
    this.observer.observe(this.viewport.nativeElement); void this.open();
  }
  ngOnChanges(): void { if (this.canvas) void this.open(); }
  ngOnDestroy(): void { this.observer?.disconnect(); this.dispose(); }
  turn(delta: number): void { if (!this.busy()) { this.page.set(Math.max(1, Math.min(this.pages(), this.page() + delta))); void this.render(); } }
  scale(factor: number): void { if (!this.busy()) { this.zoom.set(Math.max(0.5, Math.min(4, this.zoom() * factor))); void this.render(); } }
  fit(): void { if (!this.busy()) { this.zoom.set(1); void this.render(); } }
  private dispose(): void {
    this.generation++;
    this.rendering = false; this.renderPending = false;
    if (this.timer) clearTimeout(this.timer);
    this.task?.cancel(); this.task = null;
    if (this.loading) void this.loading.destroy().catch(() => {});
    this.loading = null; this.pdf = null;
    this.pdfWorker?.destroy(); this.pdfWorker = null;
    this.port?.terminate(); this.port = null;
    this.bitmap?.close(); this.bitmap = null;
    if (this.canvas) { this.canvas.nativeElement.width = 0; this.canvas.nativeElement.height = 0; }
  }
  private deadline(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("Preview resource limit reached."), 15000);
  }
  private fail(message: string): void { this.dispose(); this.error.set(message); this.busy.set(false); }
  private async open(): Promise<void> {
    this.dispose(); const generation = this.generation;
    this.busy.set(true); this.error.set(""); this.page.set(1); this.pages.set(0); this.zoom.set(1); this.deadline();
    try {
      if (this.bytes.length > 25 * 1024 * 1024) throw Error("size");
      if (this.kind === "pdf") {
        const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (generation !== this.generation) return;
        const base = new URL("pdfjs/", document.baseURI).href;
        lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
        // Supplying a real port prevents PDF.js's main-thread fake-worker fallback.
        this.port = new Worker(lib.GlobalWorkerOptions.workerSrc, { type: "module" });
        this.port.onerror = () => { if (generation === this.generation) this.fail("PDF worker unavailable."); };
        this.pdfWorker = lib.PDFWorker.create({ port: this.port });
        const loading = lib.getDocument({ data: this.bytes.slice(), worker: this.pdfWorker, enableXfa: false,
          maxImageSize: 8_000_000, canvasMaxAreaInBytes: 32_000_000, useSystemFonts: false,
          cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`, stopAtErrors: true, verbosity: 0 });
        this.loading = loading;
        const pdf = await loading.promise;
        if (generation !== this.generation) return;
        this.pdf = pdf;
        assertPreviewPageCount(pdf.numPages);
        this.pages.set(pdf.numPages);
      } else {
        const bitmap = await createImageBitmap(new Blob([this.bytes.slice().buffer as ArrayBuffer], { type: this.mediaType }));
        if (generation !== this.generation) { bitmap.close(); return; }
        this.bitmap = bitmap;
        if (bitmap.width * bitmap.height > 8_000_000) throw Error("pixels");
      }
      await this.render();
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error && error.name === "PasswordException" ? "Password-protected PDFs cannot be previewed." : "This file is corrupt, unsupported, or exceeds the preview limits.");
    }
  }
  private async render(): Promise<void> {
    if (!this.pdf && !this.bitmap) return;
    // Rotation/keyboard viewport changes can arrive while PDF.js owns the
    // canvas. Coalesce them, then draw once at the latest width.
    if (this.rendering) { this.renderPending = true; return; }
    this.rendering = true;
    const generation = this.generation;
    this.busy.set(true); this.deadline();
    try {
      const page = this.pdf ? await this.pdf.getPage(this.page()) : null;
      if (generation !== this.generation) return;
      const original = page?.getViewport({ scale: 1 }) || this.bitmap!;
      const scale = previewCanvasScale(original.width, original.height, Math.max(1, this.viewport.nativeElement.clientWidth), this.zoom());
      const canvas = this.canvas.nativeElement;
      canvas.width = Math.max(1, Math.floor(original.width * scale)); canvas.height = Math.max(1, Math.floor(original.height * scale));
      if (page) {
        const task = page.render({ canvas, viewport: page.getViewport({ scale }), annotationMode: 0 });
        this.task = task;
        task.onContinue = (next: () => void) => setTimeout(() => { if (generation === this.generation) next(); }, 0);
        await task.promise;
        if (generation !== this.generation) return;
        this.task = null; page.cleanup();
      } else canvas.getContext("2d")!.drawImage(this.bitmap!, 0, 0, canvas.width, canvas.height);
      if (this.timer) clearTimeout(this.timer);
      if (!this.renderPending) this.busy.set(false);
    } catch { if (generation === this.generation) this.fail("Unable to render this preview."); }
    finally {
      if (generation === this.generation) {
        this.rendering = false;
        if (this.renderPending) { this.renderPending = false; void this.render(); }
      }
    }
  }
}
