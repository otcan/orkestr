import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, BrowserSession, DesktopLeaseRecord, ThreadSummary } from "./api.service";

@Component({
  selector: "ork-user-desk-page",
  imports: [DatePipe],
  templateUrl: "./user-desk-page.component.html",
})
export class UserDeskPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  activeSlug = "";
  error = "";
  notice = "";
  shareUrl = "";
  browsers: BrowserSession[] = [];
  leases: DesktopLeaseRecord[] = [];
  threads: ThreadSummary[] = [];

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [browsers, leases, threads] = await Promise.all([
        firstValueFrom(this.api.browserSessions()),
        firstValueFrom(this.api.desktopLeases()),
        firstValueFrom(this.api.threads()),
      ]);
      this.browsers = browsers.sessions || browsers.browsers || [];
      this.leases = leases.desktopLeases || [];
      this.threads = threads.threads || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async browserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart"): Promise<void> {
    const slug = this.browserSlug(browser);
    if (!slug || this.busy) return;
    this.busy = true;
    this.activeSlug = slug;
    try {
      const payload = await firstValueFrom(this.api.browserAction(slug, action, { reason: "user_desk" }));
      this.browsers = this.upsertBrowser(payload.browser || browser);
      const label = { prepare: "prepared", start: "started", stop: "stopped", restart: "restarted" }[action];
      this.notice = `${this.browserLabel(payload.browser || browser)} ${label}.`;
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeSlug = "";
      this.busy = false;
    }
  }

  async acquireDesk(browser: BrowserSession): Promise<void> {
    const slug = this.browserSlug(browser);
    const thread = this.primaryThread();
    if (!slug || !thread || this.busy) return;
    this.busy = true;
    this.activeSlug = slug;
    try {
      const payload = await firstValueFrom(this.api.acquireDesktopLease(slug, {
        threadId: thread.id,
        threadName: thread.name || thread.title || thread.id,
        mode: "exclusive",
        purpose: "user_desk",
      }));
      if (payload.lease) this.leases = this.upsertLease(payload.lease);
      this.notice = `${this.browserLabel(browser)} reserved.`;
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeSlug = "";
      this.busy = false;
    }
  }

  async releaseDesk(browser: BrowserSession): Promise<void> {
    const slug = this.browserSlug(browser);
    const lease = this.browserLease(browser);
    const threadId = String(lease?.threadId || this.primaryThread()?.id || "").trim();
    if (!slug || !threadId || this.busy) return;
    this.busy = true;
    this.activeSlug = slug;
    try {
      await firstValueFrom(this.api.releaseDesktopLease(slug, { threadId, reason: "user_released" }));
      this.leases = this.leases.filter((item) => this.leaseSlug(item) !== slug);
      this.notice = `${this.browserLabel(browser)} released.`;
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeSlug = "";
      this.busy = false;
    }
  }

  async shareDesktop(browser: BrowserSession): Promise<void> {
    const slug = this.browserSlug(browser);
    if (!slug || this.busy) return;
    this.busy = true;
    this.activeSlug = slug;
    try {
      const payload = await firstValueFrom(this.api.createDesktopShare(slug));
      this.shareUrl = payload.url || "";
      this.notice = this.shareUrl ? "Share link ready." : "Share requested.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeSlug = "";
      this.busy = false;
    }
  }

  primaryThread(): ThreadSummary | null {
    return this.threads[0] || null;
  }

  browserSlug(browser: BrowserSession): string {
    return String(browser.slug || browser.id || "").trim();
  }

  browserLabel(browser: BrowserSession): string {
    return String(browser.label || browser.slug || browser.id || "Desk").trim();
  }

  browserSummary(browser: BrowserSession): string {
    return String(browser.notes || browser.purpose || browser.url || "Browser desk").trim();
  }

  browserStatus(browser: BrowserSession): string {
    return String(browser.status || browser.state || "unknown").trim();
  }

  browserRunning(browser: BrowserSession): boolean {
    return ["active", "running"].includes(this.browserStatus(browser));
  }

  browserConfigured(browser: BrowserSession): boolean {
    return browser.configured === true || Boolean(browser.preparedAt);
  }

  browserOpenUrl(browser: BrowserSession): string {
    if (!this.browserRunning(browser)) return "";
    const slug = this.browserSlug(browser);
    if (!slug) return "";
    return `/desktop/${encodeURIComponent(slug)}/vnc.html?autoconnect=1&resize=scale&path=desktop/${encodeURIComponent(slug)}/websockify`;
  }

  browserLease(browser: BrowserSession): DesktopLeaseRecord | null {
    const embedded = browser.lease && typeof browser.lease === "object" ? browser.lease as DesktopLeaseRecord : null;
    if (embedded?.desktopSlug || embedded?.threadId) return embedded;
    const slug = this.browserSlug(browser);
    return this.leases.find((lease) => this.leaseSlug(lease) === slug) || null;
  }

  leaseLabel(lease: DesktopLeaseRecord | null): string {
    if (!lease) return "Available";
    return String(lease.ownerThreadLabel || lease.threadName || lease.threadId || "Reserved").trim();
  }

  leaseClass(lease: DesktopLeaseRecord | null): string {
    if (!lease) return "ready";
    if (lease.stale || lease.expired) return "bad";
    return "live";
  }

  actionBusy(browser: BrowserSession): boolean {
    return this.busy && (!this.activeSlug || this.activeSlug === this.browserSlug(browser));
  }

  canPrepare(browser: BrowserSession): boolean {
    return !this.browserRunning(browser) && !this.browserConfigured(browser);
  }

  canStart(browser: BrowserSession): boolean {
    return !this.browserRunning(browser);
  }

  private leaseSlug(lease: DesktopLeaseRecord): string {
    return String(lease.desktopSlug || "").trim();
  }

  private upsertBrowser(browser: BrowserSession): BrowserSession[] {
    const slug = this.browserSlug(browser);
    return [...this.browsers.filter((item) => this.browserSlug(item) !== slug), browser]
      .sort((left, right) => this.browserLabel(left).localeCompare(this.browserLabel(right)));
  }

  private upsertLease(lease: DesktopLeaseRecord): DesktopLeaseRecord[] {
    const slug = this.leaseSlug(lease);
    return [...this.leases.filter((item) => this.leaseSlug(item) !== slug), lease];
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown; status?: unknown; statusText?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
      if (record.status) return `HTTP ${record.status}${record.statusText ? ` ${record.statusText}` : ""}`;
    }
    return String(error || "Unknown error");
  }
}
