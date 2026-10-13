import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, LlmAccountProfile, SetupStatus, ThreadMessage, ThreadSummary } from "./api.service";
import { CodexSignInPanelComponent } from "./codex-sign-in-panel.component";
import { codexStateLabel } from "./codex-runtime-status";
import { clearWizardProgress, loadWizardProgress, saveWizardProgress } from "./first-thread-wizard-progress";
import { WhatsAppPairPanelComponent } from "./whatsapp-pair-panel.component";

type WizardStepId = "whatsapp" | "codex" | "review";
type WhatsAppAccessMode = "managed" | "self_hosted";

@Component({
  selector: "ork-first-thread-wizard",
  imports: [CodexSignInPanelComponent, FormsModule, WhatsAppPairPanelComponent],
  templateUrl: "./first-thread-wizard.component.html",
})
export class FirstThreadWizardComponent implements OnChanges, OnDestroy, OnInit {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() canCancel = true;
  @Input() canManageSetup = false;
  @Input() setupStatus: SetupStatus | null = null;
  @Input() progressScope = "";
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<ThreadSummary>();
  @Output() setupRequested = new EventEmitter<"codex" | "whatsapp">();
  @Output() setupStatusChange = new EventEmitter<SetupStatus>();

  // WhatsApp first: it is the step users came for, and it can be skipped.
  readonly steps: Array<{ id: WizardStepId; label: string }> = [
    { id: "whatsapp", label: "Link WhatsApp" },
    { id: "codex", label: "Choose the AI" },
    { id: "review", label: "Name and start" },
  ];

  stepIndex = 0;
  threadName = "orkest";
  repoUrl = "";
  whatsappAccessMode: WhatsAppAccessMode = "self_hosted";
  readonly whatsappAccountId = "account-1";
  whatsappReady = false;
  pairedWhatsAppAccount: { accountId: string; contactId: string } | null = null;
  whatsappWarning = "";
  // After creation in self-hosted mode: the bound chat and the live check.
  createdThread: ThreadSummary | null = null;
  boundChatName = "";
  proof = { inbound: false, reply: false };
  private proofStartedAt = 0;
  private inboundAt = 0;
  private proofTimer: ReturnType<typeof setInterval> | null = null;
  runtimeProvider: "codex" | "claude-code" = "codex";
  claudeAccounts: LlmAccountProfile[] = [];
  claudeEnabled = false;
  claudeAccountProfileId = "";
  busy = false;
  error = "";
  desktopWarning = "";
  creationStage = "";
  private draftName = "";
  private draftThreadId = "";
  private whatsappModeTouched = false;

  ngOnInit(): void {
    this.restoreProgress();
    this.syncWhatsAppAccessMode();
    void this.loadClaudeAccounts().then(() => this.clampRestoredStep());
  }

  // Coming back from Setup restores the step and answers; a step past the AI
  // choice is only kept while that AI is still ready.
  private restoreProgress(): void {
    const saved = loadWizardProgress(this.progressScope);
    if (!saved) return;
    this.stepIndex = Math.min(saved.stepIndex, this.steps.length - 1);
    this.threadName = saved.threadName || this.threadName;
    this.repoUrl = saved.repoUrl;
    this.runtimeProvider = saved.runtimeProvider;
    this.whatsappModeTouched = saved.whatsappModeTouched;
    if (saved.whatsappModeTouched) this.whatsappAccessMode = saved.whatsappAccessMode;
    if (this.runtimeProvider === "codex") this.clampRestoredStep();
  }

  private clampRestoredStep(): void {
    const aiStep = this.steps.findIndex((step) => step.id === "codex");
    if (this.stepIndex > aiStep && this.setupStatus && !this.agentReady()) this.stepIndex = aiStep;
    this.cdr.markForCheck();
  }

  private saveProgress(): void {
    if (this.createdThread) return;
    saveWizardProgress({
      stepIndex: this.stepIndex,
      threadName: this.threadName,
      repoUrl: this.repoUrl,
      runtimeProvider: this.runtimeProvider,
      whatsappAccessMode: this.whatsappAccessMode,
      whatsappModeTouched: this.whatsappModeTouched,
      scope: this.progressScope,
    });
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.syncWhatsAppAccessMode();
  }

  private syncWhatsAppAccessMode(): void {
    if (this.whatsappModeTouched || !this.setupStatus) return;
    const available = this.availableWhatsAppModes();
    const selected = normalizeWhatsAppAccessMode(this.setupStatus.whatsappOnboarding?.selectedMode)
      || configuredWhatsAppAccessMode(this.setupStatus);
    this.whatsappAccessMode = available.includes(selected) ? selected : available[0] || "self_hosted";
  }

