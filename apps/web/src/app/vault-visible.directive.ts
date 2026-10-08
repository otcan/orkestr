import { Directive, ElementRef, EventEmitter, OnDestroy, OnInit, Output, inject } from "@angular/core";

// Emits true while the host element intersects the viewport. Without
// IntersectionObserver every row counts as visible.
@Directive({ selector: "[orkVaultVisible]" })
export class VaultVisibleDirective implements OnInit, OnDestroy {
  private readonly host = inject(ElementRef);
  private observer: IntersectionObserver | null = null;
  @Output() readonly orkVaultVisible = new EventEmitter<boolean>();

  ngOnInit(): void {
    const Observer = globalThis.IntersectionObserver;
    if (typeof Observer !== "function") {
      this.orkVaultVisible.emit(true);
      return;
    }
    this.observer = new Observer((entries) => {
      for (const entry of entries) this.orkVaultVisible.emit(entry.isIntersecting);
    });
    this.observer.observe(this.host.nativeElement as Element);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.orkVaultVisible.emit(false);
  }
}
