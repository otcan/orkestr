import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, Output, inject } from "@angular/core";
import { Subscription } from "rxjs";
import { ApiService, ThreadExecutorSummary } from "./api.service";
import { QuotaProvider, executorLabel } from "./provider-quota";

// One thread, one active executor: switch it in place between Codex and Claude.
// A busy thread switches after its current turn unless the owner forces "now".
@Component({
  selector: "ork-executor-switcher",
  standalone: true,
  template: `
    <span class="executor-switcher" role="group" aria-label="Thread agent">
      @for (provider of providers; track provider) {
        <button
          type="button"
          class="executor-switcher-option"
          [class.active]="provider === activeProvider"
          [class.pending]="provider === pendingProvider"
          [disabled]="busy || !threadId || provider === activeProvider"
          [attr.aria-pressed]="provider === activeProvider"
          [title]="optionTitle(provider)"
          (click)="switchTo(provider)"
        >{{ label(provider) }}</button>
      }
      @if (pendingProvider) { <em class="executor-switcher-note">→ {{ label(pendingProvider) }} after turn</em> }
      @if (error) { <em class="executor-switcher-error" role="alert">{{ error }}</em> }
    </span>
  `,
  styles: [`
    .executor-switcher { display: inline-flex; gap: 2px; align-items: center; min-width: 0; }
    .executor-switcher-option { padding: 1px 8px; border: 1px solid var(--line, #d0d5dd); background: transparent; font-size: 12px; line-height: 18px; cursor: pointer; }
    .executor-switcher-option:first-of-type { border-radius: 999px 0 0 999px; }
    .executor-switcher-option:last-of-type { border-radius: 0 999px 999px 0; }
    .executor-switcher-option.active { border-color: currentColor; font-weight: 600; cursor: default; }
    .executor-switcher-option.pending { border-style: dashed; }
    .executor-switcher-option:disabled:not(.active) { opacity: .5; cursor: default; }
    .executor-switcher-note, .executor-switcher-error { font-style: normal; font-size: 11px; margin-left: 6px; opacity: .8; }
    .executor-switcher-error { color: #b42318; opacity: 1; }
  `],
})
export class ExecutorSwitcherComponent implements OnChanges, OnDestroy {
  @Input() threadId = "";
  @Input() activeProvider: QuotaProvider | "" = "";
  @Input() working = false;
  @Output() switched = new EventEmitter<ThreadExecutorSummary>();
  readonly providers: QuotaProvider[] = ["codex", "claude"];
  pendingProvider: QuotaProvider | "" = "";
  busy = false;
  error = "";
  private readonly api = inject(ApiService);
  private readonly detector = inject(ChangeDetectorRef);
  private request?: Subscription;

  ngOnChanges(): void {
    this.error = "";
    this.loadPending();
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }

  label(provider: QuotaProvider): string {
    return executorLabel(provider);
  }

  optionTitle(provider: QuotaProvider): string {
    if (provider === this.activeProvider) return `${this.label(provider)} is the active agent for this thread`;
    return this.working
      ? `Switch this thread to ${this.label(provider)} after the current turn (/${provider})`
      : `Switch this thread to ${this.label(provider)} (/${provider})`;
  }

  switchTo(provider: QuotaProvider): void {
    if (!this.threadId || provider === this.activeProvider || this.busy) return;
    this.busy = true;
    this.error = "";
    this.request?.unsubscribe();
    const executor = provider === "claude" ? "claude-code" : "codex";
    this.request = this.api.setThreadExecutor(this.threadId, { executor, when: this.working ? "after_turn" : "now", reason: "web UI switch" }).subscribe({
      next: (response) => {
        this.busy = false;
        this.pendingProvider = pendingTarget(response?.executor);
        this.switched.emit(response?.executor);
        this.detector.markForCheck();
      },
      error: (failure) => {
        this.busy = false;
        this.error = String(failure?.error?.message || failure?.error?.error || failure?.message || "Switch failed");
        this.detector.markForCheck();
      },
    });
  }

  private loadPending(): void {
    this.pendingProvider = "";
    if (!this.threadId) return;
    this.request?.unsubscribe();
    this.request = this.api.threadExecutor(this.threadId).subscribe({
      next: (response) => {
        this.pendingProvider = pendingTarget(response?.executor);
        this.detector.markForCheck();
      },
      error: () => this.detector.markForCheck(),
    });
  }
}

function pendingTarget(summary?: ThreadExecutorSummary | null): QuotaProvider | "" {
  const target = String(summary?.pendingExecutorSwitch?.target || "");
  if (target === "claude-code" || target === "claude") return "claude";
  if (target === "codex") return "codex";
  return "";
}
