import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, inject } from "@angular/core";
import { Subscription } from "rxjs";
import { ApiService } from "./api.service";
import {
  ProviderQuotaEntry,
  ProviderQuotaSnapshot,
  QuotaProvider,
  executorLabel,
  quotaPercentLabel,
  quotaTone,
  quotaTooltip,
} from "./provider-quota";

const refreshMs = 60_000;

@Component({
  selector: "ork-provider-quota-indicator",
  standalone: true,
  template: `
    <span class="provider-quota" role="status" aria-label="Remaining Codex and Claude quota">
      @for (provider of providers; track provider) {
        <span
          class="provider-quota-chip"
          [class.active]="provider === activeProvider"
          [class.stale]="entry(provider)?.stale"
          [attr.data-tone]="tone(provider)"
          [title]="tooltip(provider)"
        >
          <b>{{ label(provider) }}</b>
          <span>5h {{ percent(provider, 'fiveHour') }}</span>
          <span>wk {{ percent(provider, 'weekly') }}</span>
          @if (entry(provider)?.stale) { <em>stale</em> }
          @if (entry(provider)?.limited) { <em>limited</em> }
        </span>
      }
    </span>
  `,
  styles: [`
    .provider-quota { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
    .provider-quota-chip { display: inline-flex; gap: 6px; align-items: baseline; padding: 2px 8px; border: 1px solid var(--line, #d0d5dd); border-radius: 999px; font-size: 12px; line-height: 18px; white-space: nowrap; opacity: .85; }
    .provider-quota-chip.active { opacity: 1; border-color: currentColor; }
    .provider-quota-chip.stale span { opacity: .6; }
    .provider-quota-chip[data-tone="warn"] { color: #b54708; }
    .provider-quota-chip[data-tone="danger"] { color: #b42318; }
    .provider-quota-chip em { font-style: normal; font-size: 11px; text-transform: uppercase; opacity: .75; }
  `],
})
export class ProviderQuotaIndicatorComponent implements OnInit, OnDestroy {
  @Input() activeProvider: QuotaProvider | "" = "";
  readonly providers: QuotaProvider[] = ["codex", "claude"];
  snapshot: ProviderQuotaSnapshot | null = null;
  private readonly api = inject(ApiService);
  private readonly detector = inject(ChangeDetectorRef);
  private request?: Subscription;
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), refreshMs);
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }

  load(): void {
    this.request?.unsubscribe();
    this.request = this.api.providerQuota().subscribe({
      next: (response) => {
        this.snapshot = response?.quota || null;
        this.detector.markForCheck();
      },
      // Unknown stays unknown: keep the previous snapshot (or "?") on failure.
      error: () => this.detector.markForCheck(),
    });
  }

  entry(provider: QuotaProvider): ProviderQuotaEntry | null {
    return this.snapshot?.[provider] || null;
  }

  label(provider: QuotaProvider): string {
    return executorLabel(provider);
  }

  percent(provider: QuotaProvider, period: "fiveHour" | "weekly"): string {
    const entry = this.entry(provider);
    return period === "fiveHour"
      ? quotaPercentLabel(entry?.fiveHourRemainingPct, entry?.fiveHourStatus)
      : quotaPercentLabel(entry?.weeklyRemainingPct, entry?.weeklyStatus);
  }

  tone(provider: QuotaProvider): string {
    return quotaTone(this.entry(provider));
  }

  tooltip(provider: QuotaProvider): string {
    const switchHint = this.activeProvider && provider !== this.activeProvider ? `\nSwitch this thread with /${provider}` : "";
    return quotaTooltip(provider, this.entry(provider)) + switchHint;
  }
}
