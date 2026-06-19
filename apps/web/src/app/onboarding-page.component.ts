import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, BackupRestorePlanResponse, BackupStatusResponse, BrowserSession, CodexAppServerStatus, CodexMigrationResponse, CodexStoredThread, ConnectorStatus, OnboardingProfile, OutlookOAuthPollResponse, OutlookOAuthStartResponse, SecureSecretMetadata, SetupStatus, StateBackupRecord, SystemDoctorResponse, ThreadSummary, UserOnboardingState, VersionResponse } from "./api.service";
import { SecurityChallengesPanelComponent } from "./security-challenges-panel.component";

type ConnectorStep = "openai" | "codex" | "gmail" | "linkedin" | "whatsapp" | "browsers";
type MarketingStep = "google-marketing";
type MaintenanceStep = "maintenance";
type SecureInputStep = "secrets";
type SecureSecretScope = "user" | "global";
type OnboardingStep = "goal" | "profile" | "system" | "security" | MaintenanceStep | SecureInputStep | MarketingStep | ConnectorStep | "finish";
type OnboardingGoalId = "whatsapp-codex" | "virtual-desktop" | "inbox-summary";
type SetupPageMode = "setup" | "onboarding";
type MailProvider = "gmail" | "outlook";

interface BrowserActionOptions {
  openReturnedUrl?: boolean;
  openedMessage?: string;
  missingUrlMessage?: string;
}

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
  imports: [FormsModule, SecurityChallengesPanelComponent],
  templateUrl: "./onboarding-page.component.html",
  styleUrls: ["./onboarding-page.component.css"],
})
export class OnboardingPageComponent implements OnInit, OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly storageKey = "orkestr:onboarding";
  private poller?: ReturnType<typeof setInterval>;
  private outlookPoller?: ReturnType<typeof setInterval>;
  private codexAuthPoller?: ReturnType<typeof setInterval>;
  private compactCodexOpenTimer?: ReturnType<typeof setTimeout>;

  @Input() mode: SetupPageMode = "onboarding";
  @Input() setupSection = "";
  @Output() skip = new EventEmitter<void>();
  @Output() complete = new EventEmitter<void>();
  @Output() openAppRequested = new EventEmitter<void>();
  @Output() setupSectionChange = new EventEmitter<string>();
  @Output() paired = new EventEmitter<void>();

  setup: SetupStatus | null = null;
  doctor: SystemDoctorResponse | null = null;
  versionInfo: VersionResponse | null = null;
  busy = false;
  error = "";
  notice = "";
  activeStep: OnboardingStep = "goal";
  selectedGoal: OnboardingGoalId = "whatsapp-codex";
  onboardingProfile: OnboardingProfile | null = null;
  timezone = "";
  detectedTimezone = "";
  timezoneLoaded = false;
  timezoneSaving = false;
  firstThread: ThreadSummary | null = null;
  whatsappChatId = "";
  whatsappChatName = "";
  testMessage = "Hello from Orkestr onboarding.";
  codexDeviceCode = "";
  codexAuthUrl = "";
  codexAuthExpiresAt = "";
  codexApiKey = "";
  codexAppServer: CodexAppServerStatus | null = null;
  codexStoredThreads: CodexStoredThread[] = [];
  codexImportSearch = "";
  importingCodexThreadId = "";
  backupStatus: BackupStatusResponse | null = null;
  restoreBackupPath = "";
  restorePlan: BackupRestorePlanResponse | null = null;
  migrationResult: CodexMigrationResponse | null = null;
  secureSecrets: SecureSecretMetadata[] = [];
  secureSecretScope: SecureSecretScope = "user";
  secureSecretUserId = "";
  secureSecretName = "";
  secureSecretValue = "";
  deletingSecureSecret = "";

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
      label: "Optional mail summaries",
      eyebrow: "Optional",
      summary: "Connect Gmail or Outlook only if you want inbox summaries sent back to WhatsApp.",
      requiredSteps: ["openai", "gmail", "whatsapp"],
    },
  ];

  readonly connectorSteps: Array<{ id: ConnectorStep; label: string; eyebrow: string }> = [
    { id: "openai", label: "OpenAI API", eyebrow: "Optional API" },
    { id: "codex", label: "Codex Agent", eyebrow: "Required runtime" },
    { id: "gmail", label: "Optional mail", eyebrow: "Inbox" },
    { id: "linkedin", label: "LinkedIn", eyebrow: "Browser" },
    { id: "whatsapp", label: "WhatsApp", eyebrow: "Messages" },
    { id: "browsers", label: "Desktops", eyebrow: "Browser runtime" },
  ];
  private readonly leanSetupConnectorIds: ConnectorStep[] = ["codex", "whatsapp", "browsers"];

  ngOnInit(): void {
    this.detectedTimezone = this.browserTimezone();
    if (!this.timezone) this.timezone = this.detectedTimezone;
    this.restoreProgress();
    this.applySetupSectionFromInput();
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
    if (this.codexAuthPoller) clearInterval(this.codexAuthPoller);
    if (this.compactCodexOpenTimer) clearTimeout(this.compactCodexOpenTimer);
  }

  async load(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [setupResult, doctorResult, versionResult, onboardingResult] = await Promise.allSettled([
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.systemDoctor()),
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.myOnboarding()),
      ]);
      if (setupResult.status === "rejected") throw setupResult.reason;
      const setup = setupResult.value;
      this.setup = setup;
      this.doctor = doctorResult.status === "fulfilled" ? doctorResult.value : null;
      this.versionInfo = versionResult.status === "fulfilled" ? versionResult.value : this.versionInfo;
      if (onboardingResult.status === "fulfilled") this.applyOnboardingState(onboardingResult.value.onboarding || null);
      if (this.activeStep === "maintenance") await this.loadBackupStatus(false);
      if (this.activeStep === "secrets") await this.loadSecureSecrets(false);
      this.hydrateForms(setup);
      if (this.activeStep === "codex") await this.loadCodexAppServer(false);
      this.applySetupSectionFromInput();
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

  async saveTimezone(): Promise<void> {
    const timezone = this.timezone.trim();
    if (!timezone) {
      this.error = "Enter your timezone before continuing.";
      return;
    }
    this.busy = true;
    this.timezoneSaving = true;
    try {
      const result = await firstValueFrom(this.api.updateMyOnboardingProfile({ timezone }));
      this.applyOnboardingState(result.onboarding || null);
      this.notice = `Timezone saved: ${this.timezoneLabel()}.`;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.timezoneSaving = false;
      this.busy = false;
      this.renderNow();
    }
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
    const account = this.gmailAccount.trim();
    const suffix = account ? `?account=${encodeURIComponent(account)}` : "";
    this.error = "";
    this.notice = "Opening Gmail authorization.";
    globalThis.location.href = `/oauth/gmail/start${suffix}`;
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

  private startCodexAuthPolling(expiresAt = ""): void {
    if (this.codexAuthPoller) clearInterval(this.codexAuthPoller);
    const expiresAtMs = Date.parse(expiresAt || "") || Date.now() + 15 * 60_000;
    const poll = (): void => {
      if (Date.now() > expiresAtMs) {
        if (this.codexAuthPoller) clearInterval(this.codexAuthPoller);
        this.codexAuthPoller = undefined;
        this.notice = "Sign-in expired. Open Codex sign-in again.";
        this.renderNow();
        return;
      }
      void this.pollCodexAuth();
    };
    this.codexAuthPoller = setInterval(poll, 5_000);
    poll();
  }

  async prepareLinkedIn(): Promise<void> {
    await this.browserAction("linkedin", "prepare", "LinkedIn browser profile prepared.");
  }

  async openLinkedIn(): Promise<void> {
    await this.browserAction("linkedin", "start", "LinkedIn browser requested.", {
      openReturnedUrl: true,
      openedMessage: "LinkedIn browser opened.",
      missingUrlMessage: "LinkedIn browser started, but no remote desktop URL is configured.",
    });
  }

  async prepareVirtualDesktop(): Promise<void> {
    await this.browserAction("desktop", "prepare", "Desktop profile prepared.");
  }

  async openVirtualDesktop(): Promise<void> {
    await this.browserAction("desktop", "start", "Desktop requested.", {
      openReturnedUrl: true,
      openedMessage: "Desktop opened.",
      missingUrlMessage: "Desktop started, but no remote desktop URL is configured.",
    });
  }

  connector(id: string): ConnectorStatus | null {
    return this.setup?.connectors?.find((connector) => connector.id === id) || null;
  }

  connectorDetail(id: string, key: string): string {
    const value = this.connector(id)?.details?.[key];
    return value === null || value === undefined ? "" : String(value);
  }

  googleMarketingConnector(): ConnectorStatus | null {
    return this.connector("google-marketing");
  }

  googleMarketingActionLabel(): string {
    return this.connectorDetail("google-marketing", "actionLabel") || "Update Google Marketing Auth";
  }

  googleMarketingActionHint(): string {
    return this.connectorDetail("google-marketing", "actionHint") || "Starts the overlay OAuth flow for Search Console and GA Admin.";
  }

  googleMarketingScopeLine(): string {
    const scope = this.connectorDetail("google-marketing", "scope");
    return scope ? `Scopes: ${scope.split(/\s+/).filter(Boolean).join(", ")}` : "";
  }

  async startGoogleMarketingAuth(): Promise<void> {
    this.error = "";
    this.notice = "Opening Google Marketing authorization.";
    globalThis.location.href = "/google-marketing/oauth/start";
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
    if (id === "codex") return this.agentRuntimeStateLabel();
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
    if (id === "profile") return this.timezoneDone() ? "saved" : "needed";
    if (id === "system") return this.setup ? "checked" : "checking";
    if (id === "security") return this.securityStepLabel();
    if (id === "maintenance") return this.maintenanceStepLabel();
    if (id === "secrets") return this.secureSecretsLabel();
    if (id === "finish") return this.requiredConnectorSteps().every((step) => this.stepDone(step)) ? "ready" : "review";
    if (id === "gmail") return this.mailStatusLabel();
    return this.stateLabel(id);
  }

  stepStateClass(id: OnboardingStep): string {
    if (id === "goal") return this.selectedGoal ? "ready" : "idle";
    if (id === "profile") return this.timezoneDone() ? "ready" : "partial";
    if (id === "system") return this.setup ? "ready" : "idle";
    if (id === "security") return this.securityStepClass();
    if (id === "maintenance") return this.backupStatus?.latestBackup ? "ready" : "partial";
    if (id === "secrets") return this.secureSecrets.length ? "ready" : "idle";
    if (id === "finish") return this.requiredConnectorSteps().every((step) => this.stepDone(step)) ? "ready" : "partial";
    if (id === "gmail") return this.mailStatusClass();
    return this.stateClass(id);
  }

  stepDone(id: OnboardingStep): boolean {
    if (id === "goal") return Boolean(this.selectedGoal);
    if (id === "profile") return this.timezoneDone();
    if (id === "system") return Boolean(this.setup);
    if (id === "security") return this.securityDone();
    if (id === "maintenance") return Boolean(this.backupStatus?.latestBackup);
    if (id === "secrets") return this.secureSecrets.length > 0;
    if (id === "finish") return this.requiredConnectorSteps().every((step) => this.stepDone(step));
    if (id === "gmail") return this.mailDone();
    if (id === "codex") return this.agentRuntimeReady();
    const state = this.connector(id)?.state;
    return state === "connected" || state === "partial";
  }

  setupReady(): boolean {
    return this.setup?.setupState === "ready";
  }

  agentRuntimeReady(): boolean {
    return this.connector("codex")?.state === "connected";
  }

  agentRuntimeStateLabel(): string {
    const connector = this.connector("codex");
    const state = String(connector?.state || "checking").toLowerCase();
    const reason = String(connector?.details?.["reason"] || "").toLowerCase();
    if (state === "connected") return "connected";
    if (state === "partial") return "sign-in required";
    if (state === "not_connected" && reason === "codex_missing") return "runtime missing";
    if (state === "not_connected" && reason.includes("disabled")) return "disabled";
    if (state === "not_connected") return "runtime unavailable";
    return state.replace(/_/g, " ");
  }

  codexRuntimeDetail(): string {
    const version = this.connectorDetail("codex", "version");
    if (version) return version;
    const command = this.connectorDetail("codex", "command");
    if (command) return command;
    const reason = this.codexUnavailableReason();
    if (reason === "codex_disabled_on_macos") return "Host Codex is disabled for this macOS local install.";
    if (reason === "codex_missing") return "Codex command is not installed in this runtime.";
    return "Waiting for the bundled Codex command";
  }

  codexCommandAvailable(): boolean {
    const connector = this.connector("codex");
    if (!connector) return false;
    const details = connector.details || {};
    if (details["disabled"] === true) return false;
    if (this.codexUnavailableReason()) return false;
    return Boolean(this.connectorDetail("codex", "command") || this.connectorDetail("codex", "version") || connector.state === "connected" || connector.state === "partial");
  }

  codexCommandUnavailableHint(): string {
    if (this.codexCommandAvailable()) return "";
    const summary = String(this.connector("codex")?.summary || "").trim();
    if (this.codexUnavailableReason() === "codex_disabled_on_macos") {
      return summary || "Codex host binary is disabled for this macOS local install. Verify Codex manually, then rerun the installer with ORKESTR_ENABLE_HOST_CODEX=1.";
    }
    if (this.codexUnavailableReason() === "codex_missing") {
      return summary || "Codex Agent runtime is missing. Install Codex in the Orkestr runtime, then refresh this page.";
    }
    return summary || "Codex command is not available yet. Refresh after the runtime is installed.";
  }

  private codexUnavailableReason(): string {
    const connector = this.connector("codex");
    const reason = String(connector?.details?.["reason"] || "").toLowerCase();
    if (reason === "codex_disabled_on_macos" || reason === "codex_missing") return reason;
    if (String(connector?.state || "").toLowerCase() === "not_connected" && reason.includes("disabled")) return "codex_disabled_on_macos";
    return "";
  }

  canOpenApp(): boolean {
    return true;
  }

  runtimeBlockTitle(): string {
    return `Codex Agent ${this.agentRuntimeStateLabel()}`;
  }

  openAppBlockReason(): string {
    if (this.canOpenApp()) return "";
    const summary = String(this.connector("codex")?.summary || "").trim();
    const base = summary || "Codex Agent is required before starting coding agents.";
    return `${base} Connect Codex Agent before starting coding-agent work.`;
  }

  isSetupMode(): boolean {
    return this.mode === "setup";
  }

  compactSetupMode(): boolean {
    return this.isSetupMode() && new URLSearchParams(globalThis.location?.search || "").get("compact") === "1";
  }

  isOnboardingMode(): boolean {
    return this.mode === "onboarding";
  }

  pageTitle(): string {
    if (this.compactSetupMode()) return "Sign in to Codex";
    return this.isSetupMode() ? "Setup" : "Set up Orkestr";
  }

  pageSummary(): string {
    if (this.compactSetupMode()) return "This Orkestr instance needs a Codex login before it can start coding threads.";
    return this.isSetupMode()
      ? "Check secure access, accounts, runtimes, and optional connectors after the installer has prepared the local Orkestr runtime."
      : "Start with Codex and WhatsApp. Add mail, timers, and managed browser desktops only when you need those capabilities.";
  }

  pageEyebrow(): string {
    if (this.compactSetupMode()) return "Orkestr connect";
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
    if (this.compactSetupMode()) return "Open Orkestr";
    return this.isSetupMode() ? "Back to Orkestr" : "Open Orkestr";
  }

  compactCodexTitle(): string {
    if (this.agentRuntimeReady()) return "Codex is signed in";
    return "Codex login required";
  }

  compactCodexSummary(): string {
    if (this.agentRuntimeReady()) return "Opening Orkestr.";
    if (!this.codexCommandAvailable()) return "Codex is not ready in this runtime yet.";
    return "Open the Codex sign-in page and finish login. Orkestr will continue automatically.";
  }

  codexAuthStatusText(): string {
    if (this.agentRuntimeReady()) return "Codex connected. Opening Orkestr.";
    if (this.codexDeviceCode) return "Waiting for Codex sign-in...";
    return "";
  }

  timezoneDone(): boolean {
    return Boolean(String(this.onboardingProfile?.timezone || "").trim());
  }

  timezoneLabel(): string {
    return String(this.onboardingProfile?.timezone || this.timezone || this.detectedTimezone || "").trim();
  }

  timezoneSummary(): string {
    if (this.timezoneDone()) return `Saved as ${this.timezoneLabel()}.`;
    if (this.detectedTimezone) return `Detected ${this.detectedTimezone}.`;
    return "Use an IANA timezone such as Europe/Berlin or America/New_York.";
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
      { id: "profile", label: "Timezone", eyebrow: "Profile" },
      { id: "system", label: "Connections", eyebrow: "Runtime" },
      { id: "security", label: "Secure access", eyebrow: "Remote safety" },
      ...this.requiredConnectorSteps().map((id) => byId[id]),
      { id: "finish", label: "Ready to run", eyebrow: "Starter thread" },
    ];
  }

  setupSections(): Array<{ id: OnboardingStep; label: string; eyebrow: string }> {
    if (this.compactSetupMode()) return [{ id: "codex", label: "Codex", eyebrow: "Required" }];
    const setupConnectors = this.connectorSteps.filter((step) => this.leanSetupConnectorIds.includes(step.id));
    return [
      { id: "system", label: "Connections", eyebrow: "Runtime" },
      { id: "security", label: "Security", eyebrow: "Remote access" },
      { id: "secrets", label: "Secrets", eyebrow: "Secure input" },
      { id: "maintenance", label: "Maintenance", eyebrow: "Backups" },
      ...setupConnectors,
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

  requiredConnectorSteps(): ConnectorStep[] {
    return Array.from(new Set<ConnectorStep>(["codex", ...this.goalRequiredSteps()]));
  }

  goToCodexSetup(): void {
    this.selectStep("codex");
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
        label: "Codex agent runtime",
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
        summary: `Optional. ${this.mailSummary()}`,
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
    const bindIsSafe = Boolean(security.externallyLocal || security.bindLocal);
    return [
      {
        label: "Bind address",
        state: security.proxyLocalBind ? "proxied" : security.bindLocal ? "local" : "remote",
        summary: security.proxyLocalBind ? `Reverse proxy publishes local Orkestr bind ${bindHost}` : security.bindLocal ? `Bound to ${bindHost}` : `Bound to ${bindHost || "non-local address"}`,
        className: bindIsSafe ? "ready" : "bad",
      },
      {
        label: "Caddy",
        state: security.caddy?.installed ? "installed" : "missing",
        summary: security.caddy?.version || security.caddy?.error || "Install Caddy before exposing Orkestr remotely",
        className: security.caddy?.installed ? "ready" : "idle",
      },
      {
        label: "Client mTLS",
        state: security.mtls?.configured ? "enabled" : security.https?.configured || security.caddy?.installed ? "optional" : "needs HTTPS",
        summary: security.mtls?.configured ? `Caddy verifies client certificates (${security.mtls?.mode || "require_and_verify"})` : "Optional client-certificate layer for public domains",
        className: security.mtls?.configured ? "ready" : security.https?.configured || security.caddy?.installed ? "partial" : "idle",
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

  maintenanceStepLabel(): string {
    if (!this.backupStatus) return "check";
    const count = Number(this.backupStatus.backupCount || 0);
    if (count === 1) return "1 backup";
    if (count > 1) return `${count} backups`;
    return "no backup";
  }

  backupSummary(): string {
    if (!this.backupStatus) return "Backup status has not been loaded yet.";
    const latest = this.backupStatus.latestBackup;
    if (!latest) return `No backups found in ${this.backupStatus.backupDir}.`;
    return `${latest.name} in ${this.backupStatus.backupDir}`;
  }

  backupSizeLabel(backup: StateBackupRecord | null | undefined): string {
    const size = Number(backup?.size || 0);
    if (!size) return "-";
    if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
  }

  backupDateLabel(backup: StateBackupRecord | null | undefined): string {
    return backup?.modifiedAt || backup?.createdAt || "";
  }

  migrationSummary(): string {
    const dryRun = this.backupStatus?.migration?.codexAppServer?.dryRun || this.migrationResult;
    if (!dryRun) return "Codex migration status has not been checked yet.";
    if (dryRun.error) return String(dryRun.error);
    const migrated = Number(dryRun.migrated ?? dryRun.counts?.["migrated"] ?? dryRun.counts?.["migrated_existing_codex_thread"] ?? 0);
    if (dryRun.dryRun) return migrated ? `${migrated} Codex thread migration candidate` : "No Codex thread migration needed.";
    return migrated ? `${migrated} Codex thread migrated.` : "Codex migration completed.";
  }

  migrationStateClass(): string {
    const dryRun = this.backupStatus?.migration?.codexAppServer?.dryRun || this.migrationResult;
    if (!dryRun) return "idle";
    if (dryRun.error) return "bad";
    const migrated = Number(dryRun.migrated ?? dryRun.counts?.["migrated"] ?? dryRun.counts?.["migrated_existing_codex_thread"] ?? 0);
    return migrated ? "partial" : "ready";
  }

  async loadBackupStatus(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      this.backupStatus = await firstValueFrom(this.api.backupStatus());
      this.restoreBackupPath ||= this.backupStatus.latestBackup?.path || "";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = false;
      this.renderNow();
    }
  }

  async createBackup(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.createBackup("setup"));
      this.backupStatus = result.status;
      this.restoreBackupPath = result.backup.path;
      this.notice = `Backup created: ${result.backup.name}`;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async prepareRestorePlan(backupPath = this.restoreBackupPath): Promise<void> {
    const selected = backupPath.trim();
    if (!selected) {
      this.error = "Select a backup before preparing restore commands.";
      return;
    }
    this.busy = true;
    try {
      this.restorePlan = await firstValueFrom(this.api.backupRestorePlan(selected));
      this.restoreBackupPath = selected;
      this.notice = "Restore plan prepared.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async runCodexMigration(dryRun = false): Promise<void> {
    this.busy = true;
    try {
      this.migrationResult = await firstValueFrom(this.api.migrateCodexThreads(dryRun));
      this.notice = dryRun ? "Codex migration dry run completed." : "Codex migration completed.";
      this.error = "";
      await this.loadBackupStatus(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  secureSecretsLabel(): string {
    const count = this.secureSecrets.length;
    if (count === 1) return "1 secret";
    if (count > 1) return `${count} secrets`;
    return "none";
  }

  secureSecretScopeSummary(): string {
    if (this.secureSecretScope === "global") return "Global secrets are available to admin-managed Orkestr workflows.";
    const userId = this.secureSecretUserId.trim();
    return userId ? `User scope for ${userId}.` : "User scope for the signed-in operator.";
  }

  secureSecretStatusClass(secret: SecureSecretMetadata): string {
    const status = String(secret.status || "").toLowerCase();
    if (secret.configured !== false && (!status || status === "configured")) return "ready";
    if (status === "missing" || status === "error") return "bad";
    return "partial";
  }

  secureSecretStatusLabel(secret: SecureSecretMetadata): string {
    return String(secret.status || (secret.configured === false ? "missing" : "configured")).replace(/_/g, " ");
  }

  secureSecretOwnerLabel(secret: SecureSecretMetadata): string {
    if (secret.scope === "global") return "global";
    return String(secret.ownerUserId || "user");
  }

  secureSecretUpdatedLabel(secret: SecureSecretMetadata): string {
    return String(secret.updatedAt || secret.createdAt || "");
  }

  secureSecretFingerprintLabel(secret: SecureSecretMetadata): string {
    const fingerprint = String(secret.valueFingerprint || "").trim();
    return fingerprint ? `fingerprint ${fingerprint}` : "value hidden";
  }

  async loadSecureSecrets(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const result = await firstValueFrom(this.api.secureSecrets(this.secureSecretTarget()));
      this.secureSecrets = result.secrets || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = false;
      this.renderNow();
    }
  }

  async saveSecureSecret(): Promise<void> {
    const name = this.secureSecretName.trim();
    const value = this.secureSecretValue;
    if (!name) {
      this.error = "Enter a secret name before saving.";
      return;
    }
    if (!value) {
      this.error = "Enter a secret value before saving.";
      return;
    }
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.setSecureSecret({ ...this.secureSecretTarget(), name, value }));
      this.secureSecretValue = "";
      this.secureSecretName = "";
      this.notice = `Secret saved: ${result.secret.handle}`;
      this.error = "";
      await this.loadSecureSecrets(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async deleteSecureSecret(secret: SecureSecretMetadata): Promise<void> {
    const name = String(secret.name || "").trim();
    if (!name) return;
    this.deletingSecureSecret = secret.handle || name;
    this.busy = true;
    try {
      const scope = secret.scope === "global" ? "global" : "user";
      const userId = scope === "user" ? String(secret.ownerUserId || "").trim() : "";
      await firstValueFrom(this.api.deleteSecureSecret(name, { scope, userId }));
      this.notice = `Secret deleted: ${secret.handle || name}`;
      this.error = "";
      await this.loadSecureSecrets(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.deletingSecureSecret = "";
      this.busy = false;
      this.renderNow();
    }
  }

  async refreshSecureSecretsForScope(): Promise<void> {
    await this.loadSecureSecrets();
  }

  async startCodexDeviceAuth(): Promise<void> {
    if (!this.codexCommandAvailable()) {
      this.error = this.codexCommandUnavailableHint();
      this.notice = "";
      return;
    }
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.startCodexDeviceAuth());
      this.codexDeviceCode = result.code || "";
      this.codexAuthUrl = result.authUrl || "";
      this.codexAuthExpiresAt = result.expiresAt || "";
      if (this.codexAuthUrl) globalThis.open?.(this.codexAuthUrl, "_blank", "noopener,noreferrer");
      this.notice = this.compactSetupMode()
        ? "Waiting for Codex sign-in..."
        : this.codexDeviceCode ? "Codex sign-in opened. Enter the device code in the browser." : "Codex sign-in started.";
      this.error = "";
      await this.load(false);
      this.startCodexAuthPolling(this.codexAuthExpiresAt);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async pollCodexAuth(): Promise<void> {
    try {
      const setup = await firstValueFrom(this.api.setupStatus());
      this.setup = setup;
      this.hydrateForms(setup);
      if (this.connector("codex")?.state !== "connected") return;
      if (this.codexAuthPoller) clearInterval(this.codexAuthPoller);
      this.codexAuthPoller = undefined;
      this.codexDeviceCode = "";
      this.codexAuthUrl = "";
      this.codexAuthExpiresAt = "";
      this.notice = this.compactSetupMode()
        ? "Codex connected. Opening Orkestr."
        : this.isSetupMode() ? "Codex connected. You can open Orkestr when ready." : "Codex connected. Continue setup.";
      this.error = "";
      if (this.activeStep === "codex") await this.loadCodexAppServer(false);
      if (this.compactSetupMode()) {
        if (!this.compactCodexOpenTimer) {
          this.compactCodexOpenTimer = setTimeout(() => {
            this.compactCodexOpenTimer = undefined;
            this.openApp();
          }, 600);
        }
        return;
      }
      if (!this.isSetupMode() && !this.isLastStep()) this.nextStep();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.renderNow();
    }
  }

  async connectCodexApiKey(): Promise<void> {
    if (!this.codexCommandAvailable()) {
      this.error = this.codexCommandUnavailableHint();
      this.notice = "";
      return;
    }
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

  async loadCodexAppServer(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [status, threads] = await Promise.all([
        firstValueFrom(this.api.codexAppServerStatus()),
        firstValueFrom(this.api.codexThreads(this.codexImportSearch)),
      ]);
      this.codexAppServer = status;
      this.codexStoredThreads = threads.threads || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = false;
      this.renderNow();
    }
  }

  async importCodexThread(thread: CodexStoredThread): Promise<void> {
    const id = String(thread.id || "").trim();
    if (!id) return;
    this.importingCodexThreadId = id;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.importCodexThread(id));
      this.notice = result.imported ? "Codex thread imported into Orkestr." : "Codex thread is already in Orkestr.";
      this.error = "";
      await this.load(false);
      await this.loadCodexAppServer(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.importingCodexThreadId = "";
      this.busy = false;
      this.renderNow();
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
    if (id === "codex") void this.loadCodexAppServer(false);
    if (id === "maintenance") void this.loadBackupStatus(false);
    if (id === "secrets") void this.loadSecureSecrets(false);
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
    if (this.compactSetupMode()) {
      this.openAppRequested.emit();
      return;
    }
    if (this.isSetupMode()) {
      this.skip.emit();
      return;
    }
    this.complete.emit();
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

  private secureSecretTarget(): { scope: SecureSecretScope; userId?: string } {
    const target: { scope: SecureSecretScope; userId?: string } = { scope: this.secureSecretScope };
    const userId = this.secureSecretUserId.trim();
    if (this.secureSecretScope === "user" && userId) target.userId = userId;
    return target;
  }

  private async browserAction(slug: string, action: string, message: string, options: BrowserActionOptions = {}): Promise<void> {
    const pendingWindow = options.openReturnedUrl ? this.openPendingWindow() : null;
    this.busy = true;
    try {
      const response = await firstValueFrom(this.api.browserAction(slug, action));
      const openUrl = options.openReturnedUrl ? this.browserOpenUrl(response.browser) : "";
      if (options.openReturnedUrl) {
        if (openUrl) {
          this.navigatePendingWindow(pendingWindow, openUrl);
          this.notice = options.openedMessage || message;
        } else {
          this.closePendingWindow(pendingWindow);
          this.notice = options.missingUrlMessage || message;
        }
      } else {
        this.notice = message;
      }
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.closePendingWindow(pendingWindow);
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private browserOpenUrl(browser?: BrowserSession | null): string {
    return String(browser?.desk_url || browser?.url || "").trim();
  }

  private openPendingWindow(): Window | null {
    const opened = globalThis.open?.("about:blank", "_blank") || null;
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // Some browsers block assigning opener on a newly opened tab.
      }
    }
    return opened;
  }

  private navigatePendingWindow(opened: Window | null, url: string): void {
    if (opened) {
      opened.location.href = url;
      return;
    }
    globalThis.open?.(url, "_blank", "noopener,noreferrer");
  }

  private closePendingWindow(opened: Window | null): void {
    if (!opened) return;
    try {
      opened.close();
    } catch {
      // Closing a blocked or externally controlled tab is best effort.
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

  private applyOnboardingState(onboarding: UserOnboardingState | null): void {
    this.timezoneLoaded = true;
    if (onboarding?.profile) this.onboardingProfile = onboarding.profile;
    const savedTimezone = String(this.onboardingProfile?.timezone || "").trim();
    if (savedTimezone) this.timezone = savedTimezone;
    else if (!this.timezone.trim()) this.timezone = this.detectedTimezone;
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
    if (this.isSetupMode()) return storedStep || steps[0]?.id || "system";
    return storedStep || "goal";
  }

  private ensureActiveStepAvailable(): void {
    if (this.pageSections().some((step) => step.id === this.activeStep)) return;
    this.activeStep = this.isSetupMode() ? this.pageSections()[0]?.id || "system" : "goal";
  }

  private applySetupSectionFromInput(): void {
    if (!this.isSetupMode()) return;
    const section = String(this.setupSection || "").trim().toLowerCase();
    const match = this.setupSections().find((step) => step.id === section);
    this.activeStep = match?.id || this.setupSections()[0]?.id || "system";
    this.stepInitialized = true;
  }

  private restoreProgress(): void {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { goal?: OnboardingGoalId; activeStep?: OnboardingStep };
      if (saved.goal && this.goals.some((goal) => goal.id === saved.goal)) this.selectedGoal = saved.goal;
      if (!this.isSetupMode() && saved.activeStep && this.pageSections().some((step) => step.id === saved.activeStep)) {
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

  private browserTimezone(): string {
    try {
      return String(Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim();
    } catch {
      return "";
    }
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown };
      const body = record.error;
      if (typeof body === "string" && body.trim()) return body;
      if (body && typeof body === "object") {
        const bodyRecord = body as { message?: unknown; error?: unknown; code?: unknown };
        const detail = bodyRecord.message || bodyRecord.error || bodyRecord.code;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
    }
    return String(error || "Unknown error");
  }

  private defaultGmailRedirectUri(): string {
    const origin = String(globalThis.location?.origin || "").trim();
    return `${origin || "http://127.0.0.1:19812"}/oauth/gmail/callback`;
  }
}
