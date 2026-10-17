import { DatePipe } from "@angular/common";
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { ApiService } from "./api.service";

@Component({
  selector: "ork-system-resources",
  imports: [DatePipe],
  templateUrl: "./system-resources.component.html",
  styleUrl: "./system-resources.component.css",
})
export class SystemResourcesComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;
  summary: Record<string, unknown> | null = null;
  busy = false;
  error = "";
  processes: Array<Record<string, unknown>> = [];
  processesOpen = false;
  processesBusy = false;
  processesError = "";

  ngOnInit(): void {
    void this.refresh();
    this.poller = setInterval(() => {
      if (globalThis.document?.visibilityState !== "hidden") void this.refresh();
    }, 15_000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.poller) clearInterval(this.poller);
  }

  async refresh(): Promise<void> {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    try {
      this.summary = await firstValueFrom(this.api.systemSummary().pipe(timeout(10_000)));
      this.error = "";
    } catch {
      this.error = this.summary ? "Refresh failed. Showing the last sample; retrying automatically." : "System readings are unavailable. Retrying automatically.";
    } finally {
      this.busy = false;
      if (!this.destroyed) this.cdr.markForCheck();
    }
    if (this.processesOpen) void this.loadProcesses();
  }

  toggleProcesses(): void {
    this.processesOpen = !this.processesOpen;
    if (this.processesOpen) void this.loadProcesses();
  }

  async loadProcesses(): Promise<void> {
    if (this.processesBusy || this.destroyed) return;
    this.processesBusy = true;
    try {
      const response = await firstValueFrom(this.api.systemProcesses().pipe(timeout(10_000)));
      this.processes = response.processes || [];
      this.processesError = "";
    } catch {
      this.processesError = "Process readings are unavailable.";
    } finally {
      this.processesBusy = false;
      if (!this.destroyed) this.cdr.markForCheck();
    }
  }

  value(path: string): unknown {
    return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, this.summary);
  }

  number(path: string): number | null {
    const value = this.value(path);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  percent(path: string): string {
    const value = this.number(path);
    return value === null ? "—" : `${value.toFixed(1)}%`;
  }

  bytes(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)) - 1);
    return `${(value / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`;
  }

  sampledAt(): string {
    return String(this.summary?.["generatedAt"] || "");
  }
}