  ngOnDestroy(): void {
    this.stopProofCheck();
    this.saveProgress();
  }

  private stopProofCheck(): void {
    if (this.proofTimer) clearInterval(this.proofTimer);
    this.proofTimer = null;
  }

  private async loadClaudeAccounts(): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.llmAccounts("claude-code"));
      this.claudeEnabled = result.enabled === true;
      this.claudeAccounts = result.accounts || [];
      const ready = this.claudeAccounts.find((account) => account.state === "ready");
      if (ready) this.claudeAccountProfileId = ready.id;
    } catch {
      this.claudeEnabled = false;
      this.claudeAccounts = [];
    }
  }

  activeStep(): WizardStepId {
    return this.steps[this.stepIndex]?.id || "whatsapp";
  }

  progressPercent(): number {
    return Math.round(((this.stepIndex + 1) / this.steps.length) * 100);
  }

  stepDone(index: number): boolean {
    return index < this.stepIndex;
  }

  next(): void {
    if (!this.canContinue() || this.stepIndex >= this.steps.length - 1) return;
    this.stepIndex += 1;
    this.saveProgress();
  }

  previous(): void {
    if (this.stepIndex <= 0 || this.busy) return;
    this.stepIndex -= 1;
    this.saveProgress();
  }

  canSelectStep(index: number): boolean {
    return !this.busy && (index <= this.stepIndex || (index === this.stepIndex + 1 && this.canContinue()));
  }

  selectStep(index: number): void {
    if (!this.canSelectStep(index)) return;
    this.stepIndex = index;
  }

  canContinue(): boolean {
    const step = this.activeStep();
    if (step === "codex") return this.agentReady();
    if (step === "whatsapp") return this.availableWhatsAppModes().includes(this.whatsappAccessMode);
    return true;
  }

  nextLabel(): string {
    const linking = this.activeStep() === "whatsapp" && this.canManageSetup && this.whatsappAccessMode === "self_hosted";
    return linking && !(this.whatsappReady && this.pairedWhatsAppAccount) ? "Skip for now" : "Next";
  }

  canCreate(): boolean {
    return Boolean(this.agentName() && this.agentReady() && this.availableWhatsAppModes().includes(this.whatsappAccessMode) && !this.busy && !this.createdThread);
  }

  agentName(): string {
    return this.threadName.trim();
  }

  repoUrlValue(): string {
    return this.repoUrl.trim();
  }

  usesRemoteRepo(): boolean {
    return Boolean(this.repoUrlValue());
  }

  codebaseLabel(): string {
    return this.usesRemoteRepo() ? "Copy of your Git repository" : "New empty project folder";
  }

  desktopSlug(): string {
    const settings = this.setupStatus?.settings || {};
    const desktops = settings["desktops"] && typeof settings["desktops"] === "object"
      ? settings["desktops"] as Record<string, unknown>
      : {};
    return String(desktops["default"] || desktops["manualIntervention"] || "desktop").trim() || "desktop";
  }

  whatsappAccessLabel(): string {
    if (this.whatsappAccessMode !== "self_hosted") return "WhatsApp provided by this server's operator";
    return this.whatsappReady && this.pairedWhatsAppAccount
      ? "Own WhatsApp (linked) · your \"Message yourself\" chat will talk to the agent"
      : "Not linked yet · you can link it later in Setup";
  }

  availableWhatsAppModes(): WhatsAppAccessMode[] {
    const modes = this.setupStatus?.whatsappOnboarding?.availableModes;
    if (!Array.isArray(modes)) return ["self_hosted"];
    return modes.map(normalizeWhatsAppAccessMode).filter((mode): mode is WhatsAppAccessMode => mode !== null);
  }

  onWhatsAppPaired(account: { accountId: string; contactId: string } | null): void {
    this.pairedWhatsAppAccount = account;
    this.cdr.markForCheck();
  }

  onWhatsAppReady(ready: boolean): void {
    this.whatsappReady = ready;
    this.cdr.markForCheck();
  }

  selectWhatsAppAccessMode(mode: WhatsAppAccessMode): void {
    if (this.busy || !this.canManageSetup || !this.availableWhatsAppModes().includes(mode)) return;
    this.whatsappModeTouched = true;
    this.whatsappAccessMode = mode;
  }

  codexConnector(): ConnectorStatus | null {
    return this.setupStatus?.connectors?.find((connector) => connector.id === "codex") || null;
  }

  codexReady(): boolean {
    return this.codexConnector()?.state === "connected";
  }

  selectedClaudeAccount(): LlmAccountProfile | null {
    return this.claudeAccounts.find((account) => account.id === this.claudeAccountProfileId) || null;
  }

  agentReady(): boolean {
    return this.runtimeProvider === "claude-code" ? this.selectedClaudeAccount()?.state === "ready" : this.codexReady();
  }

  agentSummary(): string {
    if (this.runtimeProvider === "codex") return this.codexSummary();
    const account = this.selectedClaudeAccount();
    if (!account) return "Add your Claude subscription under Tools → Models first.";
    return account.state === "ready" ? `${account.label} is ready.` : `${account.label} is ${account.state.replace(/_/g, " ")}. Sign in again under Tools → Models.`;
  }

  codexBlocked(): boolean {
    return Boolean(this.setupStatus && !this.codexReady());
  }

  codexStateLabel(): string {
    return codexStateLabel(this.codexConnector());
  }

  codexSummary(): string {
    if (this.codexReady()) return "Codex is signed in with your ChatGPT account.";
    if (!this.codexConnector()) return "Checking whether Codex is signed in…";
    return "Sign in to Codex with your ChatGPT account. Sign-in uses a one-time code, which must first be allowed in ChatGPT → Settings → Security (\"device code\" sign-in).";
  }

  // Codex signed in from the inline panel: continue without reloading the app.
  onCodexConnected(setup: SetupStatus): void {
    this.setupStatus = setup;
    this.setupStatusChange.emit(setup);
    this.cdr.markForCheck();
  }

  openCodexSetup(): void {
    this.setupRequested.emit("codex");
  }

  generatedWorkspaceName(): string {
    const name = this.agentName();
    if (!name) return "generated automatically";
    if (name !== this.draftName || !this.draftThreadId) {
      this.draftName = name;
      this.draftThreadId = this.threadId(name);
    }
    return this.draftThreadId;
  }

  async createAndStart(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy = true;
    this.error = "";
    this.desktopWarning = "";
    try {
      let shouldWake = this.runtimeProvider === "claude-code" || this.codexReady();
      if (this.runtimeProvider === "codex" && !this.codexReady()) {
        const setup = await firstValueFrom(this.api.setupStatus());
        this.setupStatus = setup;
        shouldWake = this.codexReady();
      }
      if (!shouldWake || !this.agentReady()) {
        this.error = this.agentSummary();
        return;
      }
      const name = this.agentName();
      const repoUrl = this.repoUrlValue();
      const cloneRepo = Boolean(repoUrl);
      const currentSetup = await firstValueFrom(this.api.setupStatus());
      this.setupStatus = currentSetup;
      const availableModes = this.availableWhatsAppModes();
      if (!this.whatsappModeTouched) this.syncWhatsAppAccessMode();
      if (!availableModes.includes(this.whatsappAccessMode)) {
        this.error = "This WhatsApp mode is no longer available. Choose another mode in Setup.";
        return;
      }
      if (this.canManageSetup && this.whatsappModeTouched) {
        this.creationStage = "Saving WhatsApp access choice";
        await firstValueFrom(this.api.saveSetupDemoPreferences({
          whatsappAccessMode: this.whatsappAccessMode,
        }));
      }
      this.creationStage = cloneRepo ? "Cloning repo" : "Creating local git repo";
      const response = await firstValueFrom(this.api.createThread({
        id: this.generatedWorkspaceName(),
        name,
        title: name,
        bindingName: name,
        wakePolicy: "wake-on-message",
        executorId: this.runtimeProvider,
        executor: this.runtimeProvider === "claude-code"
          ? { type: "claude-code", accountProfileId: this.claudeAccountProfileId }
          : { type: "codex" },
        ...(this.runtimeProvider === "codex" ? { codexMode: "code" } : {}),
        autoWorkspace: true,
        initGit: !cloneRepo,
        repoRemoteUrl: repoUrl,
        cloneRepo,
        wake: shouldWake,
        reason: "first_thread_created",
      }));
      const thread = response.thread;
      this.creationStage = "Starting Virtual Desk";
      await this.startVirtualDesk(thread).catch(() => {
        this.desktopWarning = "The agent's browser did not start. Everything else works; you can start it later under Desktops in the conversation.";
      });
      this.creationStage = this.runtimeProvider === "claude-code" ? "Starting Claude Code in background" : "Starting Codex in background";
      if (this.canManageSetup && this.whatsappAccessMode === "self_hosted" && this.whatsappReady && this.pairedWhatsAppAccount) {
        this.creationStage = "Connecting your private WhatsApp chat";
        try {
          // Server enforces: only the account paired above, only its own chat, refused if no longer linked.
          const group = await firstValueFrom(this.api.connectWhatsAppPrivateChat({
            threadId: thread.id,
            name,
            pairedAccountId: this.pairedWhatsAppAccount.accountId,
            pairedContactId: this.pairedWhatsAppAccount.contactId,
          }));
          this.boundChatName = group.chat?.name || name;
          this.creationStage = "";
          this.createdThread = thread;
          clearWizardProgress();
          this.startProofCheck(thread.id);
          return;
        } catch (error) {
          this.whatsappWarning = `Your WhatsApp chat could not be connected: ${this.errorText(error)}. Link WhatsApp again in Setup, then bind a chat from the thread.`;
        }
      }
      this.creationStage = "";
      this.createdThread = thread;
      clearWizardProgress();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  openCreatedThread(): void {
    this.stopProofCheck();
    if (this.createdThread) this.created.emit(this.createdThread);
  }

  // Watches the new thread for a message from WhatsApp and the agent's reply.
  private startProofCheck(threadId: string): void {
    const check = async () => {
      try {
        const response = await firstValueFrom(this.api.threadMessages(threadId, 50));
        this.proof = whatsappRoundTrip(response.messages || []);
        if (this.proof.inbound && !this.inboundAt) this.inboundAt = Date.now();
        this.cdr.markForCheck();
        if (this.proof.reply) this.stopProofCheck();
      } catch {
        // Keep polling; the thread may still be starting.
      }
    };
    void check();
    this.proofStartedAt = Date.now();
    this.inboundAt = 0;
    this.proofTimer = setInterval(() => void check(), 3000);
  }

  // Help text when the WhatsApp check takes longer than it normally does.
  proofHint(): string {
    if (this.proof.reply || !this.proofStartedAt) return "";
    const now = Date.now();
    if (this.proof.inbound) {
      return now - this.inboundAt > 90_000
        ? "Your message arrived, but the agent has not answered yet. The first start can take a minute or two. Open the conversation to see what it is doing."
        : "";
    }
    return now - this.proofStartedAt > 45_000
      ? "Nothing received yet. Check that you wrote in \"Message yourself\" (your own name, marked \"You\") on the phone you linked, and that the phone is online. You can also open the conversation and type there."
      : "";
  }

  private threadId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "orkest";
    return slug;
  }

  private async startVirtualDesk(thread: ThreadSummary): Promise<void> {
    const slug = this.desktopSlug();
    await firstValueFrom(this.api.replaceThreadDesktopGrants(thread.id, [{
      desktopSlug: slug,
      permissions: ["discover", "acquire", "operate", "share"],
    }], "first_thread_desktop"));
    const acquired = await firstValueFrom(this.api.acquireDesktopLease(slug, {
      threadId: thread.id,
      reason: "oss_demo_first_thread",
    }));
    await firstValueFrom(this.api.browserAction(slug, "start", {
      threadId: thread.id,
      fencingToken: acquired.lease?.fencingToken,
      reason: "oss_demo_first_thread",
    }));
  }

  private errorText(error: unknown): string {
    const value = error as { error?: { message?: string; error?: string }; message?: string };
    return value?.error?.message || value?.error?.error || value?.message || String(error);
  }
}

