import { DatePipe } from "@angular/common";
import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { Agent, AgentTemplate, ApiService, BrowserSession, ConnectorStatus, DesktopLeaseRecord, EventRecord, OrkestrUser, OutlookOAuthPollResponse, ReleaseInstance, ReleaseInstancesResponse, ReleaseRolloutResponse, SecurityChallenge, SecuritySession, SetupStatus, TenantVm, TimerDoctorResponse, TimerRecord, ThreadSummary, UserIdentity, UserOutlookOAuthStartResponse, VersionResponse, WatcherAlert, WhatsAppDoctorAccount, WhatsAppDoctorBinding, WhatsAppDoctorResponse, WhatsAppOutboxJob } from "./api.service";
import { OpsWaitlistComponent } from "./ops-waitlist.component";

export type ToolsView = "system" | "broker" | "timers" | "desktops" | "models" | "settings" | "connectors" | "users" | "waitlist" | "audit";
type MailIdentityProvider = "gmail" | "outlook";

interface BrokerThreadRow {
  id: string;
  label: string;
  state: string;
  threadId?: string;
  codexThreadId?: string | null;
  chatId?: string;
  chatName?: string;
  bindingId?: string;
  accountIds: string[];
  aclLabel: string;
  sendAclMode: string;
  queueLabel: string;
  outboxLabel: string;
  runtimeLabel: string;
  unansweredLabel: string;
  hasUnanswered: boolean;
  latestAlert?: WatcherAlert | null;
  routeOnly?: boolean;
  remoteStatus?: string;
  localThread?: ThreadSummary | null;
}

type BrokerSavedViewId = "all" | "unanswered" | "down" | "wa-issues" | "rollout-ready" | "alerts";

interface BrokerSavedView {
  id: BrokerSavedViewId;
  label: string;
  description: string;
}

