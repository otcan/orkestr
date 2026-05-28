import { DatePipe } from "@angular/common";
import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { Agent, AgentTemplate, ApiService, BrowserSession, ConnectorStatus, EventRecord, OrkestrUser, SetupStatus, TimerDoctorResponse, TimerRecord, VersionResponse } from "./api.service";

export type ToolsView = "system" | "timers" | "desktops" | "models" | "settings" | "connectors" | "users";

@Component({
  selector: "ork-ops-page",
  imports: [DatePipe, FormsModule],
  templateUrl: "./ops-page.component.html",
})
export class OpsPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;

  @Input() toolsView: ToolsView = "system";
  @Output() toolsViewChange = new EventEmitter<ToolsView>();

  busy = false;
  activeBrowserActionSlug = "";
  error = "";
  notice = "";
  opsSetup: SetupStatus | null = null;
  opsVersion: VersionResponse | null = null;
  opsWhatsApp: Record<string, unknown> | null = null;
  opsRuntimeBudget: Record<string, unknown> | null = null;
  opsConnectors: ConnectorStatus[] = [];
  opsAgents: Agent[] = [];
  opsAgentTemplates: AgentTemplate[] = [];
  opsTimers: TimerRecord[] = [];
  opsTimerDoctor: TimerDoctorResponse | null = null;
  opsEvents: EventRecord[] = [];
  opsBrowsers: BrowserSession[] = [];
  opsBrowsersLoading = false;
  opsBrowsersLoaded = false;
  opsBrowserSource = "";
  opsBrowserMessage = "";
  opsRuntimeLeases: Array<Record<string, unknown>> = [];
  opsExecutors: Array<Record<string, unknown>> = [];
  opsExecutions: Array<Record<string, unknown>> = [];
  opsSystem: Record<string, unknown> | null = null;
  opsProcesses: Array<Record<string, unknown>> = [];
  opsModels: Record<string, unknown> | null = null;
  opsUsers: OrkestrUser[] = [];
  selectedUserId = "";
  userDraftId = "";
  userDraftDisplayName = "";
  userDraftRole = "user";
  savingUser = false;
  pairingUserId = "";
  userEditDraft: Record<string, { displayName: string; role: string; status: string; maxThreads: string }> = {};

  ngOnInit(): void {
    void this.loadOps();
    this.poller = setInterval(() => void this.loadOps(false), 30_000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  setToolsView(view: ToolsView): void {
    this.toolsView = view;
    this.toolsViewChange.emit(view);
  }

  async loadOps(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    this.opsBrowsersLoading = true;
    if (!this.opsBrowsers.length) this.opsBrowserMessage = "";
    const browsersRequest = firstValueFrom(this.api.browserSessions());
    browsersRequest
      .then((payload) => this.applyBrowserSessions(payload))
      .catch((error) => this.applyBrowserSessionsError(error))
      .finally(() => {
        this.opsBrowsersLoading = false;
        this.opsBrowsersLoaded = true;
        this.renderNow();
      });
    try {
      const [version, setup, whatsapp, agents, templates, timers, timerDoctor, events, browsers, runtimeLeases, executors, executions, system, processes, models, users] = await Promise.allSettled([
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.agents()),
        firstValueFrom(this.api.agentTemplates()),
        firstValueFrom(this.api.timers()),
        firstValueFrom(this.api.timerDoctor()),
        firstValueFrom(this.api.events(40)),
        browsersRequest,
        firstValueFrom(this.api.runtimeLeases()),
        firstValueFrom(this.api.executors()),
        firstValueFrom(this.api.executions()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.systemProcesses("cpu")),
        firstValueFrom(this.api.modelStatus()),
        firstValueFrom(this.api.users()),
      ]);
      if (version.status === "fulfilled") this.opsVersion = version.value;
      if (setup.status === "fulfilled") {
        this.opsSetup = setup.value;
        this.opsConnectors = setup.value.connectors || [];
      }
      if (whatsapp.status === "fulfilled") this.opsWhatsApp = whatsapp.value;
      if (agents.status === "fulfilled") this.opsAgents = agents.value.agents || [];
      if (templates.status === "fulfilled") this.opsAgentTemplates = templates.value.templates || [];
      if (timers.status === "fulfilled") this.opsTimers = timers.value.timers || [];
      if (timerDoctor.status === "fulfilled") this.opsTimerDoctor = timerDoctor.value;
      if (events.status === "fulfilled") this.opsEvents = events.value.events || [];
      if (browsers.status === "fulfilled") {
        this.applyBrowserSessions(browsers.value);
      } else {
        this.applyBrowserSessionsError(browsers.reason);
      }
      if (runtimeLeases.status === "fulfilled") {
        this.opsRuntimeLeases = runtimeLeases.value.leases || [];
        this.opsRuntimeBudget = runtimeLeases.value.budget || null;
      }
      if (executors.status === "fulfilled") this.opsExecutors = executors.value.executors || [];
      if (executions.status === "fulfilled") this.opsExecutions = executions.value.executions || [];
      if (system.status === "fulfilled") this.opsSystem = system.value;
      if (processes.status === "fulfilled") this.opsProcesses = processes.value.processes || [];
      if (models.status === "fulfilled") this.opsModels = models.value;
      if (users.status === "fulfilled") this.applyUsers(users.value.users || []);
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  selectUser(user: OrkestrUser): void {
    this.selectedUserId = user.id;
    this.ensureUserDraft(user);
  }

  selectedUser(): OrkestrUser | null {
    return this.opsUsers.find((user) => user.id === this.selectedUserId) || this.opsUsers[0] || null;
  }

  userDraft(user: OrkestrUser): { displayName: string; role: string; status: string; maxThreads: string } {
    return this.ensureUserDraft(user);
  }

  async createUser(): Promise<void> {
    if (this.savingUser) return;
    this.savingUser = true;
    try {
      const payload = {
        id: this.userDraftId.trim(),
        displayName: this.userDraftDisplayName.trim() || this.userDraftId.trim(),
        role: this.userDraftRole,
      };
      const result = await firstValueFrom(this.api.createUser(payload));
      this.userDraftId = "";
      this.userDraftDisplayName = "";
      this.userDraftRole = "user";
      await this.loadOps(false);
      if (result.user?.id) this.selectedUserId = result.user.id;
      this.error = "";
      this.notice = "User created.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingUser = false;
      this.renderNow();
    }
  }

  async saveUser(user: OrkestrUser): Promise<void> {
    const draft = this.ensureUserDraft(user);
    if (this.savingUser) return;
    this.savingUser = true;
    try {
      const maxThreads = draft.maxThreads.trim() === "" ? null : Number(draft.maxThreads);
      await firstValueFrom(this.api.updateUser(user.id, {
        displayName: draft.displayName,
        role: draft.role,
        status: draft.status,
        limits: { maxThreads },
      }));
      await this.loadOps(false);
      this.selectedUserId = user.id;
      this.error = "";
      this.notice = "User saved.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingUser = false;
      this.renderNow();
    }
  }

  async toggleUserStatus(user: OrkestrUser): Promise<void> {
    if (this.savingUser) return;
    this.savingUser = true;
    try {
      if (user.status === "disabled") await firstValueFrom(this.api.enableUser(user.id));
      else await firstValueFrom(this.api.disableUser(user.id));
      await this.loadOps(false);
      this.selectedUserId = user.id;
      this.error = "";
      this.notice = user.status === "disabled" ? "User enabled." : "User disabled.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingUser = false;
      this.renderNow();
    }
  }

  async createUserPairingChallenge(user: OrkestrUser): Promise<void> {
    if (this.pairingUserId) return;
    this.pairingUserId = user.id;
    try {
      const result = await firstValueFrom(this.api.createSecurityChallengeForUser(user.id));
      this.error = "";
      this.notice = `Pairing challenge for ${user.displayName || user.id}: ${result.challengeId}`;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.pairingUserId = "";
      this.renderNow();
    }
  }

  async browserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart" | "cleanup"): Promise<void> {
    const slug = this.browserSlug(browser);
    if (!slug) return;
    if (this.browserActionBusy(browser)) return;
    this.activeBrowserActionSlug = slug;
    try {
      await firstValueFrom(this.api.browserAction(slug, action));
      await this.loadOps(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeBrowserActionSlug = "";
      this.renderNow();
    }
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
    return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
  }

  formatPercent(value: unknown): string {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return "--";
    return `${Math.round(percent)}%`;
  }

  numberValue(value: unknown, key: string): number {
    if (!value || typeof value !== "object") return 0;
    const parsed = Number((value as Record<string, unknown>)[key]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  numberPath(value: unknown, path: string): number {
    const raw = this.pathValue(value, path);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  objectPath(value: unknown, path: string): string {
    const raw = this.pathValue(value, path);
    if (raw === null || raw === undefined) return "";
    return String(raw);
  }

  objectValue(value: unknown, key: string): string {
    if (!value || typeof value !== "object") return "";
    return String((value as Record<string, unknown>)[key] || "");
  }

  browserSlug(browser: BrowserSession): string {
    return String(browser.slug || browser.id || "").trim();
  }

  browserLabel(browser: BrowserSession): string {
    return String(browser.label || browser.slug || browser.id || "Desktop").trim();
  }

  browserSummary(browser: BrowserSession): string {
    return String(browser.notes || browser.purpose || browser.url || "Local browser desktop").trim();
  }

  browserProfile(browser: BrowserSession): string {
    return String(browser.profile_path || browser.profileDir || browser.profile || "").trim();
  }

  browserStatus(browser: BrowserSession): string {
    return String(browser.status || browser.state || "unknown").trim();
  }

  browserType(browser: BrowserSession): string {
    return String(browser.type || browser.access || "desktop").trim();
  }

  browserPid(browser: BrowserSession): string {
    return browser.root_pid ? String(browser.root_pid) : "";
  }

  browserCdpLabel(browser: BrowserSession): string {
    if (!browser.cdp_url) return "";
    return browser.cdp_ok === false ? "CDP down" : "CDP ready";
  }

  browserOpenUrl(browser: BrowserSession): string {
    if (this.browserStatus(browser) !== "running") return "";
    return String(browser.desk_url || browser.url || "").trim();
  }

  browserActionBusy(browser: BrowserSession): boolean {
    const slug = this.browserSlug(browser);
    return !!slug && this.activeBrowserActionSlug === slug;
  }

  canBrowserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart" | "cleanup"): boolean {
    if (!browser.control) {
      if (action === "prepare" || action === "start") return true;
      if (action === "restart") return !!browser.configured;
      if (action === "stop") return this.browserStatus(browser) === "running";
      if (action === "cleanup") return !!browser.configured && this.browserStatus(browser) !== "running";
    }
    return browser.control?.[action] === true;
  }

  systemCpuPercent(): number {
    return this.numberPath(this.opsSystem, "cpu.percent") || this.numberPath(this.opsSystem, "cpuPercent");
  }

  systemMemoryPercent(): number {
    return this.numberPath(this.opsSystem, "memory.percent");
  }

  systemLoadLabel(): string {
    const load = this.numberPath(this.opsSystem, "loadAverage.one");
    return Number.isFinite(load) ? `${Math.round(load * 10) / 10}` : "--";
  }

  runtimeLeasePercent(): number {
    const max = Number(this.objectValue(this.opsRuntimeBudget, "maxLiveThreads")) || 20;
    return Math.max(0, Math.min(100, (this.opsRuntimeLeases.length / max) * 100));
  }

  jsonLine(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value || "");
    }
  }

  userIdentityLabel(user: OrkestrUser): string {
    const identities = user.linkedIdentities || [];
    if (!identities.length) return "No linked identities";
    return identities.map((identity) => {
      const provider = String(identity.provider || "identity").toUpperCase();
      const external = identity.displayName || identity.externalId || identity.accountId || "";
      return external ? `${provider}: ${external}` : provider;
    }).join(", ");
  }

  userLimitLabel(user: OrkestrUser): string {
    const maxThreads = user.limits?.maxThreads;
    if (maxThreads === null || maxThreads === undefined) return "Unlimited threads";
    return `${maxThreads} thread${maxThreads === 1 ? "" : "s"}`;
  }

  userThreadCount(user: OrkestrUser): number {
    return Number(user.resourceSummary?.threadCount || 0);
  }

  userTimerCount(user: OrkestrUser): number {
    return Number(user.resourceSummary?.timerCount || 0);
  }

  userStatusClass(user: OrkestrUser): string {
    return user.status === "disabled" ? "bad" : "ready";
  }

  eventKey(event: EventRecord): string {
    return `${event.ts || ""}:${event.type}:${this.jsonLine(event).slice(0, 120)}`;
  }

  private pathValue(value: unknown, path: string): unknown {
    let current = value;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private applyBrowserSessions(payload: { sessions?: BrowserSession[]; browsers?: BrowserSession[]; source?: string; error?: string; message?: string }): void {
    this.opsBrowsers = payload.sessions || payload.browsers || [];
    this.opsBrowserSource = payload.source || "";
    this.opsBrowserMessage = payload.message || payload.error || "";
    this.opsBrowsersLoaded = true;
  }

  private applyUsers(users: OrkestrUser[]): void {
    this.opsUsers = users;
    if (!this.selectedUserId || !users.some((user) => user.id === this.selectedUserId)) {
      this.selectedUserId = users[0]?.id || "";
    }
    for (const user of users) this.ensureUserDraft(user);
  }

  private ensureUserDraft(user: OrkestrUser): { displayName: string; role: string; status: string; maxThreads: string } {
    const existing = this.userEditDraft[user.id];
    if (existing) return existing;
    const maxThreads = user.limits?.maxThreads;
    const draft = {
      displayName: user.displayName || user.id,
      role: user.role || "user",
      status: user.status || "active",
      maxThreads: maxThreads === null || maxThreads === undefined ? "" : String(maxThreads),
    };
    this.userEditDraft[user.id] = draft;
    return draft;
  }

  private applyBrowserSessionsError(error: unknown): void {
    this.opsBrowsers = [];
    this.opsBrowserSource = this.opsBrowserSource || "browserctl";
    this.opsBrowserMessage = this.errorText(error);
    this.opsBrowsersLoaded = true;
  }

  private renderNow(): void {
    try {
      this.cdr.detectChanges();
    } catch {
      // The component may have been destroyed while a slow browserctl request was in flight.
    }
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
