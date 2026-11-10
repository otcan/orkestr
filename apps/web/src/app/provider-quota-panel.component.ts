import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from "@angular/core";
import { Subscription } from "rxjs";
import { ApiService } from "./api.service";
import {
  ProviderQuotaEntry,
  ProviderQuotaSnapshot,
  QuotaProvider,
  QuotaState,
  executorLabel,
  quotaCountdownLabel,
  quotaFreshnessLabel,
  quotaPercentLabel,
  quotaState,
  quotaStateLabel,
} from "./provider-quota";

const refreshMs = 60_000;

// Host-page view of remaining Claude and Codex subscription quota. It reuses
// the owner-scoped /api/quota/providers telemetry (the same source the
// WhatsApp reply footer reads) and never synthesizes numbers: absent or stale
// readings render as an explicit "No data" state instead of a fake 0%/100%.
@Component({
  selector: "ork-provider-quota-panel",
  standalone: true,
  template: `
    <section class="card provider-quota-panel" aria-label="Claude and Codex quota">
      <div class="row-between">
        <div>
          <p class="eyebrow">Executors</p>
          <h3>Remaining quota</h3>
          <p class="subline">Live Claude and Codex subscription usage for this host.</p>
        </div>
        <button class="secondary" type="button" (click)="load()" [disabled]="busy">Reload</button>
      </div>

      @if (error && !snapshot) {
        <p class="notice error" role="status">Quota telemetry is unavailable. Retrying automatically.</p>
      }

      <div class="quota-grid">
        @for (provider of providers; track provider) {
          <article class="quota-card" [attr.data-state]="state(provider)">
            <header>
              <b>{{ label(provider) }}</b>
              <span class="quota-state-pill" [attr.data-state]="state(provider)">{{ stateLabel(provider) }}</span>
            </header>

            @if (state(provider) === "unknown") {
              <p class="quota-empty">
                @if (entry(provider)?.stale) {
                  Last reading is stale ({{ freshness(provider) }}); showing no current estimate.
                } @else {
                  No usage has been observed yet for this executor.
                }
              </p>
            } @else {
              <dl class="quota-windows">
                <div>
                  <dt>5h remaining</dt>
                  <dd>
                    {{ percent(provider, 'fiveHour') }}
                    @if (countdown(provider, 'fiveHour'); as left) { <small>resets in {{ left }}</small> }
                  </dd>
                </div>
                <div>
                  <dt>Weekly remaining</dt>
                  <dd>
                    {{ percent(provider, 'weekly') }}
                    @if (countdown(provider, 'weekly'); as left) { <small>resets in {{ left }}</small> }
                  </dd>
                </div>
              </dl>
              @if (state(provider) === "limited") {
                <p class="quota-note">At the subscription cap right now.</p>
              }
            }

            <footer class="quota-fresh" [class.stale]="entry(provider)?.stale">
              Updated {{ freshness(provider) }}@if (entry(provider)?.stale) { · stale }
            </footer>
          </article>
        }
      </div>
    </section>
  `,
  styles: [`
    .provider-quota-panel { display: grid; gap: 14px; }
    .quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .quota-card { border: 1px solid var(--line, #d0d5dd); border-radius: 12px; padding: 14px; display: grid; gap: 10px; align-content: start; }
    .quota-card[data-state="limited"] { border-color: #b42318; }
    .quota-card[data-state="unknown"] { border-style: dashed; opacity: .9; }
    .quota-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .quota-card header b { font-size: 15px; }
    .quota-state-pill { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
    .quota-state-pill[data-state="normal"] { color: #067647; }
    .quota-state-pill[data-state="limited"] { color: #b42318; }
    .quota-state-pill[data-state="unknown"] { color: #667085; }
    .quota-windows { display: grid; gap: 8px; margin: 0; }
    .quota-windows div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .quota-windows dt { margin: 0; color: var(--muted, #475467); font-size: 13px; }
    .quota-windows dd { margin: 0; font-weight: 600; text-align: right; }
    .quota-windows dd small { display: block; font-weight: 400; font-size: 11px; color: var(--muted, #667085); }
    .quota-empty { margin: 0; color: var(--muted, #667085); font-size: 13px; }
    .quota-note { margin: 0; color: #b42318; font-size: 12px; }
    .quota-fresh { font-size: 11px; color: var(--muted, #667085); }
    .quota-fresh.stale { color: #b54708; }
  `],
})
export class ProviderQuotaPanelComponent implements OnInit, OnDestroy {
  readonly providers: QuotaProvider[] = ["claude", "codex"];
  snapshot: ProviderQuotaSnapshot | null = null;
  busy = false;
  error = "";
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
    this.busy = true;
    this.request = this.api.providerQuota().subscribe({
      next: (response) => {
        this.snapshot = response?.quota || null;
        this.error = "";
        this.busy = false;
        this.detector.markForCheck();
      },
      // Unknown stays unknown: keep the previous snapshot on failure rather
      // than blanking the view or guessing a value.
      error: () => {
        this.error = "quota_unavailable";
        this.busy = false;
        this.detector.markForCheck();
      },
    });
  }

  entry(provider: QuotaProvider): ProviderQuotaEntry | null {
    return this.snapshot?.[provider] || null;
  }

  label(provider: QuotaProvider): string {
    return executorLabel(provider);
  }

  state(provider: QuotaProvider): QuotaState {
    return quotaState(this.entry(provider));
  }

  stateLabel(provider: QuotaProvider): string {
    return quotaStateLabel(this.state(provider));
  }

  percent(provider: QuotaProvider, period: "fiveHour" | "weekly"): string {
    const entry = this.entry(provider);
    return period === "fiveHour"
      ? quotaPercentLabel(entry?.fiveHourRemainingPct, entry?.fiveHourStatus)
      : quotaPercentLabel(entry?.weeklyRemainingPct, entry?.weeklyStatus);
  }

  countdown(provider: QuotaProvider, period: "fiveHour" | "weekly"): string {
    const entry = this.entry(provider);
    return quotaCountdownLabel(period === "fiveHour" ? entry?.fiveHourResetsAt : entry?.weeklyResetsAt);
  }

  freshness(provider: QuotaProvider): string {
    return quotaFreshnessLabel(this.entry(provider));
  }
}
