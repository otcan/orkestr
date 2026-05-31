import { DatePipe } from "@angular/common";
import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { Agent, AgentTemplate, ApiService, BrowserSession, ConnectorStatus, DesktopLeaseRecord, EventRecord, OrkestrUser, OutlookOAuthPollResponse, SecurityChallenge, SecuritySession, SetupStatus, TimerDoctorResponse, TimerRecord, UserIdentity, UserOutlookOAuthStartResponse, VersionResponse } from "./api.service";

export type ToolsView = "system" | "timers" | "desktops" | "models" | "settings" | "connectors" | "users" | "audit";
type MailIdentityProvider = "gmail" | "outlook";

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
  opsDesktopLeases: DesktopLeaseRecord[] = [];
  activeDesktopLeaseId = "";
  opsRuntimeLeases: Array<Record<string, unknown>> = [];
  opsExecutors: Array<Record<string, unknown>> = [];
  opsExecutions: Array<Record<string, unknown>> = [];
  opsSystem: Record<string, unknown> | null = null;
  opsProcesses: Array<Record<string, unknown>> = [];
  opsModels: Record<string, unknown> | null = null;
  opsUsers: OrkestrUser[] = [];
  opsSecurityChallenges: SecurityChallenge[] = [];
  opsSecuritySessions: SecuritySession[] = [];
  opsUserIdentities: UserIdentity[] = [];
  opsUserIdentitiesUserId = "";
  selectedUserId = "";
  userDraftEmail = "";
  userDraftPhone = "";
  userDraftDisplayName = "";
  userDraftRole = "user";
  savingUser = false;
  pairingUserId = "";
  revokingSessionId = "";
  identityBusy = false;
  identityDraftAccountId = "";
  identityDraftExternalId = "";
  identityDraftChatId = "";
  identityDraftDisplayName = "";
  identityDraftMigrate = false;
  mailIdentityBusy = false;
  mailOauthBusy = false;
  mailIdentityProvider: MailIdentityProvider = "gmail";
  mailIdentityAccount = "";
  mailIdentityDisplayName = "";
  mailIdentityMigrate = false;
  mailOutlookDevice: UserOutlookOAuthStartResponse | OutlookOAuthPollResponse | null = null;
  auditUserFilter = "";
  auditResourceFilter = "";
  auditConnectorFilter = "";
  auditOutcomeFilter = "";
  userEditDraft: Record<string, { displayName: string; email: string; phoneNumber: string; role: string; status: string; maxThreads: string }> = {};

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
      const [version, setup, whatsapp, agents, templates, timers, timerDoctor, events, browsers, desktopLeases, runtimeLeases, executors, executions, system, processes, models, users, securityChallenges, securitySessions] = await Promise.allSettled([
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.agents()),
        firstValueFrom(this.api.agentTemplates()),
        firstValueFrom(this.api.timers()),
        firstValueFrom(this.api.timerDoctor()),
        firstValueFrom(this.api.events(120)),
        browsersRequest,
        firstValueFrom(this.api.desktopLeases()),
        firstValueFrom(this.api.runtimeLeases()),
        firstValueFrom(this.api.executors()),
        firstValueFrom(this.api.executions()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.systemProcesses("cpu")),
        firstValueFrom(this.api.modelStatus()),
        firstValueFrom(this.api.users()),
        firstValueFrom(this.api.securityChallenges()),
        firstValueFrom(this.api.securitySessions()),
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
      if (desktopLeases.status === "fulfilled") this.opsDesktopLeases = desktopLeases.value.desktopLeases || [];
      if (runtimeLeases.status === "fulfilled") {
        this.opsRuntimeLeases = runtimeLeases.value.leases || [];
        this.opsRuntimeBudget = runtimeLeases.value.budget || null;
      }
      if (executors.status === "fulfilled") this.opsExecutors = executors.value.executors || [];
      if (executions.status === "fulfilled") this.opsExecutions = executions.value.executions || [];
      if (system.status === "fulfilled") this.opsSystem = system.value;
      if (processes.status === "fulfilled") this.opsProcesses = processes.value.processes || [];
      if (models.status === "fulfilled") this.opsModels = models.value;
      if (users.status === "fulfilled") {
        this.applyUsers(users.value.users || []);
        await this.loadSelectedUserIdentities(false);
      }
      if (securityChallenges.status === "fulfilled") this.opsSecurityChallenges = securityChallenges.value.challenges || [];
      if (securitySessions.status === "fulfilled") this.opsSecuritySessions = securitySessions.value.sessions || [];
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
    void this.loadSelectedUserIdentities(false);
  }

  selectedUser(): OrkestrUser | null {
    return this.opsUsers.find((user) => user.id === this.selectedUserId) || this.opsUsers[0] || null;
  }

  userDraft(user: OrkestrUser): { displayName: string; email: string; phoneNumber: string; role: string; status: string; maxThreads: string } {
    return this.ensureUserDraft(user);
  }

  async createUser(): Promise<void> {
    if (this.savingUser) return;
    this.savingUser = true;
    try {
      const payload = {
        email: this.userDraftEmail.trim(),
        phoneNumber: this.userDraftPhone.trim(),
        displayName: this.userDraftDisplayName.trim() || this.userDraftEmail.trim(),
        role: this.userDraftRole,
      };
      const result = await firstValueFrom(this.api.createUser(payload));
      this.userDraftEmail = "";
      this.userDraftPhone = "";
      this.userDraftDisplayName = "";
      this.userDraftRole = "user";
      await this.loadOps(false);
      if (result.user?.id) this.selectedUserId = result.user.id;
      await this.loadSelectedUserIdentities(false);
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
        email: draft.email,
        phoneNumber: draft.phoneNumber,
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
      await this.loadOps(false);
      this.selectedUserId = user.id;
      this.error = "";
      this.notice = `Pairing challenge for ${user.displayName || user.id}: ${result.challengeId}. Approve with: orkestr security approve ${result.challengeId}`;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.pairingUserId = "";
      this.renderNow();
    }
  }

  async revokeUserSession(session: SecuritySession): Promise<void> {
    if (this.revokingSessionId) return;
    this.revokingSessionId = session.id;
    try {
      await firstValueFrom(this.api.revokeSecuritySession(session.id));
      await this.loadOps(false);
      this.error = "";
      this.notice = "Browser session revoked.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.revokingSessionId = "";
      this.renderNow();
    }
  }

  async loadSelectedUserIdentities(showBusy = true): Promise<void> {
    const user = this.selectedUser();
    if (!user?.id) {
      this.opsUserIdentities = [];
      this.opsUserIdentitiesUserId = "";
      return;
    }
    if (showBusy) this.identityBusy = true;
    try {
      const result = await firstValueFrom(this.api.userIdentities(user.id));
      this.opsUserIdentities = result.identities || [];
      this.opsUserIdentitiesUserId = user.id;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.identityBusy = false;
      this.renderNow();
    }
  }

  async linkWhatsAppIdentity(user: OrkestrUser): Promise<void> {
    if (this.identityBusy) return;
    this.identityBusy = true;
    try {
      const result = await firstValueFrom(this.api.linkWhatsAppIdentity(user.id, {
        accountId: this.identityDraftAccountId.trim(),
        externalId: this.identityDraftExternalId.trim(),
        chatId: this.identityDraftChatId.trim(),
        displayName: this.identityDraftDisplayName.trim(),
        migrate: this.identityDraftMigrate,
      }));
      this.opsUserIdentities = result.identities || [];
      this.opsUserIdentitiesUserId = user.id;
      this.identityDraftExternalId = "";
      this.identityDraftChatId = "";
      this.identityDraftDisplayName = "";
      this.identityDraftMigrate = false;
      this.error = "";
      this.notice = "WhatsApp identity linked.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.identityBusy = false;
      this.renderNow();
    }
  }

  async unlinkWhatsAppIdentity(user: OrkestrUser, identity: UserIdentity): Promise<void> {
    if (this.identityBusy) return;
    this.identityBusy = true;
    try {
      const result = await firstValueFrom(this.api.unlinkWhatsAppIdentity(user.id, {
        accountId: identity.accountId || "",
        externalId: identity.externalId || "",
        chatId: identity.chatId || "",
      }));
      this.opsUserIdentities = result.identities || [];
      this.opsUserIdentitiesUserId = user.id;
      this.error = "";
      this.notice = "WhatsApp identity detached.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.identityBusy = false;
      this.renderNow();
    }
  }

  async linkMailIdentity(user: OrkestrUser): Promise<void> {
    if (this.mailIdentityBusy) return;
    this.mailIdentityBusy = true;
    try {
      const result = await firstValueFrom(this.api.linkMailIdentity(user.id, this.mailIdentityProvider, {
        account: this.mailIdentityAccount.trim(),
        displayName: this.mailIdentityDisplayName.trim(),
        migrate: this.mailIdentityMigrate,
      }));
      this.opsUserIdentities = result.identities || [];
      this.opsUserIdentitiesUserId = user.id;
      this.mailIdentityAccount = "";
      this.mailIdentityDisplayName = "";
      this.mailIdentityMigrate = false;
      this.error = "";
      this.notice = "Mail account assigned.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.mailIdentityBusy = false;
      this.renderNow();
    }
  }

  async unlinkMailIdentity(user: OrkestrUser, identity: UserIdentity): Promise<void> {
    if (this.mailIdentityBusy) return;
    this.mailIdentityBusy = true;
    try {
      const result = await firstValueFrom(this.api.unlinkMailIdentity(user.id, identity.provider, {
        account: identity.externalId || identity.accountId || "",
      }));
      this.opsUserIdentities = result.identities || [];
      this.opsUserIdentitiesUserId = user.id;
      this.error = "";
      this.notice = "Mail account detached.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.mailIdentityBusy = false;
      this.renderNow();
    }
  }

  async startUserMailOAuth(user: OrkestrUser): Promise<void> {
    if (this.mailOauthBusy) return;
    this.mailOauthBusy = true;
    const body = {
      account: this.mailIdentityAccount.trim() || user.email || "",
      displayName: this.mailIdentityDisplayName.trim(),
      migrate: this.mailIdentityMigrate,
    };
    try {
      if (this.mailIdentityProvider === "gmail") {
        const result = await firstValueFrom(this.api.startUserGmailOAuth(user.id, body));
        if (result.identities) {
          this.opsUserIdentities = result.identities;
          this.opsUserIdentitiesUserId = user.id;
        }
        if (result.authorizeUrl) window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
        this.error = "";
        this.notice = "Gmail sign-in started.";
      } else {
        const result = await firstValueFrom(this.api.startUserOutlookOAuth(user.id, body));
        this.mailOutlookDevice = result;
        if (result.identities) {
          this.opsUserIdentities = result.identities;
          this.opsUserIdentitiesUserId = user.id;
        }
        this.openOutlookDevicePage(result);
        this.error = "";
        this.notice = "Outlook sign-in started.";
      }
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.mailOauthBusy = false;
      this.renderNow();
    }
  }

  async pollUserOutlookOAuth(): Promise<void> {
    const pendingId = String(this.mailOutlookDevice?.pendingId || "").trim();
    if (!pendingId || this.mailOauthBusy) return;
    this.mailOauthBusy = true;
    try {
      const result = await firstValueFrom(this.api.pollOutlookOAuth(pendingId));
      this.mailOutlookDevice = result;
      this.error = "";
      this.notice = result.state === "connected" ? "Outlook sign-in connected." : result.message || "Waiting for Outlook sign-in.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.mailOauthBusy = false;
      this.renderNow();
    }
  }

  openOutlookDevicePage(device: UserOutlookOAuthStartResponse | OutlookOAuthPollResponse | null = this.mailOutlookDevice): void {
    const url = String(device?.verificationUriComplete || device?.verificationUri || "").trim();
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
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

  async shareDesktop(browser: BrowserSession): Promise<void> {
    const slug = this.browserSlug(browser);
    if (!slug || this.browserActionBusy(browser)) return;
    this.activeBrowserActionSlug = slug;
    try {
      const result = await firstValueFrom(this.api.createDesktopShare(slug));
      if (navigator?.clipboard && result.url) {
        await navigator.clipboard.writeText(result.url).catch(() => undefined);
      }
      this.error = "";
      this.notice = result.url
        ? `Desktop share link copied: ${result.url}`
        : "Desktop share link created.";
      await this.loadOps(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeBrowserActionSlug = "";
      this.renderNow();
    }
  }

  async forceReleaseDesktopLease(lease: DesktopLeaseRecord): Promise<void> {
    const slug = String(lease.desktopSlug || "").trim();
    const ownerUserId = String(lease.ownerUserId || "").trim();
    const id = String(lease.id || `${slug}:${ownerUserId}`).trim();
    if (!slug || !ownerUserId || this.activeDesktopLeaseId) return;
    this.activeDesktopLeaseId = id;
    try {
      await firstValueFrom(this.api.releaseDesktopLease(slug, {
        force: true,
        ownerUserId,
        reason: "admin_force_released",
      }));
      this.error = "";
      this.notice = `${this.desktopLeaseLabel(lease)} released.`;
      await this.loadOps(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeDesktopLeaseId = "";
      this.renderNow();
    }
  }

  openBrowserDesktop(browser: BrowserSession): void {
    const url = this.browserOpenUrl(browser);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
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

  browserIsRunning(browser: BrowserSession): boolean {
    return ["active", "running"].includes(this.browserStatus(browser));
  }

  browserType(browser: BrowserSession): string {
    return String(browser.type || browser.access || "desktop").trim();
  }

  browserOwner(browser: BrowserSession): string {
    const scope = String(browser.scopeLabel || "").trim();
    const owner = String(browser.ownerUserId || "").trim();
    if (scope && owner) return `${scope} · ${owner}`;
    return scope || owner;
  }

  browserPid(browser: BrowserSession): string {
    return browser.root_pid ? String(browser.root_pid) : "";
  }

  browserCdpLabel(browser: BrowserSession): string {
    if (!browser.cdp_url) return "";
    return browser.cdp_ok === false ? "CDP down" : "CDP ready";
  }

  browserOpenUrl(browser: BrowserSession): string {
    if (!this.browserIsRunning(browser)) return "";
    const slug = this.browserSlug(browser);
    if (!slug) return "";
    if (!String(browser.desk_url || browser.url || "").trim() && this.browserType(browser) !== "desktop") return "";
    const encodedSlug = encodeURIComponent(slug);
    return `/desktop/${encodedSlug}/vnc.html?autoconnect=1&resize=scale&path=desktop/${encodedSlug}/websockify`;
  }

  desktopThreads(browser: BrowserSession): Array<Record<string, unknown>> {
    return Array.isArray(browser.relatedThreads) ? browser.relatedThreads : [];
  }

  desktopThreadLabel(thread: Record<string, unknown>): string {
    return String(thread["title"] || thread["name"] || thread["bindingName"] || thread["id"] || "Thread").trim();
  }

  desktopThreadState(thread: Record<string, unknown>): string {
    return String(thread["status"] || thread["state"] || "ready").trim();
  }

  desktopThreadHref(thread: Record<string, unknown>): string {
    const id = String(thread["id"] || thread["name"] || thread["bindingName"] || "").trim();
    return id ? `/thread/${encodeURIComponent(id)}` : "/ops/desktops";
  }

  desktopLeaseLabel(lease: DesktopLeaseRecord): string {
    const desktop = String(lease.desktopSlug || "desktop").trim();
    const owner = String(lease.ownerUserId || "admin").trim();
    return `${desktop} · ${owner}`;
  }

  desktopLeaseThreadLabel(lease: DesktopLeaseRecord): string {
    return String(lease.ownerThreadLabel || lease.threadName || lease.threadId || "No thread").trim();
  }

  desktopLeaseBusy(lease: DesktopLeaseRecord): boolean {
    const id = String(lease.id || `${lease.desktopSlug || ""}:${lease.ownerUserId || ""}`).trim();
    return !!id && this.activeDesktopLeaseId === id;
  }

  browserActionBusy(browser: BrowserSession): boolean {
    const slug = this.browserSlug(browser);
    return !!slug && this.activeBrowserActionSlug === slug;
  }

  shouldShowBrowserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart" | "cleanup"): boolean {
    if (!this.canBrowserAction(browser, action)) return false;
    const running = this.browserIsRunning(browser);
    if (action === "restart") return running;
    if (action === "start") return !running;
    if (action === "prepare") return !running && !browser.configured && !browser.preparedAt;
    if (action === "cleanup") return !running && (browser.configured === true || Boolean(browser.preparedAt));
    return false;
  }

  canBrowserAction(browser: BrowserSession, action: "prepare" | "start" | "stop" | "restart" | "cleanup"): boolean {
    if (!browser.control) {
      if (action === "prepare" || action === "start") return true;
      if (action === "restart") return !!browser.configured;
      if (action === "stop") return this.browserIsRunning(browser);
      if (action === "cleanup") return !!browser.configured && !this.browserIsRunning(browser);
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

  filteredAuditEvents(): EventRecord[] {
    return this.opsEvents.filter((event) => {
      const user = this.auditUserFilter.trim();
      const resource = this.auditResourceFilter.trim();
      const connector = this.auditConnectorFilter.trim();
      const outcome = this.auditOutcomeFilter.trim();
      if (user && event.actorUserId !== user && event.ownerUserId !== user && String(event["userId"] || "") !== user) return false;
      if (resource && event.resourceType !== resource) return false;
      if (connector && event.connector !== connector) return false;
      if (outcome && event.outcome !== outcome) return false;
      return true;
    });
  }

  auditUserOptions(): string[] {
    return this.uniqueAuditOptions(this.opsEvents.flatMap((event) => [event.actorUserId, event.ownerUserId, String(event["userId"] || "")]));
  }

  auditResourceOptions(): string[] {
    return this.uniqueAuditOptions(this.opsEvents.map((event) => event.resourceType));
  }

  auditConnectorOptions(): string[] {
    return this.uniqueAuditOptions(this.opsEvents.map((event) => event.connector));
  }

  auditOutcomeOptions(): string[] {
    return this.uniqueAuditOptions(this.opsEvents.map((event) => event.outcome));
  }

  auditEventTitle(event: EventRecord): string {
    return String(event.action || event.type || "event").replace(/\./g, " ");
  }

  auditEventMeta(event: EventRecord): string {
    return [
      event.ownerUserId ? `owner ${event.ownerUserId}` : "",
      event.actorUserId ? `actor ${event.actorUserId}` : "",
      event.resourceType ? `resource ${event.resourceType}` : "",
      event.connector ? `connector ${event.connector}` : "",
      event.reason ? `reason ${event.reason}` : "",
    ].filter(Boolean).join(" · ");
  }

  auditOutcomeClass(event: EventRecord): string {
    const outcome = String(event.outcome || "").toLowerCase();
    if (outcome === "allowed" || outcome === "completed" || outcome === "success") return "ready";
    if (outcome === "blocked" || outcome === "failed" || outcome === "error") return "bad";
    return "";
  }

  private uniqueAuditOptions(values: Array<unknown>): string[] {
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
  }

  userAuthLabel(user: OrkestrUser): string {
    const provider = String(user.authProvider || this.opsSetup?.auth?.provider || "browser_pairing").replace(/_/g, " ");
    const factors = this.opsSetup?.auth?.login?.requiredFactors || ["email", "phone"];
    return `${provider} · ${factors.join(" + ")}`;
  }

  keycloakConfigured(): boolean {
    return this.opsSetup?.auth?.provider === "keycloak" && this.opsSetup?.auth?.configured === true;
  }

  authPolicySummary(): string {
    const auth = this.opsSetup?.auth;
    if (!auth) return "Email is unique; phone numbers may be shared.";
    const factors = auth.login?.requiredFactors?.join(" + ") || "email + phone";
    return `${auth.provider || "auth"} · passwordless · ${factors}`;
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

  selectedUserWhatsAppIdentities(user: OrkestrUser): UserIdentity[] {
    if (this.opsUserIdentitiesUserId !== user.id) return [];
    return this.opsUserIdentities.filter((identity) => identity.provider === "whatsapp");
  }

  selectedUserMailIdentities(user: OrkestrUser): UserIdentity[] {
    if (this.opsUserIdentitiesUserId !== user.id) return [];
    return this.opsUserIdentities.filter((identity) => identity.provider === "gmail" || identity.provider === "outlook");
  }

  mailProviderLabel(provider: string): string {
    return provider === "outlook" ? "Outlook" : "Gmail";
  }

  mailIdentityLabel(identity: UserIdentity): string {
    return String(identity.displayName || identity.externalId || identity.accountId || `${this.mailProviderLabel(identity.provider)} account`).trim();
  }

  mailIdentitySummary(identity: UserIdentity): string {
    return [
      this.mailProviderLabel(identity.provider),
      identity.externalId || identity.accountId || "",
      identity.source === "auto" ? "auto-provisioned" : "manual",
    ].filter(Boolean).join(" · ");
  }

  whatsappAccountOptions(): Array<{ id: string; label: string }> {
    const accounts = Array.isArray(this.opsWhatsApp?.["accounts"]) ? this.opsWhatsApp?.["accounts"] as Array<Record<string, unknown>> : [];
    return accounts
      .map((account) => ({
        id: String(account["accountId"] || account["id"] || "").trim(),
        label: String(account["label"] || account["name"] || account["accountId"] || account["id"] || "").trim(),
      }))
      .filter((account) => account.id);
  }

  whatsappIdentityLabel(identity: UserIdentity): string {
    return String(identity.displayName || identity.externalId || identity.chatId || "WhatsApp identity").trim();
  }

  whatsappIdentitySummary(identity: UserIdentity): string {
    return [
      identity.accountId ? `account ${identity.accountId}` : "",
      identity.externalId ? `sender ${identity.externalId}` : "",
      identity.chatId ? `chat ${identity.chatId}` : "",
    ].filter(Boolean).join(" · ") || "no ids saved";
  }

  whatsappIdentitySource(identity: UserIdentity): string {
    return identity.source === "auto" ? "auto-provisioned" : "manual";
  }

  userBrowserSessions(user: OrkestrUser): SecuritySession[] {
    return this.opsSecuritySessions.filter((session) => session.userId === user.id);
  }

  userBrowserChallenges(user: OrkestrUser): SecurityChallenge[] {
    return this.opsSecurityChallenges.filter((challenge) =>
      challenge.userId === user.id &&
      ["pending", "approved"].includes(String(challenge.status || "")),
    );
  }

  sessionSummary(session: SecuritySession): string {
    const last = session.lastAccessedAt ? `last ${new Date(session.lastAccessedAt).toLocaleString()}` : "never used";
    const ip = session.lastIp ? ` · ${session.lastIp}` : "";
    return `${last}${ip}`;
  }

  challengeSummary(challenge: SecurityChallenge): string {
    const expires = challenge.expiresAt ? `expires ${new Date(challenge.expiresAt).toLocaleString()}` : "no expiry";
    return `${challenge.status || "pending"} · ${expires}`;
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

  private ensureUserDraft(user: OrkestrUser): { displayName: string; email: string; phoneNumber: string; role: string; status: string; maxThreads: string } {
    const existing = this.userEditDraft[user.id];
    if (existing) return existing;
    const maxThreads = user.limits?.maxThreads;
    const draft = {
      displayName: user.displayName || user.id,
      email: user.email || "",
      phoneNumber: user.phoneNumber || "",
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
