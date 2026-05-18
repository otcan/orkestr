import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, GmailMessage, SetupStatus, ThreadSummary } from "./api.service";

type ConnectorStep = "openai" | "codex" | "gmail" | "linkedin" | "whatsapp" | "browsers";
type OnboardingStep = "goal" | "system" | "security" | ConnectorStep | "finish";
type OnboardingGoalId = "whatsapp-codex" | "virtual-desktop" | "inbox-summary";
type SetupPageMode = "setup" | "onboarding";

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
  private readonly storageKey = "orkestr:onboarding";
  private poller?: ReturnType<typeof setInterval>;

  @Input() mode: SetupPageMode = "onboarding";
  @Input() setupSection = "";
  @Output() skip = new EventEmitter<void>();
  @Output() complete = new EventEmitter<void>();
  @Output() setupSectionChange = new EventEmitter<string>();
  @Output() paired = new EventEmitter<void>();

  setup: SetupStatus | null = null;
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
  codexDeviceCode = "";
  codexAuthUrl = "";
  codexAuthExpiresAt = "";

  openaiApiKey = "";
  gmailAccount = "";
  gmailClientId = "";
  gmailClientSecret = "";
  gmailRedirectUri = this.defaultGmailRedirectUri();
  gmailSampleQuery = "in:inbox newer_than:7d";
  gmailSampleMessages: GmailMessage[] = [];
  gmailSampleLoading = false;
  private formHydrated = false;
  private stepInitialized = false;

  readonly whatsappAccounts = [
    { id: "account-1", label: "WhatsApp 1" },
    { id: "account-2", label: "WhatsApp 2" },
  ];

  readonly goals: OnboardingGoal[] = [
    {
      id: "whatsapp-codex",
      label: "WhatsApp Codex worker",
      eyebrow: "Recommended",
      summary: "Control a local Codex worker from WhatsApp.",
      recommended: true,
      requiredSteps: ["codex", "whatsapp"],
    },
    {
      id: "virtual-desktop",
      label: "Virtual Desktop Generation",
      eyebrow: "Browser work",
      summary: "Create a local browser desktop that agents can use for web tasks.",
      requiredSteps: ["codex", "browsers", "whatsapp"],
    },
    {
      id: "inbox-summary",
      label: "Inbox summary",
      eyebrow: "Daily brief",
      summary: "Read Gmail and send a scheduled WhatsApp digest.",
      requiredSteps: ["openai", "gmail", "whatsapp"],
    },
  ];

  readonly connectorSteps: Array<{ id: ConnectorStep; label: string; eyebrow: string }> = [
    { id: "openai", label: "OpenAI", eyebrow: "Model access" },
    { id: "codex", label: "Codex", eyebrow: "Local agent" },
    { id: "gmail", label: "Gmail", eyebrow: "Inbox" },
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
  }

  async load(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const setup = await firstValueFrom(this.api.setupStatus());
      this.setup = setup;
      this.hydrateForms(setup);
      if (!this.stepInitialized) {
        this.activeStep = this.firstOpenStep();
        this.stepInitialized = true;
      }
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
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

  async loadGmailSample(): Promise<void> {
    this.gmailSampleLoading = true;
    try {
      const list = await firstValueFrom(this.api.gmailMessages(5, this.gmailSampleQuery));
      const ids = (list.messages || []).map((message) => message.id).filter(Boolean).slice(0, 5);
      const details = await Promise.all(ids.map(async (id) => {
        const result = await firstValueFrom(this.api.gmailMessage(id));
        return result.message;
      }));
      this.gmailSampleMessages = details;
      this.notice = details.length ? "Loaded recent Gmail messages." : "Gmail connected, but no messages matched this probe.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.gmailSampleLoading = false;
    }
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
    const state = this.connector("gmail")?.state;
    if (!state) return "not connected";
    return String(state).replace(/_/g, " ");
  }

  gmailStatusClass(): string {
    return this.stateClass("gmail");
  }

  gmailConfigSummary(): string {
    if (!this.gmailClientId.trim()) return "OAuth client is not configured.";
    return this.gmailRedirectUri.trim() || this.defaultGmailRedirectUri();
  }

  gmailSampleDate(message: GmailMessage): string {
    const timestamp = Date.parse(String(message.date || ""));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    const internal = Number(message.internalDate || 0);
    if (Number.isFinite(internal) && internal > 0) return new Date(internal).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    return "-";
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
    return this.stateLabel(id);
  }

  stepStateClass(id: OnboardingStep): string {
    if (id === "goal") return this.selectedGoal ? "ready" : "idle";
    if (id === "system") return this.setup ? "ready" : "idle";
    if (id === "security") return this.securityStepClass();
    if (id === "finish") return this.goalRequiredSteps().every((step) => this.stepDone(step)) ? "ready" : "partial";
    return this.stateClass(id);
  }

  stepDone(id: OnboardingStep): boolean {
    if (id === "goal") return Boolean(this.selectedGoal);
    if (id === "system") return Boolean(this.setup);
    if (id === "security") return this.securityDone();
    if (id === "finish") return this.goalRequiredSteps().every((step) => this.stepDone(step));
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
    return this.isSetupMode() ? "Setup" : "Choose your first workflow";
  }

  pageSummary(): string {
    return this.isSetupMode()
      ? "Setup stays available after onboarding so you can check security, accounts, runtimes, and local connectors at any time."
      : "Orkestr runs locally. These steps prepare only the local runtime and accounts needed for the workflow you want to run first.";
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
      { id: "goal", label: "Choose a goal", eyebrow: "Start here" },
      { id: "system", label: "System check", eyebrow: "Local machine" },
      { id: "security", label: "Secure access", eyebrow: "Remote safety" },
      ...this.goalRequiredSteps().map((id) => byId[id]),
      { id: "finish", label: "Ready to run", eyebrow: "First loop" },
    ];
  }

  setupSections(): Array<{ id: OnboardingStep; label: string; eyebrow: string }> {
    return [
      { id: "system", label: "System", eyebrow: "Runtime" },
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
    return [
      {
        label: "Local home",
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
    ];
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
      if (result.code) this.securityPairingCode = result.code;
      this.notice = result.code ? "Pairing code generated for this browser." : "Pairing code generated. Check the Orkestr server logs on the host.";
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async pairSecurityBrowser(): Promise<void> {
    const code = this.securityPairingCode.trim();
    if (!code) {
      this.error = "Enter the browser pairing code.";
      return;
    }
    this.busy = true;
    try {
      await firstValueFrom(this.api.pairSecurityBrowser(code));
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

  whatsappAccount(id: string): Record<string, unknown> {
    const accounts = this.connector("whatsapp")?.details?.["accounts"];
    if (!Array.isArray(accounts)) return {};
    return (accounts as Array<Record<string, unknown>>).find((account) => String(account["accountId"]) === id) || {};
  }

  whatsappAccountState(id: string): string {
    return String(this.whatsappAccount(id)["state"] || "idle").replace(/_/g, " ");
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
        actions.push("WhatsApp 1");
      }
      this.notice = `${thread.name || thread.id} first loop prepared: ${actions.join(", ")}.`;
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
        desiredCodexMode: "code",
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
    this.formHydrated = true;
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

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }

  private defaultGmailRedirectUri(): string {
    const origin = String(globalThis.location?.origin || "").trim();
    return `${origin || "http://127.0.0.1:19812"}/oauth/gmail/callback`;
  }
}
