import { Component, Input } from "@angular/core";

// Uses the shell's existing system sample; no additional request or poller.
@Component({
  selector: "ork-thread-system-usage",
  template: `
    <span class="usage" role="group" aria-label="Orkestr server resource usage" [title]="sampleTitle()">
      <span class="metric">CPU <strong>{{ cpu() }}</strong></span>
      <span class="metric">RAM <strong>{{ memory() }}</strong>
        @if (memoryAmount()) { <small>{{ memoryAmount() }}</small> }
      </span>
      @if (stale()) { <small class="stale">Last sample</small> }
    </span>
  `,
  styles: `
    :host { min-width: 0; max-width: 100%; }
    .usage { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
      padding: 6px 9px; border: 1px solid var(--ui-border, #344638); border-radius: 10px;
      color: var(--ui-muted, #a9b7ac); font-size: .72rem; }
    .metric { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 5px; }
    strong { color: var(--ui-text, #e0e8e2); font-variant-numeric: tabular-nums; }
    small { font-size: .7rem; }
    .stale { color: var(--ui-warning, #e8c779); }
  `,
})
export class ThreadSystemUsageComponent {
  @Input() summary: Record<string, unknown> | null = null;

  private number(path: string): number | null {
    const value = path.split(".").reduce<unknown>((current, key) =>
      current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, this.summary);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  private percent(value: number | null): string {
    return value === null || value > 100 ? "—" : `${value.toFixed(1)}%`;
  }

  cpu(): string {
    return this.percent(this.number("cpu.percent") ?? this.number("cpuPercent"));
  }

  memory(): string {
    return this.percent(this.number("memory.percent"));
  }

  memoryAmount(): string {
    const used = this.number("memory.used");
    const total = this.number("memory.total");
    if (used === null || total === null || total <= 0 || used > total) return "";
    return `${(used / 1024 ** 3).toFixed(1)} / ${(total / 1024 ** 3).toFixed(1)} GiB`;
  }

  stale(): boolean {
    if (!this.summary) return false;
    const time = Date.parse(String(this.summary["generatedAt"] || ""));
    return !Number.isFinite(time) || Date.now() - time > 90_000 || time > Date.now() + 60_000;
  }

  sampleTitle(): string {
    if (!this.summary) return "Orkestr server CPU and RAM readings are unavailable.";
    const time = Date.parse(String(this.summary["generatedAt"] || ""));
    const sampled = Number.isFinite(time) ? ` Sampled ${new Date(time).toLocaleString()}.` : " Sample time unavailable.";
    return `Orkestr server usage, not this browser or an individual agent.${sampled}${this.stale() ? " Showing the last sample." : ""}`;
  }
}