@Component({
  selector: "ork-ops-page",
  imports: [DatePipe, FormsModule, OpsWaitlistComponent],
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
  opsWhatsAppDoctor: WhatsAppDoctorResponse | null = null;
  opsWhatsAppDoctorError = "";
  opsWhatsAppOutboxJobs: WhatsAppOutboxJob[] = [];
  opsWhatsAppOutboxTotal = 0;
  opsWhatsAppOutboxError = "";
  opsRuntimeBudget: Record<string, unknown> | null = null;
  opsConnectors: ConnectorStatus[] = [];
  opsReleaseInstances: ReleaseInstance[] = [];
  opsReleaseCounts: Record<string, number> = {};
  opsReleaseGeneratedAt = "";
  opsReleaseError = "";
  opsReleaseRolloutRef = "main";
  opsReleaseRolloutChannel = "main";
  opsReleaseRolloutBusy = false;
  opsReleaseRolloutError = "";
  opsReleaseRolloutReport: ReleaseRolloutResponse | null = null;
  opsTenantVms: TenantVm[] = [];
  opsTenantVmsError = "";
  opsThreads: ThreadSummary[] = [];
  opsThreadsError = "";
  opsWatcherAlerts: WatcherAlert[] = [];
  opsWatcherAlertsError = "";
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
  activeWatcherAlertActionId = "";
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
  brokerSearchText = "";
  brokerSavedViewId: BrokerSavedViewId = "all";
  brokerRemediationRow: BrokerThreadRow | null = null;
  brokerRemediationAction = "";
  brokerRemediationBusy = false;
  brokerAclRow: BrokerThreadRow | null = null;
  brokerAclMode = "";
  brokerAclBusy = false;
  readonly brokerSavedViews: BrokerSavedView[] = [
    { id: "all", label: "All", description: "Full broker inventory" },
    { id: "unanswered", label: "Unanswered", description: "Threads needing a reply" },
    { id: "down", label: "Down", description: "Unreachable or down instances" },
    { id: "wa-issues", label: "WA issues", description: "Unpaired routes and outbox risk" },
    { id: "rollout-ready", label: "Rollout ready", description: "Version train targets" },
    { id: "alerts", label: "Alerts", description: "Rows with watcher alerts" },
  ];
  userEditDraft: Record<string, { displayName: string; email: string; phoneNumber: string; role: string; status: string; maxThreads: string }> = {};

  ngOnInit(): void {
    this.loadBrokerViewState();
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
      const [version, releaseInstances, tenantVms, threads, watcherAlerts, setup, whatsapp, whatsappDoctor, whatsappOutbox, agents, templates, timers, timerDoctor, events, browsers, desktopLeases, runtimeLeases, executors, executions, system, processes, models, users, securityChallenges, securitySessions] = await Promise.allSettled([
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.releaseInstances(true)),
        firstValueFrom(this.api.tenantVms()),
        firstValueFrom(this.api.threads({ includeAllUsers: true })),
        firstValueFrom(this.api.watcherAlerts(20)),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.whatsappDoctor()),
        firstValueFrom(this.api.whatsappOutbox({ limit: 20 })),
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
      if (releaseInstances.status === "fulfilled") this.applyReleaseInstances(releaseInstances.value);
      else this.applyReleaseInstancesError(releaseInstances.reason);
      if (tenantVms.status === "fulfilled") {
        this.opsTenantVms = tenantVms.value.tenantVms || tenantVms.value.vms || [];
        this.opsTenantVmsError = "";
      } else {
        this.opsTenantVms = [];
        this.opsTenantVmsError = this.errorText(tenantVms.reason);
      }
      if (threads.status === "fulfilled") {
        this.opsThreads = threads.value.threads || [];
        this.opsThreadsError = "";
      } else {
        this.opsThreads = [];
        this.opsThreadsError = this.errorText(threads.reason);
      }
      if (watcherAlerts.status === "fulfilled") {
        this.opsWatcherAlerts = watcherAlerts.value.alerts || [];
        this.opsWatcherAlertsError = "";
      } else {
        this.opsWatcherAlerts = [];
        this.opsWatcherAlertsError = this.errorText(watcherAlerts.reason);
      }
      if (setup.status === "fulfilled") {
        this.opsSetup = setup.value;
        this.opsConnectors = setup.value.connectors || [];
      }
      if (whatsapp.status === "fulfilled") this.opsWhatsApp = whatsapp.value;
      if (whatsappDoctor.status === "fulfilled") {
        this.opsWhatsAppDoctor = whatsappDoctor.value;
        this.opsWhatsAppDoctorError = "";
      } else {
        this.opsWhatsAppDoctor = null;
        this.opsWhatsAppDoctorError = this.errorText(whatsappDoctor.reason);
      }
      if (whatsappOutbox.status === "fulfilled") {
        this.opsWhatsAppOutboxJobs = whatsappOutbox.value.jobs || [];
        this.opsWhatsAppOutboxTotal = Number(whatsappOutbox.value.total || whatsappOutbox.value.count || 0);
        this.opsWhatsAppOutboxError = "";
      } else {
        this.opsWhatsAppOutboxJobs = [];
        this.opsWhatsAppOutboxTotal = 0;
        this.opsWhatsAppOutboxError = this.errorText(whatsappOutbox.reason);
      }
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

  releaseTrainCount(): number {
    return Number(this.opsReleaseCounts["releaseTrainEnabled"] || 0) || this.opsReleaseInstances.filter((instance) => instance.releaseTrainEnabled).length;
  }

  releaseDeployCommandCount(): number {
    return Number(this.opsReleaseCounts["withDeployCommand"] || 0) || this.opsReleaseInstances.filter((instance) => instance.hasDeployCommand).length;
  }

  releaseUnreachableCount(): number {
    return Number(this.opsReleaseCounts["unreachable"] || 0) || this.opsReleaseInstances.filter((instance) => this.releaseInstanceStatusClass(instance) === "bad").length;
  }

  brokerUserCount(): number {
    return this.opsUsers.length;
  }

  brokerThreadCount(): number {
    return this.opsThreads.length;
  }

  brokerActiveThreadCount(): number {
    return this.opsThreads.filter((thread) => {
      const state = String(thread.state || thread.status || "").toLowerCase();
      return thread.working || thread.typingActive || ["working", "running", "queued", "waking"].includes(state);
    }).length;
  }

  brokerUnansweredThreadCount(): number {
    return this.opsThreads.filter((thread) => this.threadLooksUnanswered(thread)).length;
  }

  brokerVisibleInstanceCount(): number {
    return this.brokerVisibleInstances().length;
  }

  brokerVisibleThreadCount(): number {
    const seen = new Set<string>();
    for (const instance of this.brokerVisibleInstances()) {
      for (const row of this.brokerVisibleThreads(instance)) seen.add(row.threadId || row.id);
    }
    return seen.size;
  }

  brokerSearchSummary(): string {
    const view = this.brokerSavedViews.find((candidate) => candidate.id === this.brokerSavedViewId);
    return [
      view ? `${view.label} view` : "Custom view",
      `${this.brokerVisibleInstanceCount()} instance${this.brokerVisibleInstanceCount() === 1 ? "" : "s"}`,
      `${this.brokerVisibleThreadCount()} thread${this.brokerVisibleThreadCount() === 1 ? "" : "s"}`,
      `${this.brokerVisibleAlerts().length} alert${this.brokerVisibleAlerts().length === 1 ? "" : "s"}`,
    ].join(" · ");
  }

  setBrokerSavedView(viewId: BrokerSavedViewId): void {
    this.brokerSavedViewId = viewId;
    this.saveBrokerViewState();
  }

  clearBrokerSearch(): void {
    this.brokerSearchText = "";
    this.saveBrokerViewState();
  }

  brokerRuntimeSplitLabel(): string {
    const counts = this.opsThreads.reduce((acc: Record<string, number>, thread) => {
      const mode = this.threadRuntimeLabel(thread);
      acc[mode] = (acc[mode] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([mode, count]) => `${mode} ${count}`)
      .join(" · ") || "no threads";
  }

  releaseAvailabilityPercent(): string {
    const percent = Number(this.opsReleaseCounts["availabilityPercent"]);
    if (Number.isFinite(percent)) return `${percent}%`;
    const total = this.brokerInstances().length;
    if (!total) return "100%";
    return `${Math.round(((total - this.releaseUnreachableCount()) / total) * 1000) / 10}%`;
  }

  releaseDowntimeCount(): number {
    return Number(this.opsReleaseCounts["down"] || 0) || this.opsReleaseInstances.filter((instance) => String(instance.downtime?.state || "").toLowerCase() === "down").length;
  }

  releaseDowntimeTotalLabel(): string {
    const seconds = Number(this.opsReleaseCounts["downtimeSeconds"] || 0);
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${Math.max(0, seconds)}s`;
  }

  async planReleaseRollout(): Promise<void> {
    this.opsReleaseRolloutBusy = true;
    this.opsReleaseRolloutError = "";
    try {
      this.opsReleaseRolloutReport = await firstValueFrom(this.api.releaseRollout({
        ref: this.opsReleaseRolloutRef.trim() || "main",
        channel: this.opsReleaseRolloutChannel.trim() || "main",
        execute: false,
      }));
    } catch (error) {
      this.opsReleaseRolloutReport = null;
      this.opsReleaseRolloutError = this.errorText(error);
    } finally {
      this.opsReleaseRolloutBusy = false;
      this.renderNow();
    }
  }

  releaseRolloutResultLine(): string {
    const report = this.opsReleaseRolloutReport;
    if (!report) return "";
    const counts = report.counts || {};
    return [
      report.dryRun ? "dry run" : "execute",
      report.ref ? `ref ${report.ref}` : "",
      report.channel ? `channel ${report.channel}` : "",
      Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" · "),
    ].filter(Boolean).join(" · ");
  }

  releaseInstanceLabel(instance: ReleaseInstance): string {
    return String(instance.displayName || instance.id || "Orkestr instance").trim();
  }

  releaseInstanceVersion(instance: ReleaseInstance): string {
    const version = instance.currentVersion || {};
    return String(version.releaseId || version.describe || version.version || instance.ref || "unknown").trim();
  }

  releaseInstanceCommit(instance: ReleaseInstance): string {
    const version = instance.currentVersion || {};
    const commit = String(version.shortCommit || version.commit || "").trim();
    return commit.length > 12 ? commit.slice(0, 12) : commit;
  }

  releaseInstanceTargetVersion(instance: ReleaseInstance): string {
    const version = instance.targetVersion || {};
    return String(version.releaseId || version.describe || version.version || instance.ref || "").trim();
  }

  releaseInstanceStatusClass(instance: ReleaseInstance): string {
    const status = String(instance.status || "").trim().toLowerCase();
    if (["reachable", "running", "ready", "ok", "healthy"].includes(status)) return "ready";
    if (["unreachable", "broken", "failed", "error", "down"].includes(status) || instance.lastError) return "bad";
    return "";
  }

  releaseInstanceMeta(instance: ReleaseInstance): string {
    return [
      instance.kind || "service",
      instance.source || "",
      instance.channel ? `channel ${instance.channel}` : "",
      instance.updateStrategy || "",
    ].filter(Boolean).join(" · ");
  }

  releaseInstanceRolloutLabel(instance: ReleaseInstance): string {
    if (!instance.releaseTrainEnabled) return "manual";
    return instance.hasDeployCommand ? "train ready" : "train listed";
  }

  releaseInstanceEndpoint(instance: ReleaseInstance): string {
    return String(instance.baseUrl || instance.versionUrl || instance.healthUrl || "").trim();
  }

  releaseInstanceInfraLabel(instance: ReleaseInstance): string {
    const endpoint = this.releaseInstanceEndpoint(instance);
    let host = "";
    try {
      host = endpoint ? new URL(endpoint).host : "";
    } catch {
      host = endpoint.replace(/^https?:\/\//i, "").split("/")[0];
    }
    return [
      host ? `host ${host}` : "",
      instance.serviceName ? `service ${instance.serviceName}` : "",
      instance.home ? `home ${instance.home}` : "",
      instance.sourceId ? `source ${instance.sourceId}` : "",
    ].filter(Boolean).join(" · ");
  }

  releaseInstanceHealthLabel(instance: ReleaseInstance): string {
    const probe = instance.lastProbe || {};
    if (!probe.checkedAt) return "not probed";
    const latency = Number(probe.latencyMs || 0);
    const suffix = latency > 0 ? ` · ${latency}ms` : "";
    return probe.ok ? `probe ok${suffix}` : `probe failed${suffix}`;
  }

  releaseInstanceDowntimeLabel(instance: ReleaseInstance): string {
    const downtime = instance.downtime || {};
    const state = String(downtime.state || "").trim().toLowerCase();
    if (state === "down") {
      const seconds = Number(downtime.durationSeconds || 0);
      const duration = seconds >= 3600
        ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
        : seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
      return `down ${duration}`;
    }
    if (state === "up") return "up";
    return "downtime unknown";
  }

  whatsappDoctorCount(key: string): number {
    return Number(this.opsWhatsAppDoctor?.counts?.[key] || 0);
  }

  whatsappAccounts(): WhatsAppDoctorAccount[] {
    return this.opsWhatsAppDoctor?.accounts || [];
  }

  whatsappReadyAccountCount(): number {
    return this.whatsappAccounts().filter((account) => this.whatsappAccountStatusClass(account) === "ready").length;
  }

  whatsappBindings(): WhatsAppDoctorBinding[] {
    return this.opsWhatsAppDoctor?.bindings || [];
  }

  whatsappRouteEligibleBindingCount(): number {
    return this.whatsappBindings().filter((binding) => binding.routeEligible !== false && binding.enabled !== false).length;
  }

  visibleWhatsAppBindings(): WhatsAppDoctorBinding[] {
    return [...this.whatsappBindings()]
      .sort((a, b) => {
        const aReady = this.whatsappBindingStatusClass(a) === "ready" ? 1 : 0;
        const bReady = this.whatsappBindingStatusClass(b) === "ready" ? 1 : 0;
        if (aReady !== bReady) return aReady - bReady;
        return this.whatsappBindingTitle(a).localeCompare(this.whatsappBindingTitle(b));
      })
      .slice(0, 16);
  }

  brokerInstances(): ReleaseInstance[] {
    return [...this.opsReleaseInstances].sort((left, right) => {
      const order = ["orkestr-ui", "vm-crawlerai", "vm-orkestr-de"];
      const leftIndex = order.indexOf(left.id);
      const rightIndex = order.indexOf(right.id);
      if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
      return this.releaseInstanceLabel(left).localeCompare(this.releaseInstanceLabel(right));
    });
  }

  brokerVisibleInstances(): ReleaseInstance[] {
    return this.brokerInstances().filter((instance) => this.brokerInstanceVisible(instance));
  }

  brokerTenantVm(instance: ReleaseInstance): TenantVm | null {
    const sourceId = String(instance.sourceId || "").trim();
    const id = String(instance.id || "").replace(/^vm-/, "");
    return this.opsTenantVms.find((vm) => vm.id === sourceId || vm.id === id || `vm-${vm.id}` === instance.id) || null;
  }

  brokerInstanceRoute(instance: ReleaseInstance) {
    return this.brokerTenantVm(instance)?.whatsappRoute || null;
  }

  brokerRemoteStatus(instance: ReleaseInstance): string {
    if (instance.id === "orkestr-ui") return "local";
    const route = this.brokerInstanceRoute(instance);
    if (!route) return "no parent route";
    return route.tokenConfigured ? "remote route configured" : "route token missing";
  }

  brokerRemoteStatusClass(instance: ReleaseInstance): string {
    const status = this.brokerRemoteStatus(instance);
    if (status === "local" || status === "remote route configured") return "ready";
    return "bad";
  }

  brokerInstanceRouteLine(instance: ReleaseInstance): string {
    const route = this.brokerInstanceRoute(instance);
    if (!route) return "No parent-known WhatsApp route";
    return [
      route.chatName || route.chatId || "WhatsApp route",
      route.routeMode || "route",
      route.accountId ? `Account ID ${route.accountId}` : "",
    ].filter(Boolean).join(" · ");
  }

  brokerThreads(instance: ReleaseInstance): BrokerThreadRow[] {
    const route = this.brokerInstanceRoute(instance);
    const routeChatId = String(route?.chatId || "").trim();
    const isLocal = instance.id === "orkestr-ui";
    const sourceThreads = isLocal
      ? this.opsThreads
      : this.opsThreads.filter((thread) => String(thread.binding?.chatId || "").trim() === routeChatId && routeChatId);
    const rows = sourceThreads.map((thread) => this.brokerThreadRowFromThread(thread, route || null));
    if (!isLocal && routeChatId && !rows.some((row) => row.chatId === routeChatId)) {
      rows.unshift({
        id: `${instance.id}:${routeChatId}`,
        label: String(route?.chatName || routeChatId),
        state: "Remote thread list not loaded",
        chatId: routeChatId,
        chatName: String(route?.chatName || ""),
        bindingId: "",
        accountIds: [String(route?.accountId || "").trim()].filter(Boolean),
        aclLabel: "remote route",
        sendAclMode: "remote",
        queueLabel: "remote",
        outboxLabel: this.brokerOutboxLabelFor("", routeChatId),
        runtimeLabel: "remote",
        unansweredLabel: "remote",
        hasUnanswered: false,
        latestAlert: this.brokerLatestAlert("", routeChatId),
        routeOnly: true,
        remoteStatus: route?.diagnostics?.nextAction || "remote auth required for thread details",
        localThread: null,
      });
    }
    return rows;
  }

  brokerVisibleThreads(instance: ReleaseInstance): BrokerThreadRow[] {
    const instanceMatchesSearch = this.brokerInstanceMatchesSearch(instance);
    const instanceMatchesView = this.brokerInstanceMatchesSavedView(instance);
    return this.brokerThreads(instance).filter((row) => {
      const searchMatch = instanceMatchesSearch || this.brokerThreadRowMatchesSearch(row);
      const viewMatch = instanceMatchesView || this.brokerThreadRowMatchesSavedView(row);
      return searchMatch && viewMatch;
    });
  }

  brokerThreadRowFromThread(thread: ThreadSummary, route: NonNullable<TenantVm["whatsappRoute"]> | null): BrokerThreadRow {
    const chatId = String(thread.binding?.chatId || "").trim();
    const binding = this.whatsappBindingForThread(thread, chatId);
    const sendAclMode = this.whatsappBindingSendAclMode(binding || thread.binding || {});
    const accountIds = [
      thread.binding?.inboundAccountId,
      thread.binding?.senderAccountId,
      thread.binding?.responderConnectorAccountId,
      thread.binding?.responderAccountId,
      thread.binding?.outboundAccountId,
      route?.accountId,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return {
      id: thread.id,
      label: String(thread.binding?.displayName || thread.bindingName || thread.title || thread.name || thread.id),
      state: String(thread.publicStatus || thread.state || thread.status || "unknown"),
      threadId: thread.id,
      codexThreadId: thread.codexThreadId,
      chatId,
      chatName: String(thread.binding?.displayName || ""),
      bindingId: String(binding?.bindingId || binding?.id || this.objectValue(thread.binding || {}, "id") || ""),
      accountIds: [...new Set(accountIds)],
      aclLabel: this.whatsappBindingAclLabel(binding || thread.binding || {}),
      sendAclMode,
      queueLabel: `${Number(thread.pendingCount || 0)} queued · ${Number(thread.runningCount || 0)} running`,
      outboxLabel: this.brokerOutboxLabelFor(thread.id, chatId),
      runtimeLabel: this.threadRuntimeLabel(thread),
      unansweredLabel: this.threadUnansweredLabel(thread),
      hasUnanswered: this.threadLooksUnanswered(thread),
      latestAlert: this.brokerLatestAlert(thread.id, chatId),
      localThread: thread,
    };
  }

  private threadRuntimeLabel(thread: ThreadSummary): string {
    const explicit = String(thread.runtimeModeLabel || "").trim();
    if (explicit) return explicit;
    const mode = String(thread.runtimeMode || thread.runtimeKind || "").trim().toLowerCase();
    if (mode === "codex-api" || mode === "codex-app-server") return "Codex API";
    if (mode === "codex-tmux" || mode === "migration_required") return "Codex tmux";
    if (mode === "attached-terminal" || mode === "raw-terminal") return "Attached terminal";
    if (mode === "agent" || mode === "api-agent") return "Agent";
    return mode || "unknown";
  }

  private threadLooksUnanswered(thread: ThreadSummary): boolean {
    const lastRole = String(thread.lastMessageRole || "").trim().toLowerCase();
    const state = String(thread.state || thread.status || "").trim().toLowerCase();
    if (lastRole !== "user") return false;
    if (thread.awaitingInput || thread.working || thread.typingActive) return false;
    if (Number(thread.pendingCount || 0) > 0 || Number(thread.runningCount || 0) > 0) return false;
    return !["working", "running", "queued", "waking"].includes(state);
  }

  private threadUnansweredLabel(thread: ThreadSummary): string {
    if (this.threadLooksUnanswered(thread)) return "unanswered";
    const lastRole = String(thread.lastMessageRole || "").trim().toLowerCase();
    if (thread.awaitingInput) return "awaiting input";
    if (thread.working || thread.typingActive) return "answering";
    if (Number(thread.pendingCount || 0) > 0) return "queued";
    if (lastRole === "assistant") return "answered";
    return lastRole || "unknown";
  }

  brokerOutboxLabelFor(threadId = "", chatId = ""): string {
    const jobs = this.opsWhatsAppOutboxJobs.filter((job) => {
      return (!!threadId && job.threadId === threadId) || (!!chatId && job.chatId === chatId);
    });
    if (!jobs.length) return "0 outbox";
    const failed = jobs.filter((job) => ["failed", "dead", "dead_letter", "failed_terminal"].includes(String(job.state || ""))).length;
    const pending = jobs.filter((job) => ["pending", "queued", "claimed", "pending_retry"].includes(String(job.state || ""))).length;
    return failed || pending ? `${failed} failed · ${pending} pending` : `${jobs.length} recent`;
  }

  brokerLatestAlert(threadId = "", chatId = ""): WatcherAlert | null {
    return this.opsWatcherAlerts.find((alert) => {
      const details = alert.details || {};
      return (!!threadId && (alert.threadId === threadId || alert.watcherThreadId === threadId)) || (!!chatId && String(details["chatId"] || "") === chatId);
    }) || null;
  }

  brokerVisibleAlerts(): WatcherAlert[] {
    return this.opsWatcherAlerts.filter((alert) => {
      if (!this.brokerAlertMatchesSavedView(alert)) return false;
      return this.brokerAlertMatchesSearch(alert);
    });
  }

  brokerAccountIds(row: BrokerThreadRow): string {
    return row.accountIds.length ? row.accountIds.join(", ") : "-";
  }

  requestBrokerAclChange(row: BrokerThreadRow, mode: string): void {
    if (!row.bindingId || row.routeOnly) return;
    this.brokerAclRow = row;
    this.brokerAclMode = mode;
  }

  cancelBrokerAclChange(): void {
    this.brokerAclRow = null;
    this.brokerAclMode = "";
  }

  brokerAclChangeLabel(): string {
    if (this.brokerAclMode === "owner-only") return "Restrict send ACL to owner";
    if (this.brokerAclMode === "all-users") return "Allow all users to send";
    return "Update send ACL";
  }

  brokerAclChangeMeta(): string {
    const row = this.brokerAclRow;
    if (!row) return "";
    return [
      row.bindingId ? `binding ${row.bindingId}` : "",
      row.threadId ? `thread ${row.threadId}` : "",
      row.chatId ? `chat ${row.chatId}` : "",
      `current ${row.aclLabel}`,
    ].filter(Boolean).join(" · ");
  }

  async confirmBrokerAclChange(): Promise<void> {
    const row = this.brokerAclRow;
    const mode = this.brokerAclMode;
    if (!row?.bindingId || !mode || this.brokerAclBusy) return;
    this.brokerAclBusy = true;
    try {
      await firstValueFrom(this.api.updateWhatsAppBinding(row.bindingId, {
        acl: { send: { mode } },
      }));
      await this.loadOps(false);
      this.notice = `${row.label} send ACL updated to ${mode}.`;
      this.error = "";
      this.cancelBrokerAclChange();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.brokerAclBusy = false;
      this.renderNow();
    }
  }

  brokerThreadUrl(row: BrokerThreadRow): string {
    return row.localThread ? `/ng/thread/${encodeURIComponent(row.localThread.id)}` : "";
  }

  brokerAccountHistory(): Array<{ phone: string; accountId: string; state: string; source: string; detail: string }> {
    const rows: Array<{ phone: string; accountId: string; state: string; source: string; detail: string }> = [];
    for (const account of this.whatsappAccounts()) {
      const phone = String(account.phoneNumber || account.phone || account.number || account.pairingPhoneNumber || "").trim();
      if (phone) {
        rows.push({
          phone,
          accountId: String(account.accountId || account.id || ""),
          state: account.ready ? "ready" : String(account.state || "not ready"),
          source: "current diagnostics",
          detail: "Current embedded Broker account diagnostic.",
        });
      }
    }
    if (!rows.some((row) => row.phone.includes("4917632400662") || row.phone.includes("+4917632400662"))) {
      rows.push({
        phone: "+4917632400662",
        accountId: "main",
        state: "not in current embedded Broker accounts",
        source: "recent standalone bridge history",
        detail: "Seen as the recently paired standalone WhatsApp bridge account, but current Broker diagnostics only expose configured IDs such as sender/responder.",
      });
    }
    return rows;
  }

  async brokerWake(row: BrokerThreadRow): Promise<void> {
    if (!row.localThread) return;
    this.requestBrokerRemediation(row, "wake");
  }

  async brokerRecover(row: BrokerThreadRow): Promise<void> {
    if (!row.localThread) return;
    this.requestBrokerRemediation(row, "recover");
  }

  requestBrokerRemediation(row: BrokerThreadRow, action: "wake" | "recover" | "retry-outbox"): void {
    this.brokerRemediationRow = row;
    this.brokerRemediationAction = action;
  }

  cancelBrokerRemediation(): void {
    this.brokerRemediationRow = null;
    this.brokerRemediationAction = "";
  }

  brokerRemediationLabel(): string {
    if (this.brokerRemediationAction === "wake") return "Wake thread";
    if (this.brokerRemediationAction === "recover") return "Recover runtime";
    if (this.brokerRemediationAction === "retry-outbox") return "Retry outbox";
    return "Remediation";
  }

  brokerRemediationMeta(): string {
    const row = this.brokerRemediationRow;
    if (!row) return "";
    return [
      row.threadId ? `thread ${row.threadId}` : "",
      row.chatId ? `chat ${row.chatId}` : "",
      row.accountIds.length ? `accounts ${row.accountIds.join(", ")}` : "",
      row.runtimeLabel,
      row.outboxLabel,
    ].filter(Boolean).join(" · ");
  }

  async confirmBrokerRemediation(): Promise<void> {
    const row = this.brokerRemediationRow;
    const action = this.brokerRemediationAction;
    if (!row || this.brokerRemediationBusy) return;
    this.brokerRemediationBusy = true;
    try {
      if (action === "wake" || action === "recover") await this.runBrokerThreadAction(row, action);
      else if (action === "retry-outbox") await this.runBrokerOutboxRetry(row);
      this.cancelBrokerRemediation();
    } finally {
      this.brokerRemediationBusy = false;
      this.renderNow();
    }
  }

  private async runBrokerThreadAction(row: BrokerThreadRow, action: "wake" | "recover"): Promise<void> {
    try {
      if (action === "wake") await firstValueFrom(this.api.wakeThread(row.localThread!.id));
      else await firstValueFrom(this.api.recoverThread(row.localThread!.id));
      this.notice = `${action} requested for ${row.label}`;
      await this.loadOps(false);
    } catch (error) {
      this.notice = this.errorText(error);
    }
  }

  async brokerRetryOutbox(row: BrokerThreadRow): Promise<void> {
    this.requestBrokerRemediation(row, "retry-outbox");
  }

  private async runBrokerOutboxRetry(row: BrokerThreadRow): Promise<void> {
    const job = this.opsWhatsAppOutboxJobs.find((candidate) => {
      const state = String(candidate.state || "").toLowerCase();
      if (!["failed", "pending_retry", "queued", "pending"].includes(state)) return false;
      return (!!row.threadId && candidate.threadId === row.threadId) || (!!row.chatId && candidate.chatId === row.chatId);
    });
    if (!job) {
      this.notice = "No retryable outbox job loaded for this row.";
      return;
    }
    try {
      await firstValueFrom(this.api.whatsappOutboxAction(job.id, "retry", { reason: "operator_broker_retry" }));
      this.notice = `Retry requested for ${row.label}`;
      await this.loadOps(false);
    } catch (error) {
      this.notice = this.errorText(error);
    }
  }

  whatsappAccountLabel(account: WhatsAppDoctorAccount): string {
    return String(account.accountId || account.id || account.displayName || account.label || account.name || "WhatsApp account ID").trim();
  }

  whatsappAccountIdentity(account: WhatsAppDoctorAccount): string {
    const phone = String(account.phoneNumber || account.phone || account.number || account.pairingPhoneNumber || "").trim();
    const contact = String(account.contactId || "").trim();
    return phone || (contact ? `identity ${contact}` : "No phone number on record");
  }

  whatsappAccountStatusClass(account: WhatsAppDoctorAccount): string {
    const state = String(account.state || "").trim().toLowerCase();
    if (account.error || ["failed", "error", "broken", "disconnected"].includes(state)) return "bad";
    if (account.ready || account.sendReady || account.inboundReady || state === "ready") return "ready";
    return "";
  }

  whatsappAccountStatusLabel(account: WhatsAppDoctorAccount): string {
    return [
      account.state || "unknown",
      account.ready ? "ready" : "not ready",
      account.nextAction && account.nextAction !== "none" ? account.nextAction : "",
    ].filter(Boolean).join(" · ");
  }

  whatsappAccountFlags(account: WhatsAppDoctorAccount): string {
    return [
      account.authenticated ? "authenticated" : "not authenticated",
      account.paired ? "paired" : "not paired",
      account.started ? "started" : "stopped",
      account.sendReady ? "send ready" : "send blocked",
      account.inboundReady ? "inbound ready" : "inbound blocked",
    ].join(" · ");
  }

  whatsappAccountMeta(account: WhatsAppDoctorAccount): string {
    return [
      account.accountId ? `Account ID ${account.accountId}` : "",
      account.runtimeAccountId && account.runtimeAccountId !== account.accountId ? `runtime ${account.runtimeAccountId}` : "",
      account.pushName ? `profile ${account.pushName}` : "",
      account.autostart ? "autostart" : "manual start",
      account.updatedAt ? `updated ${new Date(account.updatedAt).toLocaleString()}` : "",
    ].filter(Boolean).join(" · ");
  }

  whatsappBindingTitle(binding: WhatsAppDoctorBinding): string {
    return String(binding.displayName || binding.threadName || binding.chatId || binding.bindingId || binding.id || "WhatsApp binding").trim();
  }

  whatsappBindingStatusClass(binding: WhatsAppDoctorBinding): string {
    const state = String(binding.state || "").trim().toLowerCase();
    if (binding.enabled === false || binding.routeEligible === false || binding.mirrorToWhatsApp === false) return "";
    if (state === "ready") return "ready";
    if (state || binding.reason) return "bad";
    return "";
  }

  whatsappBindingStatusLabel(binding: WhatsAppDoctorBinding): string {
    return [
      binding.state || "unknown",
      binding.reason || "",
      binding.enabled === false ? "disabled" : "",
      binding.routeEligible === false ? "not routable" : "routable",
      binding.mirrorToWhatsApp === false ? "mirror off" : "mirror on",
    ].filter(Boolean).join(" · ");
  }

  whatsappBindingMeta(binding: WhatsAppDoctorBinding): string {
    return [
      binding.threadId ? `thread ${binding.threadId}` : "",
      binding.chatId ? `chat ${binding.chatId}` : "",
      binding.responderAccountId || binding.responderConnectorAccountId ? `Account ID ${binding.responderAccountId || binding.responderConnectorAccountId}` : "",
      binding.accountIds?.length ? `Allowed IDs ${binding.accountIds.join(", ")}` : "",
    ].filter(Boolean).join(" · ");
  }

  whatsappBindingForThread(thread: ThreadSummary, chatId = ""): WhatsAppDoctorBinding | null {
    return this.whatsappBindings().find((binding) => {
      const bindingId = String(binding.bindingId || binding.id || "").trim();
      const threadBindingId = String(this.objectValue(thread.binding || {}, "id") || "").trim();
      return (!!binding.threadId && binding.threadId === thread.id) ||
        (!!threadBindingId && bindingId === threadBindingId) ||
        (!!chatId && binding.chatId === chatId);
    }) || null;
  }

  whatsappBindingSendAclMode(binding: Record<string, unknown> = {}): string {
    const acl = binding["acl"] && typeof binding["acl"] === "object" && !Array.isArray(binding["acl"])
      ? binding["acl"] as Record<string, unknown>
      : {};
    const send = acl["send"] && typeof acl["send"] === "object" && !Array.isArray(acl["send"])
      ? acl["send"] as Record<string, unknown>
      : {};
    return String(send["mode"] || "owner-only").trim();
  }

  whatsappBindingAclLabel(binding: Record<string, unknown> = {}): string {
    const sendMode = this.whatsappBindingSendAclMode(binding);
    const acl = binding["acl"] && typeof binding["acl"] === "object" && !Array.isArray(binding["acl"])
      ? binding["acl"] as Record<string, unknown>
      : {};
    const read = acl["read"] && typeof acl["read"] === "object" && !Array.isArray(acl["read"]) ? acl["read"] as Record<string, unknown> : {};
    const receive = acl["receive"] && typeof acl["receive"] === "object" && !Array.isArray(acl["receive"]) ? acl["receive"] as Record<string, unknown> : {};
    const manage = acl["manage"] && typeof acl["manage"] === "object" && !Array.isArray(acl["manage"]) ? acl["manage"] as Record<string, unknown> : {};
    return [
      `send ${sendMode || "owner-only"}`,
      read["mode"] ? `read ${read["mode"]}` : "",
      receive["mode"] ? `receive ${receive["mode"]}` : "",
      manage["mode"] ? `manage ${manage["mode"]}` : "",
    ].filter(Boolean).join(" · ");
  }

  whatsappOutboxStateClass(job: WhatsAppOutboxJob): string {
    const state = String(job.state || "").trim().toLowerCase();
    if (["delivered", "skipped", "suppressed"].includes(state)) return "ready";
    if (["failed", "dead", "dead_letter", "dead-letter", "failed_terminal"].includes(state)) return "bad";
    return "";
  }

  whatsappOutboxTitle(job: WhatsAppOutboxJob): string {
    return [
      job.deliveryType || "message",
      job.state || "unknown",
      job.accountId ? `via ${job.accountId}` : "",
    ].filter(Boolean).join(" · ");
  }

  whatsappOutboxMeta(job: WhatsAppOutboxJob): string {
    return [
      job.threadId ? `thread ${job.threadId}` : "",
      job.chatId ? `chat ${job.chatId}` : "",
      Number.isFinite(Number(job.attemptCount)) ? `${job.attemptCount} attempt${Number(job.attemptCount) === 1 ? "" : "s"}` : "",
      job.updatedAt ? `updated ${new Date(job.updatedAt).toLocaleString()}` : "",
    ].filter(Boolean).join(" · ");
  }

  watcherAlertStatusClass(alert: WatcherAlert): string {
    const severity = String(alert.severity || "").trim().toLowerCase();
    const status = String(alert.status || "").trim().toLowerCase();
    if (["error", "critical", "fatal"].includes(severity) || ["failed", "thread_unavailable"].includes(status)) return "bad";
    if (["warning", "warn"].includes(severity)) return "";
    return "ready";
  }

  watcherAlertTitle(alert: WatcherAlert): string {
    return [alert.source || "orkestr", alert.code || "alert"].filter(Boolean).join(" · ");
  }

  watcherAlertMeta(alert: WatcherAlert): string {
    return [
      alert.threadId ? `thread ${alert.threadId}` : "",
      alert.routerTraceId ? `trace ${alert.routerTraceId}` : "",
      alert.watcherThreadId ? `watcher ${alert.watcherThreadId}` : "",
      alert["acknowledgedBy"] ? `ack ${alert["acknowledgedBy"]}` : "",
      alert["resolvedBy"] ? `resolved ${alert["resolvedBy"]}` : "",
      alert["escalatedBy"] ? `escalated ${alert["escalatedBy"]}` : "",
    ].filter(Boolean).join(" · ");
  }

  watcherAlertActions(alert: WatcherAlert): string[] {
    const status = String(alert.status || "").trim().toLowerCase();
    if (status === "resolved") return ["reopen"];
    if (status === "acknowledged") return ["resolve", "escalate"];
    if (status === "escalated") return ["resolve"];
    return ["acknowledge", "resolve", "escalate"];
  }

  watcherAlertActionLabel(action: string): string {
    if (action === "acknowledge") return "Ack";
    if (action === "resolve") return "Resolve";
    if (action === "escalate") return "Escalate";
    if (action === "reopen") return "Reopen";
    return action;
  }

  watcherAlertActionBusy(alert: WatcherAlert, action: string): boolean {
    return this.activeWatcherAlertActionId === `${alert.id}:${action}`;
  }

  async applyWatcherAlertAction(alert: WatcherAlert, action: string): Promise<void> {
    if (!alert.id || this.activeWatcherAlertActionId) return;
    this.activeWatcherAlertActionId = `${alert.id}:${action}`;
    try {
      await firstValueFrom(this.api.watcherAlertAction(alert.id, action, { reason: "operator_broker_alert_lifecycle" }));
      await this.loadOps(false);
      this.notice = `Alert ${this.watcherAlertActionLabel(action).toLowerCase()} requested.`;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeWatcherAlertActionId = "";
      this.renderNow();
    }
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

  private brokerInstanceVisible(instance: ReleaseInstance): boolean {
    const instanceSearch = this.brokerInstanceMatchesSearch(instance);
    const instanceView = this.brokerInstanceMatchesSavedView(instance);
    const rows = this.brokerThreads(instance);
    const hasVisibleRow = rows.some((row) => {
      const searchMatch = instanceSearch || this.brokerThreadRowMatchesSearch(row);
      const viewMatch = instanceView || this.brokerThreadRowMatchesSavedView(row);
      return searchMatch && viewMatch;
    });
    return (instanceSearch && instanceView) || hasVisibleRow;
  }

  private brokerInstanceMatchesSearch(instance: ReleaseInstance): boolean {
    const route = this.brokerInstanceRoute(instance);
    const vm = this.brokerTenantVm(instance);
    return this.brokerMatchesSearch([
      instance.id,
      instance.displayName,
      instance.kind,
      instance.source,
      instance.sourceId,
      instance.status,
      instance.serviceName,
      instance.home,
      instance.deployRoot,
      instance.ref,
      instance.channel,
      instance.baseUrl,
      instance.healthUrl,
      instance.versionUrl,
      this.releaseInstanceVersion(instance),
      this.releaseInstanceTargetVersion(instance),
      this.releaseInstanceCommit(instance),
      this.releaseInstanceMeta(instance),
      this.releaseInstanceInfraLabel(instance),
      this.releaseInstanceHealthLabel(instance),
      this.releaseInstanceDowntimeLabel(instance),
      this.brokerRemoteStatus(instance),
      route?.chatId,
      route?.chatName,
      route?.accountId,
      route?.routeMode,
      route?.target,
      route?.diagnostics?.nextAction,
      vm?.id,
      vm?.displayName,
      vm?.ownerUserId,
      vm?.endpoint?.baseUrl,
      vm?.endpoint?.brokerBaseUrl,
      this.jsonLine(instance.labels || {}),
    ]);
  }

  private brokerThreadRowMatchesSearch(row: BrokerThreadRow): boolean {
    return this.brokerMatchesSearch([
      row.id,
      row.label,
      row.state,
      row.threadId,
      row.codexThreadId,
      row.chatId,
      row.chatName,
      row.bindingId,
      row.accountIds.join(" "),
      row.aclLabel,
      row.sendAclMode,
      row.queueLabel,
      row.outboxLabel,
      row.runtimeLabel,
      row.unansweredLabel,
      row.remoteStatus,
      row.localThread?.ownerUserId,
      row.localThread?.name,
      row.localThread?.title,
      row.localThread?.bindingName,
      row.localThread?.repoPath,
      row.localThread?.branchName,
      row.latestAlert?.code,
      row.latestAlert?.message,
    ]);
  }

  private brokerAlertMatchesSearch(alert: WatcherAlert): boolean {
    return this.brokerMatchesSearch([
      alert.id,
      alert.severity,
      alert.source,
      alert.code,
      alert.message,
      alert.status,
      alert.threadId,
      alert.messageId,
      alert.routerTraceId,
      alert.watcherThreadId,
      this.jsonLine(alert.details || {}),
    ]);
  }

  private brokerMatchesSearch(values: Array<unknown>): boolean {
    const tokens = this.brokerSearchTokens();
    if (!tokens.length) return true;
    const haystack = values.map((value) => String(value || "").toLowerCase()).join(" ");
    return tokens.every((token) => haystack.includes(token));
  }

  private brokerSearchTokens(): string[] {
    return this.brokerSearchText
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private brokerInstanceMatchesSavedView(instance: ReleaseInstance): boolean {
    const view = this.brokerSavedViewId;
    if (view === "all") return true;
    if (view === "down") return this.releaseInstanceStatusClass(instance) === "bad" || String(instance.downtime?.state || "").toLowerCase() === "down";
    if (view === "rollout-ready") return instance.releaseTrainEnabled === true && instance.hasDeployCommand === true;
    if (view === "wa-issues") return this.brokerRemoteStatusClass(instance) === "bad";
    if (view === "unanswered") return false;
    if (view === "alerts") return false;
    return true;
  }

  private brokerThreadRowMatchesSavedView(row: BrokerThreadRow): boolean {
    const view = this.brokerSavedViewId;
    if (view === "all" || view === "down" || view === "rollout-ready") return true;
    if (view === "unanswered") return row.hasUnanswered;
    if (view === "alerts") return Boolean(row.latestAlert);
    if (view === "wa-issues") {
      const outbox = row.outboxLabel.toLowerCase();
      const remoteStatus = String(row.remoteStatus || "").toLowerCase();
      return row.hasUnanswered || Boolean(row.latestAlert) || outbox.includes("failed") || outbox.includes("pending") || remoteStatus.includes("missing") || remoteStatus.includes("auth") || remoteStatus.includes("token");
    }
    return true;
  }

  private brokerAlertMatchesSavedView(alert: WatcherAlert): boolean {
    if (this.brokerSavedViewId === "all" || this.brokerSavedViewId === "alerts") return true;
    if (this.brokerSavedViewId === "wa-issues") {
      const text = this.jsonLine(alert).toLowerCase();
      return text.includes("whatsapp") || text.includes("outbox") || text.includes("account") || text.includes("connector");
    }
    if (this.brokerSavedViewId === "unanswered") {
      const text = this.jsonLine(alert).toLowerCase();
      return text.includes("unanswered") || text.includes("thread");
    }
    if (this.brokerSavedViewId === "down") {
      const text = this.jsonLine(alert).toLowerCase();
      return text.includes("down") || text.includes("unreachable") || text.includes("failed");
    }
    return false;
  }

  saveBrokerViewState(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem("orkestr.ops.broker.search", this.brokerSearchText);
      localStorage.setItem("orkestr.ops.broker.view", this.brokerSavedViewId);
    } catch {
      // Browser storage can be disabled in hardened operator sessions.
    }
  }

  private loadBrokerViewState(): void {
    if (typeof localStorage === "undefined") return;
    try {
      this.brokerSearchText = localStorage.getItem("orkestr.ops.broker.search") || "";
      const view = localStorage.getItem("orkestr.ops.broker.view") || "";
      if (this.brokerSavedViews.some((candidate) => candidate.id === view)) {
        this.brokerSavedViewId = view as BrokerSavedViewId;
      }
    } catch {
      this.brokerSearchText = "";
      this.brokerSavedViewId = "all";
    }
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
      identity.externalId ? `identity ${identity.externalId}` : "",
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

  private applyReleaseInstances(payload: ReleaseInstancesResponse): void {
    this.opsReleaseInstances = payload.instances || [];
    this.opsReleaseCounts = payload.counts || {};
    this.opsReleaseGeneratedAt = payload.generatedAt || "";
    this.opsReleaseError = "";
  }

  private applyReleaseInstancesError(error: unknown): void {
    this.opsReleaseInstances = [];
    this.opsReleaseCounts = {};
    this.opsReleaseGeneratedAt = "";
    this.opsReleaseError = this.errorText(error);
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