function configuredWhatsAppAccessMode(status: SetupStatus | null): WhatsAppAccessMode {
  const settings = (status?.settings || {}) as Record<string, unknown>;
  const connectors = (settings["connectors"] || {}) as Record<string, Record<string, unknown>>;
  const mode = String(connectors["whatsapp"]?.["accessMode"] || "").toLowerCase();
  return normalizeWhatsAppAccessMode(mode) || "self_hosted";
}

function normalizeWhatsAppAccessMode(value: unknown): WhatsAppAccessMode | null {
  const mode = String(value || "").toLowerCase();
  if (["self_hosted", "own", "local"].includes(mode)) return "self_hosted";
  if (["managed", "relay", "external"].includes(mode)) return "managed";
  return null;
}

// True once a message that arrived from WhatsApp is followed by an assistant reply.
export function whatsappRoundTrip(messages: ThreadMessage[]): { inbound: boolean; reply: boolean } {
  const index = messages.findIndex((message) => message.role === "user" &&
    (String(message.source || "").startsWith("whatsapp") || message["originSurface"] === "whatsapp"));
  if (index < 0) return { inbound: false, reply: false };
  const reply = messages.slice(index + 1).some((message) => message.role === "assistant" && Boolean(String(message.text || "").trim()));
  return { inbound: true, reply };
}
