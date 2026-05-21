import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, OutlookOAuthPollResponse, OutlookOAuthStartResponse, SecurityChallenge, SetupStatus, SystemDoctorResponse, ThreadSummary, VersionResponse } from "./api.service";

type ConnectorStep = "openai" | "codex" | "gmail" | "linkedin" | "whatsapp" | "browsers";
type OnboardingStep = "goal" | "system" | "security" | ConnectorStep | "finish";
type OnboardingGoalId = "whatsapp-codex" | "virtual-desktop" | "inbox-summary";
type SetupPageMode = "setup" | "onboarding";
type MailProvider = "gmail" | "outlook";

interface MailAccountRow {
  provider: MailProvider;
  label: string;
  account: string;
  state: string;
  summary: string;
}

interface OnboardingGoal {
  id: OnboardingGoalId;
  label: string;
  eyebrow: string;
  summary: string;
  recommended?: boolean;
  requiredSteps: ConnectorStep[];
}

@Component({
  selector: "ork-onboarding-page",
  imports: [FormsModule],
  templateUrl: "./onboarding-page.component.html",
  styleUrls: ["./onboarding-page.component.css"],
})
export class OnboardingPageComponent implements OnInit, OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly storageKey = "orkestr:onboarding";
  private poller?: ReturnType<typeof setInterval>;
  private outlookPoller?: ReturnType<typeof setInterval>;

  @Input() mode: SetupPageMode = "onboarding";
  @Input() setupSection = "";
  @Output() skip = new EventEmitter<void>();
  @Output() complete = new EventEmitter<void>();
  @Output() setupSectionChange = new EventEmitter<string>();
  @Output() paired = new EventEmitter<void>();

  setup: SetupStatus | null = null;
  doctor: SystemDoctorResponse | null = null;
  versionInfo: VersionResponse | null = null;
  busy = false;
  error = "";
  notice = "";
  oauthUrl = "";
  activeStep: OnboardingStep = "goal";
  selectedGoal: OnboardingGoalId = "whatsapp-codex";
  firstThread: ThreadSummary | null = null;
  whatsappChatId = "";
  whatsappChatName = "";
  testMessage = "Hello from Orkestr onboarding.";
  securityPairingCode = "";
  securityChallenges: SecurityChallenge[] = [];
  codexDeviceCode = "";
  codexAuthUrl = "";
  codexAuthExpiresAt = "";
  codexApiKey = "";

  openaiApiKey = "";
  mailProvider: MailProvider = "gmail";
  gmailAccount = "";
  gmailClientId = "";
  gmailClientSecret = "";
  gmailRedirectUri = this.defaultGmailRedirectUri();
  outlookAccount = "";
  outlookClientId = "";
  outlookTenantId = "common";
  outlookScopes = "offline_access User.Read Mail.Read";
  outlookDevice: OutlookOAuthStartResponse | OutlookOAuthPollResponse | null = null;
  private formHydrated = false;
  private stepInitialized = false;

  readonly whatsappAccounts = [
    { id: "account-1", label: "WhatsApp sender" },
    { id: "account-2", label: "WhatsApp receiver" },
  ];

  readonly goals: OnboardingGoal[] = [
    {
      id: "whatsapp-codex",
      label: "Codex from WhatsApp",
      eyebrow: "Recommended",
      summary: "Send work from WhatsApp and mirror Codex replies back to the chat.",
      recommended: true,
      requiredSteps: ["codex", "whatsapp"],
    },
    {
      id: "virtual-desktop",
      label: "Managed browser desktop",
      eyebrow: "Browser work",
      summary: "Prepare a leased Chrome desktop for agent web work and sign-in state.",
      requiredSteps: ["codex", "browsers", "whatsapp"],
    },
    {
      id: "inbox-summary",
      label: "Mail summaries",
      eyebrow: "Daily brief",
      summary: "Connect Gmail or Outlook and schedule summaries back to WhatsApp.",
      requiredSteps: ["openai", "gmail", "whatsapp"],
    },
  ];

  readonly connectorSteps: Array<{ id: ConnectorStep; label: string; eyebrow: string }> = [
    { id: "openai", label: "OpenAI", eyebrow: "Model access" },
    { id: "codex", label: "Codex", eyebrow: "Local agent" },
    { id: "gmail", label: "Mail", eyebrow: "Inbox" },
    { id: "linkedin", label: "LinkedIn", eyebrow: "Browser" },
    { id: "whatsapp", label: "WhatsApp", eyebrow: "Messages" },
    { id: "browsers", label: "Desktops", eyebrow: "Browser runtime" },
  ];

  ngOnInit(): void {
    this.restoreProgress();
    void this.load();
    this.poller = setInterval(() => void this.load(false), 30_000);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["mode"] || changes["setupSection"]) {
      this.applySetupSectionFromInput();
      this.ensureActiveStepAvailable();
    }
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
    if (this.outlookPoller) clearInterval(this.outlookPoller);
  }

  async load(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [setupResult, doctorResult, versionResult] = await Promise.allSettled([
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.systemDoctor()),
        firstValueFrom(this.api.version()),
      ]);
      if (setupResult.status === "rejected") throw setupResult.reason;
      const setup = setupResult.value;
      this.setup = setup;
      this.doctor = doctorResult.status === "fulfilled" ? doctorResult.value : null;
      this.versionInfo = versionResult.status === "fulfilled" ? versionResult.value : this.versionInfo;
      this.hydrateForms(setup);
      if (setup.security?.paired) await this.loadSecurityChallenges(false);
      else this.securityChallenges = [];
      if (!this.stepInitialized) {
        this.activeStep = this.firstOpenStep();
        this.stepInitialized = true;
      }
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async saveOpenAI(): Promise<void> {
    const openaiApiKey = this.openaiApiKey.trim();
    if (!openaiApiKey) {
      this.error = "Paste an OpenAI API key before saving.";
      return;
    }
    await this.saveConnector("openai", { openaiApiKey }, "OpenAI settings saved.");
    this.openaiApiKey = "";
  }

  async saveGmail(): Promise<void> {
    const clientId = this.gmailClientId.trim();
    const clientSecret = this.gmailClientSecret.trim();
    const redirectUri = this.gmailRedirectUri.trim();
    if (!clientId || !redirectUri) {
      this.error = "Gmail needs a client ID and redirect URI.";
      return;
    }
    const body: Record<string, string> = { clientId, redirectUri };
    if (this.gmailAccount.trim()) body["account"] = this.gmailAccount.trim();
    if (clientSecret) body["clientSecret"] = clientSecret;
    await this.saveConnector("gmail", body, "Gmail OAuth settings saved.");
    this.gmailClientSecret = "";
  }

  async submitGmailAuth(): Promise<void> {
    await this.saveGmail();
    if (this.error) return;
    await this.startGmailOAuth();
  }

  async startGmailOAuth(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.startGmailOAuth(this.gmailAccount));
      this.oauthUrl = result.authorizeUrl;
      globalThis.open?.(result.authorizeUrl, "_blank", "noopener,noreferrer");
      this.notice = "Google sign-in opened in a new tab.";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async saveOutlook(): Promise<void> {
    const clientId = this.outlookClientId.trim();
    const tenantId = this.outlookTenantId.trim() || "common";
    const scopes = this.outlookScopes.trim() || "offline_access User.Read Mail.Read";
    if (!clientId) {
      this.error = "Outlook needs a Microsoft application client ID.";
      return;
    }
    const body: Record<string, string> = { clientId, tenantId, scopes };
    if (this.outlookAccount.trim()) body["account"] = this.outlookAccount.trim();
    await this.saveConnector("outlook", body, "Outlook app registration saved.");
  }

  async submitOutlookAuth(): Promise<void> {
    await this.saveOutlook();
    if (this.error) return;
    await this.startOutlookOAuth();
  }

  async startOutlookOAuth(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.startOutlookOAuth(this.outlookAccount));
      this.outlookDevice = result;
      this.notice = "Microsoft sign-in is ready. Enter the device code in the Microsoft page.";
      this.error = "";
      this.openOutlookDevicePage();
      this.startOutlookPolling(Number(result.interval || 5));
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async pollOutlookOAuth(): Promise<void> {
    const pendingId = this.outlookDevice?.pendingId;
    if (!pendingId) return;
    try {
      const result = await firstValueFrom(this.api.pollOutlookOAuth(pendingId));
      this.outlookDevice = { ...this.outlookDevice, ...result };
      if (result.ok) {
        if (this.outlookPoller) clearInterval(this.outlookPoller);
        this.outlookPoller = undefined;
        this.notice = "Outlook sign-in connected.";
        this.error = "";
        await this.load(false);
      }
    } catch (error) {
      if (this.outlookPoller) clearInterval(this.outlookPoller);
      this.outlookPoller = undefined;
      this.error = this.errorText(error);
    }
  }

  openOutlookDevicePage(): void {
    const url = this.outlookDevice?.verificationUriComplete || this.outlookDevice?.verificationUri;
    if (url) globalThis.open?.(url, "_blank", "noopener,noreferrer");
  }

  private startOutlookPolling(intervalSeconds = 5): void {
    if (this.outlookPoller) clearInterval(this.outlookPoller);
    const intervalMs = Math.max(5, Number(intervalSeconds) || 5) * 1000;
    this.outlookPoller = setInterval(() => void this.pollOutlookOAuth(), intervalMs);
    void this.pollOutlookOAuth();
  }

  async prepareLinkedIn(): Promise<void> {
    await this.browserAction("linkedin", "prepare", "LinkedIn browser profile prepared.");
  }

  async openLinkedIn(): Promise<void> {
    await this.browserAction("linkedin", "start", "LinkedIn browser requested.");
  }

  async prepareVirtualDesktop(): Promise<void> {
    await this.browserAction("desktop", "prepare", "Desktop profile prepared.");
  }

  async openVirtualDesktop(): Promise<void> {
    await this.browserAction("desktop", "start", "Desktop requested.");
  }

  connector(id: string): ConnectorStatus | null {
    return this.setup?.connectors?.find((connector) => connector.id === id) || null;
  }

  connectorDetail(id: string, key: string): string {
    const value = this.connector(id)?.details?.[key];
    return value === null || value === undefined ? "" : String(value);
  }

  gmailStatusLabel(): string {
    if (this.mailProviderHasAccounts("gmail")) return "connected";
    const state = this.connector("gmail")?.state;
    if (!state) return "not connected";
    return String(state).replace(/_/g, " ");
  }

  gmailStatusClass(): string {
    if (this.mailProviderHasAccounts("gmail")) return "ready";
    return this.stateClass("gmail");
  }

  outlookStatusLabel(): string {
    if (this.mailProviderHasAccounts("outlook")) return "connected";
    const state = this.connector("outlook")?.state;
    if (!state) return "not connected";
    return String(state).replace(/_/g, " ");
  }

  outlookStatusClass(): string {
    if (this.mailProviderHasAccounts("outlook")) return "ready";
    return this.stateClass("outlook");
  }

  mailStatusLabel(): string {
    const accounts = this.mailAccountRows();
    if (accounts.length === 1) return "1 mailbox connected";
    if (accounts.length > 1) return `${accounts.length} mailboxes connected`;
    if (this.connector("gmail")?.state === "connected") return "Gmail connected";
    if (this.connector("outlook")?.state === "connected") return "Outlook connected";
    if (this.mailDone()) return "configured";
    return "not connected";
  }

  mailStatusClass(): string {
    if (this.mailAccountRows().length) return "ready";
    if (this.connector("gmail")?.state === "connected" || this.connector("outlook")?.state === "connected") return "ready";
    if (this.mailDone()) return "partial";
    if (["broken", "failed"].includes(String(this.connector("gmail")?.state || "")) || ["broken", "failed"].includes(String(this.connector("outlook")?.state || ""))) return "bad";
    return "idle";
  }

  mailDone(): boolean {
    if (this.mailAccountRows().length) return true;
    return ["connected", "partial"].includes(String(this.connector("gmail")?.state || "")) ||
      ["connected", "partial"].includes(String(this.connector("outlook")?.state || ""));
  }

  mailAccountRows(provider?: MailProvider): MailAccountRow[] {
    const providers: MailProvider[] = provider ? [provider] : ["gmail", "outlook"];
    return providers.flatMap((item) => this.mailAccountRowsFor(item));
  }

  mailAccountKey(account: MailAccountRow): string {
    return `${account.provider}:${account.account || account.label}`;
  }

  mailAccountStateClass(account: MailAccountRow): string {
    const state = String(account.state || "").toLowerCase();
    if (state === "connected" || state === "ok") return "ready";
    if (state === "partial" || state === "configured") return "partial";
    if (state === "broken" || state === "failed" || state === "error") return "bad";
    return "idle";
  }

  mailAccountCountLabel(): string {
    const accounts = this.mailAccountRows();
    if (!accounts.length) return "No mailboxes connected";
    const gmail = accounts.filter((account) => account.provider === "gmail").length;
    const outlook = accounts.filter((account) => account.provider === "outlook").length;
    const parts = [];
    if (gmail) parts.push(`${gmail} Gmail`);
    if (outlook) parts.push(`${outlook} Outlook`);
    return parts.join(" · ");
  }

  mailProviderLabel(provider: MailProvider = this.mailProvider): string {
    return provider === "gmail" ? "Gmail" : "Outlook";
  }

  mailProviderHasAccounts(provider: MailProvider = this.mailProvider): boolean {
    return this.mailAccountRows(provider).length > 0;
  }

  mailProviderAccountCountLabel(provider: MailProvider = this.mailProvider): string {
    const count = this.mailAccountRows(provider).length;
    const label = this.mailProviderLabel(provider);
    if (count === 1) return `1 connected ${label} mailbox`;
    return `${count} connected ${label} mailboxes`;
  }

  mailProviderActionTitle(provider: MailProvider = this.mailProvider): string {
    const label = this.mailProviderLabel(provider);
    return this.mailProviderHasAccounts(provider) ? `Add another ${label} login` : `Connect ${label}`;
  }

  mailProviderActionHint(provider: MailProvider = this.mailProvider): string {
    const label = this.mailProviderLabel(provider);
    if (this.mailProviderHasAccounts(provider)) {
      return `${label} is already connected in this runtime. Fill these OAuth fields only when you want to add another mailbox.`;
    }
    if (provider === "gmail") return "Orkestr stores tokens and client secrets under the local Orkestr home, outside public config.";
    return "Use tenant common for personal Microsoft accounts and most self-hosted OSS installs.";
  }

  mailProviderCredentialHint(provider: MailProvider = this.mailProvider): string {
    if (provider === "gmail") {
      return "App credentials identify your Google Cloud OAuth client. They are shared by this Orkestr install and are different from the mailbox you sign in with.";
    }
    return "App credentials identify your Microsoft Entra app registration. They are shared by this Orkestr install and are different from the mailbox you sign in with.";
  }

  mailProviderMailboxHint(provider: MailProvider = this.mailProvider): string {
    const label = this.mailProviderLabel(provider);
    return `The mailbox field is optional. Use it to label or target a specific ${label} account; the actual account is chosen during sign-in.`;
  }

  mailProviderStatusTitle(provider: MailProvider = this.mailProvider): string {
    const rows = this.mailAccountRows(provider);
    if (rows.length === 1) return rows[0]?.label || rows[0]?.account || `${this.mailProviderLabel(provider)} mailbox`;
    if (rows.length > 1) return `${this.mailProviderLabel(provider)} mailboxes`;
    return provider === "gmail" ? (this.gmailAccount || "Gmail mailbox") : (this.outlookAccount || "Outlook mailbox");
  }

  mailProviderSummary(provider: MailProvider = this.mailProvider): string {
    const rows = this.mailAccountRows(provider);
    const label = this.mailProviderLabel(provider);
    if (rows.length) {
      const names = rows.map((row) => row.account || row.label).filter(Boolean);
      const shown = names.slice(0, 3).join(", ");
      const extra = names.length > 3 ? `, +${names.length - 3} more` : "";
      return `${this.mailProviderAccountCountLabel(provider)} available${shown ? `: ${shown}${extra}` : "."}`;
    }
    return this.connector(provider)?.summary || `No ${label} status loaded.`;
  }

  mailProviderCredentialState(provider: MailProvider = this.mailProvider): string {
    if (provider === "gmail" && this.gmailClientId.trim()) return "configured";
    if (provider === "outlook" && this.outlookClientId.trim()) return "configured";
    if (this.mailProviderHasAccounts(provider)) return "optional";
    return "missing";
  }

  mailProviderAuthButtonLabel(provider: MailProvider = this.mailProvider): string {
    const label = this.mailProviderLabel(provider);
    return this.mailProviderHasAccounts(provider) ? `Add another ${label} Auth` : `Start ${label} Auth`;
  }

  mailSummary(): string {
    const accounts = this.mailAccountRows();
    if (accounts.length) return `${this.mailAccountCountLabel()} connected`;
    const gmail = this.connector("gmail")?.summary;
    const outlook = this.connector("outlook")?.summary;
    if (gmail && outlook) return `Gmail: ${gmail} Outlook: ${outlook}`;
    return gmail || outlook || "Connect Gmail or Outlook with your own OAuth app.";
  }

  mailSystemState(): string {
    const count = this.mailAccountRows().length;
    if (count === 1) return "1 account";
    if (count > 1) return `${count} accounts`;
    return this.mailStatusLabel();
  }

  gmailConfigSummary(): string {
    if (this.mailProviderHasAccounts("gmail")) return this.mailProviderAccountCountLabel("gmail");
    if (!this.gmailClientId.trim()) return "OAuth client is not configured.";
    return this.gmailRedirectUri.trim() || this.defaultGmailRedirectUri();
  }

  outlookConfigSummary(): string {
    if (this.mailProviderHasAccounts("outlook")) return this.mailProviderAccountCountLabel("outlook");
    if (!this.outlookClientId.trim()) return "Microsoft app is not configured.";
    return `Tenant ${this.outlookTenantId.trim() || "common"}`;
  }

  stateLabel(id: string): string {
    return String(this.connector(id)?.state || "not_connected").replace(/_/g, " ");
  }

  stateClass(id: string): string {
    const state = String(this.connector(id)?.state || "").toLowerCase();
    if (state === "connected") return "ready";
    if (state === "partial") return "partial";
    if (state === "broken" || state === "failed") return "bad";
    return "idle";
  }

  stepStateLabel(id: OnboardingStep): string {
    if (id === "goal") return this.selectedGoal ? "selected" : "choose";
    if (id === "system") return this.setup ? "checked" : "checking";
    if (id === "security") return this.securityStepLabel();
    if (id === "finish") return this.goalRequiredSteps().every((step) => this.stepDone(step)) ? "ready" : "review";
    if (id === "gmail") return this.mailStatusLabel();
    return this.stateLabel(id);
  }

  stepStateClass(id: OnboardingStep): string {
    if (id === "goal") return this.selectedGoal ? "ready" : "idle";
    if (id === "system") return this.setup ? "ready" : "idle";
    if (id === "security") return this.securityStepClass();
    if (id === "finish") return this.goalRequiredSteps().every((step) => this.stepDone(step)) ? "ready" : "partial";
    if (id === "gmail") return this.mailStatusClass();
    return this.stateClass(id);
  }

  stepDone(id: OnboardingStep): boolean {
    if (id === "goal") return Boolean(this.selectedGoal);
    if (id === "system") return Boolean(this.setup);
    if (id === "security") return this.securityDone();
    if (id === "finish") return this.goalRequiredSteps().every((step) => this.stepDone(step));
    if (id === "gmail") return this.mailDone();
    const state = this.connector(id)?.state;
    return state === "connected" || state === "partial";
  }

  setupReady(): boolean {
    return this.setup?.setupState === "ready";
  }

  isSetupMode(): boolean {
    return this.mode === "setup";
  }

  isOnboardingMode(): boolean {
    return this.mode === "onboarding";
  }

  pageTitle(): string {
    return this.isSetupMode() ? "Setup" : "Set up Orkestr";
  }

  pageSummary(): string {
    return this.isSetupMode()
      ? "Setup stays available after onboarding so you can check secure access, accounts, runtimes, and connectors at any time."
      : "Orkestr runs persistent Codex threads, workspaces, WhatsApp, mail, timers, and managed browser desktops on infrastructure you control.";
  }

  pageEyebrow(): string {
    return this.isSetupMode() ? "Orkestr setup" : "Self-hosted agent cockpit";
  }

  buildStamp(): string {
    if (!this.versionInfo) return "";
    const version = String(this.versionInfo.version || "").trim();
    const commit = String(this.versionInfo.commit || "").trim();
    const branch = String(this.versionInfo.branch || "").trim();
    return [`v${version || "0.0.0"}`, commit ? commit.slice(0, 7) : "", branch].filter(Boolean).join(" · ");
  }

  closeLabel(): string {
    return this.isSetupMode() ? "Back to cockpit" : "Skip to cockpit";
  }

  activeStepIndex(): number {
    return Math.max(0, this.pageSections().findIndex((step) => step.id === this.activeStep));
  }

  activeStepLabel(): string {
    return this.pageSections()[this.activeStepIndex()]?.label || "";
  }

  progressPercent(): number {
    return ((this.activeStepIndex() + 1) / this.activeSteps().length) * 100;
  }

  completedStepCount(): number {
    return this.pageSections().filter((step) => this.stepDone(step.id)).length;
  }

  isFirstStep(): boolean {
    return this.activeStepIndex() === 0;
  }

  isLastStep(): boolean {
    return this.activeStepIndex() === this.pageSections().length - 1;
  }

  activeSteps(): Array<{ id: OnboardingStep; label: string; eyebrow: string }> {
    const byId = Object.fromEntries(this.connectorSteps.map((step) => [step.id, step]));
    return [
      { id: "goal", label: "Start with one capability", eyebrow: "Start here" },
      { id: "system", label: "Connections", eyebrow: "Runtime" },
      { id: "security", label: "Secure access", eyebrow: "Remote safety" },
      ...this.goalRequiredSteps().map((id) => byId[id]),
      { id: "finish", label: "Ready to run", eyebrow: "Starter thread" },
    ];
  }

  setupSections(): Array<{ id: OnboardingStep; label: string; eyebrow: string }> {
    return [
      { id: "system", label: "Connections", eyebrow: "Runtime" },
      { id: "security", label: "Security", eyebrow: "Remote access" },
      ...this.connectorSteps,
    ];
  }

  pageSections(): Array<{ id: OnboardingStep; label: string; eyebrow: string }> {
    return this.isSetupMode() ? this.setupSections() : this.activeSteps();
  }

  activeGoal(): OnboardingGoal {
    return this.goals.find((goal) => goal.id === this.selectedGoal) || this.goals[0];
  }

  goalRequiredSteps(): ConnectorStep[] {
    return this.activeGoal().requiredSteps;
  }

  selectGoal(goalId: OnboardingGoalId): void {
    this.selectedGoal = goalId;
    if (!this.pageSections().some((step) => step.id === this.activeStep)) this.activeStep = this.isSetupMode() ? "system" : "goal";
    this.persistProgress();
  }

  systemChecks(): Array<{ label: string; state: string; summary: string; className: string }> {
    const doctorChecks = this.doctor?.checks || [];
    if (doctorChecks.length) {
      return doctorChecks.map((check) => ({
        label: check.label || check.id,
        state: check.status === "ok" ? "ready" : check.status === "error" ? "needs fix" : "review",
        summary: [check.summary, check.repair ? `Fix: ${check.repair}` : ""].filter(Boolean).join(" "),
        className: this.doctorStatusClass(check.status),
      }));
    }
    return [
      {
        label: "Orkestr home",
        state: this.setup?.home ? "ready" : "checking",
        summary: this.setup?.home || "Waiting for Orkestr home",
        className: this.setup?.home ? "ready" : "idle",
      },
      {
        label: "Codex runtime",
        state: this.stateLabel("codex"),
        summary: this.connector("codex")?.summary || "Checking Codex",
        className: this.stateClass("codex"),
      },
      {
        label: "Chrome browser",
        state: this.stateLabel("browsers"),
        summary: this.connector("browsers")?.summary || "Checking browser runtime",
        className: this.stateClass("browsers"),
      },
      {
        label: "WhatsApp bridge",
        state: this.stateLabel("whatsapp"),
        summary: this.connector("whatsapp")?.summary || "Checking local bridge",
        className: this.stateClass("whatsapp"),
      },
      {
        label: "Mail auth",
        state: this.mailSystemState(),
        summary: this.mailSummary(),
        className: this.mailStatusClass(),
      },
    ];
  }

  private doctorStatusClass(status = ""): string {
    if (status === "ok") return "ready";
    if (status === "error") return "bad";
    if (status === "warning") return "partial";
    return "idle";
  }

  securityChecks(): Array<{ label: string; state: string; summary: string; className: string }> {
    const security = this.setup?.security || {};
    const bindHost = security.bindHost || "127.0.0.1";
    const dockerHostBind = security.dockerHostBind || "127.0.0.1";
    const bindIsSafe = Boolean(security.externallyLocal || security.bindLocal);
    return [
      {
        label: "Bind address",
        state: security.proxyLocalBind ? "proxied" : security.bindLocal ? "local" : "remote",
        summary: security.proxyLocalBind ? `Container bind ${bindHost}; host publishes ${dockerHostBind}` : security.bindLocal ? `Bound to ${bindHost}` : `Bound to ${bindHost || "non-local address"}`,
        className: bindIsSafe ? "ready" : "bad",
      },
      {
        label: "Caddy",
        state: security.caddy?.installed ? "installed" : "missing",
        summary: security.caddy?.version || security.caddy?.error || "Install Caddy before exposing Orkestr remotely",
        className: security.caddy?.installed ? "ready" : "idle",
      },
      {
        label: "Tailscale HTTPS",
        state: security.https?.configured ? "configured" : security.tailscale?.installed ? "available" : "missing",
        summary: security.https?.url || security.tailscale?.version || security.tailscale?.error || "Use Tailscale and HTTPS for remote access",
        className: security.https?.configured ? "ready" : security.tailscale?.installed ? "partial" : "idle",
      },
      {
        label: "Browser pairing",
        state: security.paired ? "paired" : security.authEnabled ? "required" : "optional",
        summary: security.paired ? `${security.sessionCount || 1} paired browser session` : "Pair this browser before enabling remote access",
        className: security.paired ? "ready" : security.authEnabled ? "partial" : "idle",
      },
    ];
  }

  securityWarnings(): string[] {
    return this.setup?.security?.warnings || [];
  }

  securityDone(): boolean {
    const security = this.setup?.security;
    if (!security) return false;
    return Boolean(security.remoteReady || security.externallyLocal || security.bindLocal);
  }

  securityStepLabel(): string {
    const security = this.setup?.security;
    if (!security) return "checking";
    if (security.remoteReady) return "ready";
    if (security.authEnabled && !security.paired) return "pair browser";
    if (!security.externallyLocal && !security.bindLocal) return "review";
    return "local";
  }

  securityStepClass(): string {
    const security = this.setup?.security;
    if (!security) return "idle";
    if (security.remoteReady || security.externallyLocal || security.bindLocal) return "ready";
    if (security.authEnabled || security.https?.configured || security.caddy?.installed) return "partial";
    return "bad";
  }

  async createSecurityChallenge(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.createSecurityChallenge());
      this.notice = `Pairing challenge ${result.challengeId} generated. Approve it from SSH or an already paired browser.`;
      this.error = "";
      await this.loadSecurityChallenges(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async loadSecurityChallenges(showBusy = true): Promise<void> {
    if (!this.setup?.security?.paired) return;
    if (showBusy) this.busy = true;
    try {
      const result = await firstValueFrom(this.api.securityChallenges());
      this.securityChallenges = result.challenges || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = false;
    }
  }

  async approveSecurityChallenge(challenge: SecurityChallenge): Promise<void> {
    if (!challenge.id) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.approveSecurityChallenge(challenge.id));
      this.notice = `Approved pairing challenge ${challenge.id}.`;
      this.error = "";
      await this.loadSecurityChallenges(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async rejectSecurityChallenge(challenge: SecurityChallenge): Promise<void> {
    if (!challenge.id) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.rejectSecurityChallenge(challenge.id));
      this.notice = `Rejected pairing challenge ${challenge.id}.`;
      this.error = "";
      await this.loadSecurityChallenges(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  pendingSecurityChallenges(): SecurityChallenge[] {
    return this.securityChallenges.filter((challenge) => challenge.status === "pending");
  }

  challengeTime(value: string | undefined): string {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown";
  }

  challengeRequester(challenge: SecurityChallenge): string {
    return [challenge.requestedIp, challenge.requestedUserAgent].filter(Boolean).join(" - ") || "unknown browser";
  }

  async pairSecurityBrowser(): Promise<void> {
    const challengeId = this.securityPairingCode.trim();
    if (!challengeId) {
      this.error = "Enter the browser pairing challenge ID.";
      return;
    }
    this.busy = true;
    try {
      await firstValueFrom(this.api.pairSecurityBrowser(challengeId));
      this.securityPairingCode = "";
      this.notice = "This browser is paired.";
      this.error = "";
      await this.load(false);
      this.paired.emit();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async startCodexDeviceAuth(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.startCodexDeviceAuth());
      this.codexDeviceCode = result.code || "";
      this.codexAuthUrl = result.authUrl || "";
      this.codexAuthExpiresAt = result.expiresAt || "";
      if (this.codexAuthUrl) globalThis.open?.(this.codexAuthUrl, "_blank", "noopener,noreferrer");
      this.notice = this.codexDeviceCode ? "Codex sign-in opened. Enter the device code in the browser." : "Codex sign-in started.";
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async connectCodexApiKey(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.loginCodexWithApiKey(this.codexApiKey));
      this.codexApiKey = "";
      this.notice = result.message || "Codex API key login completed.";
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  whatsappAccount(id: string): Record<string, unknown> {
    const accounts = this.connector("whatsapp")?.details?.["accounts"];
    if (!Array.isArray(accounts)) return {};
    return (accounts as Array<Record<string, unknown>>).find((account) => String(account["accountId"]) === id) || {};
  }

  whatsappAccountState(id: string): string {
    return String(this.whatsappAccount(id)["state"] || "idle").replace(/_/g, " ");
  }

  whatsappAccountPurpose(id: string): string {
    return id === "account-1"
      ? "Default outbound account for replies and test messages."
      : "Optional second account for receiving or isolating another WhatsApp login.";
  }

  whatsappAccountClass(id: string): string {
    const state = String(this.whatsappAccount(id)["state"] || "").toLowerCase();
    if (state === "ready") return "ready";
    if (["qr_needed", "starting", "authenticated"].includes(state)) return "partial";
    if (["failed", "auth_failure", "dependency_missing"].includes(state)) return "bad";
    return "idle";
  }

  whatsappAccountError(id: string): string {
    return String(this.whatsappAccount(id)["error"] || "");
  }

  whatsappQrUrl(id: string): string {
    const account = this.whatsappAccount(id);
    const url = String(account["qrUrl"] || "");
    const updatedAt = String(account["updatedAt"] || "");
    if (!url || !updatedAt) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(updatedAt)}`;
  }

  whatsappQrAvailable(id: string): boolean {
    return Boolean(this.whatsappQrUrl(id));
  }

  async startWhatsApp(accountId: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.saveConnectorConfig("whatsapp", { bridgeMode: "local", maxAccounts: "2" }));
      await firstValueFrom(this.api.startWhatsAppAccount(accountId));
      this.notice = `${this.whatsappAccountLabel(accountId)} is starting.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async logoutWhatsApp(accountId: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.logoutWhatsAppAccount(accountId));
      this.notice = `${this.whatsappAccountLabel(accountId)} disconnected.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async createFirstThread(): Promise<void> {
    this.busy = true;
    try {
      const thread = await this.ensureFirstThread();
      this.notice = `${thread.name || thread.id} is ready.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async prepareFirstLoop(): Promise<void> {
    await this.prepareStarterThread();
  }

  async prepareStarterThread(): Promise<void> {
    this.busy = true;
    try {
      const thread = await this.ensureFirstThread();
      const actions = ["thread"];
      if (this.goalRequiredSteps().includes("browsers")) {
        await firstValueFrom(this.api.browserAction("desktop", "prepare"));
        actions.push("desktop");
      }
      if (this.goalRequiredSteps().includes("whatsapp")) {
        await firstValueFrom(this.api.saveConnectorConfig("whatsapp", { bridgeMode: "local", maxAccounts: "2" }));
        await firstValueFrom(this.api.startWhatsAppAccount("account-1"));
        actions.push("WhatsApp sender");
      }
      this.notice = `${thread.name || thread.id} starter thread prepared: ${actions.join(", ")}.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async bindFirstThread(): Promise<void> {
    const chatId = this.whatsappChatId.trim();
    if (!chatId) {
      this.error = "Enter a WhatsApp chat ID before binding.";
      return;
    }
    this.busy = true;
    try {
      const thread = await this.ensureFirstThread();
      const result = await firstValueFrom(
        this.api.updateThreadBinding(thread.id, {
          connector: "whatsapp",
          chatId,
          displayName: this.whatsappChatName.trim() || this.firstThreadName(),
          enabled: true,
          allowOtherPeople: true,
          mirrorToWhatsApp: true,
          outboundAccountId: "account-1",
          replyPrefix: "orkestr:",
        }),
      );
      this.firstThread = result.thread;
      this.notice = `${this.firstThread.name || this.firstThread.id} is bound to WhatsApp.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async sendFirstTestMessage(): Promise<void> {
    const text = this.testMessage.trim();
    if (!text) {
      this.error = "Enter a test message before sending.";
      return;
    }
    this.busy = true;
    try {
      const thread = await this.ensureFirstThread();
      await firstValueFrom(this.api.sendThreadInput(thread.id, text));
      this.notice = `Queued a test message for ${thread.name || thread.id}.`;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  firstThreadName(): string {
    return `${this.activeGoal().label}`;
  }

  firstThreadId(): string {
    return `onboarding-${this.selectedGoal}`;
  }

  firstThreadBindingSummary(): string {
    const binding = this.firstThread?.binding;
    if (!binding?.chatId) return "No WhatsApp chat bound yet.";
    return `${binding.displayName || this.firstThread?.name || this.firstThread?.id} -> ${binding.chatId}`;
  }

  selectStep(id: OnboardingStep): void {
    if (!this.pageSections().some((step) => step.id === id)) return;
    this.activeStep = id;
    this.stepInitialized = true;
    this.persistProgress();
    if (this.isSetupMode()) this.setupSectionChange.emit(id);
  }

  previousStep(): void {
    const index = this.activeStepIndex();
    const steps = this.pageSections();
    if (index > 0) this.selectStep(steps[index - 1].id);
  }

  nextStep(): void {
    const index = this.activeStepIndex();
    const steps = this.pageSections();
    if (index < steps.length - 1) this.selectStep(steps[index + 1].id);
    else this.openApp();
  }

  openApp(): void {
    if (this.isSetupMode()) {
      this.skip.emit();
      return;
    }
    if (this.setupReady()) this.complete.emit();
    else this.skip.emit();
  }

  private async saveConnector(id: string, body: Record<string, string>, message: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.saveConnectorConfig(id, body));
      this.notice = message;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private async browserAction(slug: string, action: string, message: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.browserAction(slug, action));
      this.notice = message;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private async ensureFirstThread(): Promise<ThreadSummary> {
    const response = await firstValueFrom(
      this.api.createThread({
        id: this.firstThreadId(),
        name: this.firstThreadName(),
        title: this.firstThreadName(),
        bindingName: this.firstThreadName(),
        wakePolicy: "wake-on-message",
        executorId: "codex",
        codexMode: "code",
      }),
    );
    this.firstThread = response.thread;
    return response.thread;
  }

  private hydrateForms(setup: SetupStatus): void {
    if (this.formHydrated) return;
    const config = setup.config || {};
    const gmail = config["gmail"] || {};
    if (!this.gmailAccount && gmail["account"]) this.gmailAccount = String(gmail["account"]);
    if (!this.gmailClientId && gmail["clientId"]) this.gmailClientId = String(gmail["clientId"]);
    if (gmail["redirectUri"]) this.gmailRedirectUri = String(gmail["redirectUri"]);
    const outlook = config["outlook"] || {};
    if (!this.outlookAccount && outlook["account"]) this.outlookAccount = String(outlook["account"]);
    if (!this.outlookClientId && outlook["clientId"]) this.outlookClientId = String(outlook["clientId"]);
    if (outlook["tenantId"]) this.outlookTenantId = String(outlook["tenantId"]);
    if (outlook["scopes"]) this.outlookScopes = String(outlook["scopes"]);
    this.formHydrated = true;
  }

  private mailAccountRowsFor(provider: MailProvider): MailAccountRow[] {
    const connector = this.connector(provider);
    const details = connector?.details || {};
    const rows = this.mailRawAccounts(details).map((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      return {
        provider,
        label: this.mailAccountString(record["label"]) || this.mailAccountString(record["name"]) || this.mailAccountString(record["account"]) || this.mailAccountString(record["email"]) || `${provider} ${index + 1}`,
        account: this.mailAccountString(record["account"]) || this.mailAccountString(record["email"]) || this.mailAccountString(record["mailbox"]) || "",
        state: this.mailAccountString(record["state"]) || connector?.state || "connected",
        summary: this.mailAccountString(record["summary"]) || this.mailAccountString(record["source"]) || this.mailAccountString(record["runtime"]) || this.mailAccountString(record["kind"]) || connector?.summary || "",
      };
    }).filter((item) => item.label || item.account);
    if (rows.length) return rows;
    const account = this.mailAccountString(details["account"]) || this.mailAccountString(details["email"]) || this.mailAccountString(details["mailbox"]);
    if (!account) return [];
    return [{
      provider,
      label: account,
      account,
      state: connector?.state || "connected",
      summary: this.mailAccountString(details["runtime"]) || this.mailAccountString(details["kind"]) || connector?.summary || "",
    }];
  }

  private mailRawAccounts(details: Record<string, unknown>): unknown[] {
    const accounts = details["accounts"] || details["mailboxes"];
    return Array.isArray(accounts) ? accounts : [];
  }

  private mailAccountString(value: unknown): string {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  private whatsappAccountLabel(accountId: string): string {
    return this.whatsappAccounts.find((account) => account.id === accountId)?.label || accountId;
  }

  private firstOpenStep(): OnboardingStep {
    const steps = this.pageSections();
    const storedStep = steps.find((step) => step.id === this.activeStep)?.id;
    if (this.isSetupMode()) return storedStep || "system";
    return steps.find((step) => !this.stepDone(step.id))?.id || storedStep || "goal";
  }

  private ensureActiveStepAvailable(): void {
    if (this.pageSections().some((step) => step.id === this.activeStep)) return;
    this.activeStep = this.isSetupMode() ? "system" : "goal";
  }

  private applySetupSectionFromInput(): void {
    if (!this.isSetupMode()) return;
    const section = String(this.setupSection || "").trim().toLowerCase();
    const match = this.setupSections().find((step) => step.id === section);
    this.activeStep = match?.id || "system";
    this.stepInitialized = true;
  }

  private restoreProgress(): void {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { goal?: OnboardingGoalId; activeStep?: OnboardingStep };
      if (saved.goal && this.goals.some((goal) => goal.id === saved.goal)) this.selectedGoal = saved.goal;
      if (saved.activeStep && this.pageSections().some((step) => step.id === saved.activeStep)) {
        this.activeStep = saved.activeStep;
        this.stepInitialized = true;
      }
    } catch {
      // Ignore corrupt browser-local onboarding state.
    }
  }

  private persistProgress(): void {
    try {
      globalThis.localStorage?.setItem(
        this.storageKey,
        JSON.stringify({
          goal: this.selectedGoal,
          activeStep: this.activeStep,
        }),
      );
    } catch {
      // Storage is optional; onboarding still works without it.
    }
  }

  private renderNow(): void {
    try {
      this.cdr.detectChanges();
    } catch {
      // Change detection may already be running during synchronous tests.
    }
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }

  private defaultGmailRedirectUri(): string {
    const origin = String(globalThis.location?.origin || "").trim();
    return `${origin || "http://127.0.0.1:19812"}/oauth/gmail/callback`;
  }
}
