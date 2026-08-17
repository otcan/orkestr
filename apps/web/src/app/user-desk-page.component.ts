import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { ApiService, BrowserSession, DesktopAccessWarning, DesktopLeaseRecord, ThreadSummary } from "./api.service";

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
  actionWarnings: Record<string, DesktopAccessWarning[]> = {};

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const threads = await firstValueFrom(this.api.threads().pipe(timeout({ first: 15_000 })));
      this.threads = threads.threads || [];
      const threadId = this.primaryThread()?.id || "";
      const [browsers, leases] = await Promise.all([
        firstValueFrom(this.api.browserSessions(threadId).pipe(timeout({ first: 15_000 }))),
        firstValueFrom(this.api.desktopLeases(false, threadId).pipe(timeout({ first: 15_000 }))),
      ]);
      this.browsers = browsers.sessions || browsers.browsers || [];
      this.leases = leases.desktopLeases || [];
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
    const attemptId = globalThis.crypto?.randomUUID?.() || `desktop-action-${Date.now()}`;
    try {
      let lease = this.browserLease(browser);
      let recoveryWarnings: DesktopAccessWarning[] = [];
      if (action !== "stop" && (!lease || lease.stale || lease.expired)) {
        const thread = this.primaryThread();
        if (!thread) throw new Error("A thread is required to reserve this desktop.");
        const acquired = await firstValueFrom(this.api.acquireDesktopLease(slug, {
          threadId: thread.id,
          threadName: thread.name || thread.title || thread.id,
          mode: "exclusive",
          purpose: "user_desk_action",
          attemptId,
        }));
        lease = acquired.lease || null;
        recoveryWarnings = acquired.warnings || [];
      }
      const payload = await firstValueFrom(this.api.browserAction(slug, action, {
        threadId: String(lease?.threadId || this.primaryThread()?.id || ""),
        fencingToken: String(lease?.fencingToken || ""),
        reason: "user_desk",
        attemptId,
      }));
      this.actionWarnings[slug] = this.mergeWarnings(recoveryWarnings, payload.warnings || []);
      this.browsers = this.upsertBrowser(payload.browser || browser);
      const label = { prepare: "prepared", start: "started", stop: "stopped", restart: "restarted" }[action];
      this.notice = `${this.browserLabel(payload.browser || browser)} ${label}.`;
      this.error = "";
      await this.load();
    } catch (error) {
      this.captureErrorWarnings(slug, error);
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
      this.actionWarnings[slug] = payload.warnings || [];
      if (payload.lease) this.leases = this.upsertLease(payload.lease);
      this.notice = payload.autoRecovered
        ? `${this.browserLabel(browser)} recovered from its expired reservation and reserved.`
        : `${this.browserLabel(browser)} reserved.`;
      this.error = "";
      await this.load();
    } catch (error) {
      this.captureErrorWarnings(slug, error);
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
      await firstValueFrom(this.api.releaseDesktopLease(slug, { threadId, fencingToken: lease?.fencingToken, reason: "user_released" }));
      this.actionWarnings[slug] = [];
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
      const lease = this.browserLease(browser);
      const payload = await firstValueFrom(this.api.createDesktopShare(slug, {
        threadId: String(lease?.threadId || this.primaryThread()?.id || ""),
        fencingToken: String(lease?.fencingToken || ""),
        start: false,
      }));
      this.actionWarnings[slug] = payload.warnings || [];
      this.shareUrl = payload.url || "";
      this.notice = this.shareUrl ? "Share link ready." : "Share requested.";
      this.error = "";
    } catch (error) {
      this.captureErrorWarnings(slug, error);
      this.error = this.errorText(error);
    } finally {
      this.activeSlug = "";
      this.busy = false;
    }
  }

  async openDesktop(browser: BrowserSession): Promise<void> {
    const slug = this.browserSlug(browser);
    const threadId = String(this.browserLease(browser)?.threadId || this.primaryThread()?.id || "").trim();
    if (!slug || !threadId || !this.browserRunning(browser) || this.busy) return;
    const pendingWindow = window.open("about:blank", "_blank");
    if (pendingWindow) {
      try {
        pendingWindow.opener = null;
      } catch {
        // Some browsers block assigning opener on a newly opened tab.
      }
    }
    this.busy = true;
    this.activeSlug = slug;
    try {
      const lease = this.browserLease(browser);
      const payload = await firstValueFrom(this.api.createDesktopShare(slug, {
        threadId,
        fencingToken: String(lease?.fencingToken || ""),
        start: false,
      }));
      this.actionWarnings[slug] = payload.warnings || [];
      if (!payload.url) throw new Error("Desktop share did not return a URL.");
      if (pendingWindow) pendingWindow.location.href = payload.url;
      else window.location.assign(payload.url);
      this.error = "";
    } catch (error) {
      pendingWindow?.close();
      this.captureErrorWarnings(slug, error);
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

  runningCount(): number {
    return this.browsers.filter((browser) => this.browserRunning(browser)).length;
  }

  availableCount(): number {
    return this.browsers.filter((browser) => !this.browserLease(browser)).length;
  }

  attentionCount(): number {
    return this.browsers.filter((browser) => {
      const lease = this.browserLease(browser);
      return Boolean(browser.launchError) || Boolean(lease?.stale || lease?.expired) || this.browserWarnings(browser).length > 0;
    }).length;
  }

  browserWarnings(browser: BrowserSession): DesktopAccessWarning[] {
    const slug = this.browserSlug(browser);
    const embedded = Array.isArray(browser.warnings) ? browser.warnings : [];
    const attempted = Array.isArray(this.actionWarnings[slug]) ? this.actionWarnings[slug] : [];
    const unique = new Map<string, DesktopAccessWarning>();
    for (const warning of [...embedded, ...attempted]) unique.set(warning.code, warning);
    return [...unique.values()];
  }

  warningTitle(warning: DesktopAccessWarning): string {
    return String(warning.code || "desktop_warning").replace(/^desktop_/, "").replaceAll("_", " ");
  }

  browserHealthLabel(browser: BrowserSession): string {
    if (browser.launchError) return "Needs attention";
    if (this.browserRunning(browser)) return "Ready";
    if (this.browserConfigured(browser)) return "Stopped";
    return "Not prepared";
  }

  browserHealthClass(browser: BrowserSession): string {
    if (browser.launchError) return "bad";
    if (this.browserRunning(browser)) return "live";
    return "ready";
  }

  browserThreads(browser: BrowserSession): Array<Record<string, unknown>> {
    return Array.isArray(browser.relatedThreads) ? browser.relatedThreads : [];
  }

  browserThreadLabel(thread: Record<string, unknown>): string {
    return String(thread["title"] || thread["name"] || thread["bindingName"] || thread["id"] || "Thread").trim();
  }

  browserLastActivity(browser: BrowserSession): string {
    return String(browser.lastOpenedAt || browser.preparedAt || browser.stoppedAt || "").trim();
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

  private captureErrorWarnings(slug: string, error: unknown): void {
    if (!error || typeof error !== "object") return;
    const response = (error as { error?: unknown }).error;
    if (!response || typeof response !== "object") return;
    const warnings = (response as { warnings?: unknown }).warnings;
    if (Array.isArray(warnings)) this.actionWarnings[slug] = warnings as DesktopAccessWarning[];
  }

  private mergeWarnings(...groups: DesktopAccessWarning[][]): DesktopAccessWarning[] {
    return [...new Map(groups.flat().map((warning) => [warning.code, warning])).values()];
  }
}
