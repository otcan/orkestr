import { DatePipe, NgTemplateOutlet } from "@angular/common";
import { Component, Input, OnChanges, OnInit, inject } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { ApiService, BrowserSession, DesktopAccessWarning, DesktopLeaseRecord, ThreadSummary } from "./api.service";

// Plain-language text for the desktop errors owners actually hit; the code
// stays visible for support.
const desktopErrorMessages: Record<string, string> = {
  desktop_grant_required: "The selected thread has no access to this desktop. Open it from the thread it is assigned to.",
  desktop_thread_scope_required: "Select a thread before opening this desktop.",
  desktop_lookup_timeout: "The desktop did not answer in time. Try again in a moment.",
  desktop_not_running: "This desktop is not running. Start it first.",
  browser_session_not_found: "This desktop no longer exists. Refresh the list.",
  lease_owned_by_other_thread: "Another thread has reserved this desktop.",
};

// Lists longer than this get a search box.
const searchThreshold = 8;
const attentionStatuses = ["failed", "partial", "error"];

export interface DeskGroups {
  main: BrowserSession[];
  other: BrowserSession[];
  attention: BrowserSession[];
}

@Component({
  selector: "ork-user-desk-page",
  imports: [DatePipe, NgTemplateOutlet],
  templateUrl: "./user-desk-page.component.html",
  styleUrl: "./user-desk-page.component.css",
})
export class UserDeskPageComponent implements OnInit, OnChanges {
  private readonly api = inject(ApiService);

  busy = false;
  activeSlug = "";
  error = "";
  notice = "";
  shareUrl = "";
  inventoryUnavailable = false;
  reservationsUnavailable = true;
  private loadedThreadId: string | null = null;
  private loadGeneration = 0;
  private initialized = false;
  browsers: BrowserSession[] = [];
  leases: DesktopLeaseRecord[] = [];
  @Input() threads: ThreadSummary[] = [];
  @Input() selectedThread: ThreadSummary | null = null;
  actionWarnings: Record<string, DesktopAccessWarning[]> = {};
  query = "";
  menuSlug = "";

  ngOnInit(): void {
    this.initialized = true;
    void this.load();
  }

  ngOnChanges(): void {
    if (this.initialized && this.loadedThreadId !== (this.primaryThread()?.id || "")) void this.load();
  }

  async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    const threadId = this.primaryThread()?.id || "";
    if (this.loadedThreadId !== threadId) {
      this.browsers = [];
      this.leases = [];
      this.shareUrl = "";
      this.actionWarnings = {};
      this.menuSlug = "";
      this.loadedThreadId = threadId;
    }
    this.busy = true;
    this.error = "";
    this.reservationsUnavailable = true;
    if (!threadId) {
      this.busy = false;
      return;
    }
    try {
      const [browsersResult, leasesResult] = await Promise.allSettled([
        // Inventory includes bounded browser probes plus scoped policy/lease
        // projection. Allow that complete response, not just the probe budget.
        firstValueFrom(this.api.browserSessions(threadId).pipe(timeout({ first: 15_000 }))),
        firstValueFrom(this.api.desktopLeases(false, threadId).pipe(timeout({ first: 7_000 }))),
      ]);
      if (generation !== this.loadGeneration || threadId !== (this.primaryThread()?.id || "")) return;
      const errors: string[] = [];
      if (browsersResult.status === "fulfilled" && browsersResult.value.ok !== false) {
        this.inventoryUnavailable = false;
        this.browsers = browsersResult.value.sessions || browsersResult.value.browsers || [];
      } else {
        this.browsers = [];
        this.inventoryUnavailable = true;
        errors.push("Desktop inventory is unavailable. Refresh to try again.");
      }
      if (leasesResult.status === "fulfilled" && leasesResult.value.ok !== false) {
        this.leases = leasesResult.value.desktopLeases || [];
        this.reservationsUnavailable = false;
      } else {
        // Keep the same-thread snapshot for context, never as action authority.
        errors.push("Desktop reservations could not be loaded. Refresh to try again.");
      }
      this.error = errors.join(" ");
    } finally {
      if (generation === this.loadGeneration) this.busy = false;
    }
  }

  async browserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart"): Promise<void> {
    const slug = this.browserSlug(browser);
    if (!slug || this.actionBusy(browser)) return;
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
      const threadId = String(lease?.threadId || this.primaryThread()?.id || "");
      const fencingToken = String(lease?.fencingToken || "");
      const issued = await firstValueFrom(this.api.issueDesktopCapability(threadId, {
        fencingToken,
        scope: "lifecycle",
      }));
      const payload = await firstValueFrom(this.api.browserAction(slug, action, {
        threadId,
        fencingToken,
        desktopCapability: issued.capability,
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
    if (!slug || !thread || this.actionBusy(browser)) return;
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
    if (!slug || !threadId || this.actionBusy(browser)) return;
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
    if (!slug || this.actionBusy(browser)) return;
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
    if (!slug || !threadId || !this.browserRunning(browser) || this.actionBusy(browser)) return;
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
      const payload = await firstValueFrom(this.api.openDesktopSession(slug, {
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
    return this.selectedThread || this.threads[0] || null;
  }

  browserSlug(browser: BrowserSession): string {
    return String(browser.slug || browser.id || "").trim();
  }

  browserLabel(browser: BrowserSession): string {
    return String(browser.label || browser.slug || browser.id || "Desk").trim();
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

  availableCount(): number | null {
    if (this.reservationsUnavailable) return null;
    return this.browsers.filter((browser) => !this.browserLease(browser)).length;
  }

  searchVisible(): boolean {
    return this.browsers.length > searchThreshold;
  }

  setQuery(value: string): void {
    this.query = String(value || "");
  }

  toggleMenu(browser: BrowserSession): void {
    const slug = this.browserSlug(browser);
    this.menuSlug = this.menuSlug === slug ? "" : slug;
  }

  menuOpen(browser: BrowserSession): boolean {
    return Boolean(this.menuSlug) && this.menuSlug === this.browserSlug(browser);
  }

  // Failed, partial, launch-disabled, or never-prepared desktops cannot be
  // used as-is; running desktops always stay in the main list.
  needsAttention(browser: BrowserSession): boolean {
    if (this.browserRunning(browser)) return false;
    return Boolean(browser.launchError) || browser.launchDisabled === true
      || attentionStatuses.includes(this.browserStatus(browser))
      || !(browser.managed === true || this.browserConfigured(browser));
  }

  // Display grouping only; the server still authorizes every action. Without a
  // per-thread access projection, every desktop is treated as openable.
  threadCanOpen(browser: BrowserSession): boolean {
    const access = browser.desktopAccess;
    if (!access || typeof access !== "object") return true;
    return access.allowed !== false && access.granted !== false && access.inventoryOnly !== true;
  }

  deskGroups(): DeskGroups {
    const groups: DeskGroups = { main: [], other: [], attention: [] };
    const query = this.searchVisible() ? this.query.trim().toLowerCase() : "";
    const sorted = [...this.browsers].sort((left, right) =>
      Number(this.browserRunning(right)) - Number(this.browserRunning(left))
      || this.browserLabel(left).localeCompare(this.browserLabel(right)));
    for (const browser of sorted) {
      if (query && !`${this.browserLabel(browser)} ${this.browserSlug(browser)}`.toLowerCase().includes(query)) continue;
      if (this.needsAttention(browser)) groups.attention.push(browser);
      else if (!this.threadCanOpen(browser)) groups.other.push(browser);
      else groups.main.push(browser);
    }
    return groups;
  }

  rowMessage(browser: BrowserSession): string {
    if (browser.launchError) return String(browser.launchError);
    const warnings = this.browserWarnings(browser);
    if (!warnings.length) return "";
    const first = String(warnings[0].message || this.warningTitle(warnings[0]));
    return warnings.length > 1 ? `${first} (+${warnings.length - 1} more)` : first;
  }

  rowMessageIsError(browser: BrowserSession): boolean {
    return Boolean(browser.launchError) || this.browserWarnings(browser).some((warning) => warning.severity === "error");
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
    if (this.browserRunning(browser)) return "Running";
    if (browser.launchError || attentionStatuses.includes(this.browserStatus(browser))) return "Failed";
    if (browser.launchDisabled === true) return "Launch disabled";
    if (browser.managed === true || this.browserConfigured(browser)) return "Stopped";
    return "Not prepared";
  }

  browserHealthClass(browser: BrowserSession): string {
    if (this.browserRunning(browser)) return "live";
    if (this.needsAttention(browser)) return "bad";
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
    if (this.reservationsUnavailable) return "Reservation status unknown";
    if (!lease) return "Available";
    return String(lease.ownerThreadLabel || lease.threadName || lease.threadId || "Reserved").trim();
  }

  actionBusy(browser: BrowserSession): boolean {
    return this.busy || this.inventoryUnavailable || this.reservationsUnavailable
      || this.loadedThreadId !== (this.primaryThread()?.id || "");
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
        const code = String(detail || "");
        if (code) return desktopErrorMessages[code] ? `${desktopErrorMessages[code]} (${code})` : code;
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
