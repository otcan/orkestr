import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, LlmAccountProfile, SetupStatus, ThreadMessage, ThreadSummary } from "./api.service";
import { WhatsAppPairPanelComponent } from "./whatsapp-pair-panel.component";

type WizardStepId = "welcome" | "codex" | "whatsapp" | "review";
type WhatsAppAccessMode = "relay" | "own";

@Component({
  selector: "ork-first-thread-wizard",
  imports: [FormsModule, WhatsAppPairPanelComponent],
  templateUrl: "./first-thread-wizard.component.html",
})
export class FirstThreadWizardComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() canCancel = true;
  @Input() setupStatus: SetupStatus | null = null;
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<ThreadSummary>();
  @Output() setupRequested = new EventEmitter<"codex">();

  readonly steps: Array<{ id: WizardStepId; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "codex", label: "Coding agent" },
    { id: "whatsapp", label: "WhatsApp" },
    { id: "review", label: "Start" },
  ];

  stepIndex = 0;
  threadName = "orkest";
  repoUrl = "";
  whatsappAccessMode: WhatsAppAccessMode = "own";
  readonly whatsappAccountId = "account-1";
  whatsappReady = false;
  whatsappWarning = "";
  // After creation in self-hosted mode: the bound chat and the live check.
  createdThread: ThreadSummary | null = null;
  boundChatName = "";
  proof = { inbound: false, reply: false };
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

  ngOnInit(): void {
    this.whatsappAccessMode = configuredWhatsAppAccessMode(this.setupStatus);
    void this.loadClaudeAccounts();
  }

  ngOnDestroy(): void {
    if (this.proofTimer) clearInterval(this.proofTimer);
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
    return this.steps[this.stepIndex]?.id || "name";
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
  }

  previous(): void {
    if (this.stepIndex <= 0 || this.busy) return;
    this.stepIndex -= 1;
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
    if (step === "welcome") return Boolean(this.agentName());
    if (step === "codex") return this.agentReady();
    if (step === "whatsapp") return Boolean(this.whatsappAccessMode);
    return true;
  }

  canCreate(): boolean {
    return Boolean(this.agentName() && this.agentReady() && !this.busy);
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
    return this.usesRemoteRepo() ? "Clone Git repository" : "New local git repository";
  }

  desktopSlug(): string {
    const settings = this.setupStatus?.settings || {};
    const desktops = settings["desktops"] && typeof settings["desktops"] === "object"
      ? settings["desktops"] as Record<string, unknown>
      : {};
    return String(desktops["default"] || desktops["manualIntervention"] || "desktop").trim() || "desktop";
  }

  whatsappAccessLabel(): string {
    if (this.whatsappAccessMode !== "own") return "Orkestr relay";
    return this.whatsappReady ? "Own WhatsApp (linked) · a private group will be created" : "Own WhatsApp · not linked yet, connect later in Setup";
  }

  onWhatsAppReady(ready: boolean): void {
    this.whatsappReady = ready;
    this.cdr.markForCheck();
  }

  selectWhatsAppAccessMode(mode: WhatsAppAccessMode): void {
    if (this.busy) return;
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
    if (!account) return "Create and verify a Claude Code subscription profile under Tools → Models first.";
    return account.state === "ready" ? `${account.label} is ready.` : `${account.label} is ${account.state.replace(/_/g, " ")}. Verify its attended login under Tools → Models.`;
  }

  codexBlocked(): boolean {
    return Boolean(this.setupStatus && !this.codexReady());
  }

  codexStateLabel(): string {
    const connector = this.codexConnector();
    const state = String(connector?.state || "checking").toLowerCase();
    const reason = String(connector?.details?.["reason"] || "").toLowerCase();
    if (state === "connected") return "connected";
    if (state === "partial") return "sign-in required";
    if (state === "not_connected" && reason === "codex_missing") return "runtime missing";
    if (state === "not_connected" && reason.includes("disabled")) return "disabled";
    if (state === "not_connected") return "runtime unavailable";
    return state.replace(/_/g, " ");
  }

  codexSummary(): string {
    if (this.codexReady()) return this.codexConnector()?.summary || "Codex Agent is connected.";
    const summary = this.codexConnector()?.summary || "Checking Codex Agent status.";
    return `${summary} Connect Codex Agent before creating or opening workspaces.`;
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
      this.creationStage = "Saving WhatsApp access choice";
      await firstValueFrom(this.api.saveSetupDemoPreferences({
        whatsappAccessMode: this.whatsappAccessMode,
      }));
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
      await this.startVirtualDesk(thread).catch((error) => {
        this.desktopWarning = `Virtual Desk did not start: ${this.errorText(error)}. Open setup desktops after the thread opens.`;
      });
      this.creationStage = this.runtimeProvider === "claude-code" ? "Starting Claude Code in background" : "Starting Codex in background";
      if (this.whatsappAccessMode === "own" && this.whatsappReady) {
        this.creationStage = "Creating your private WhatsApp group";
        try {
          const group = await firstValueFrom(this.api.createWhatsAppThreadGroup({ threadId: thread.id, name: name }));
          this.boundChatName = group.chat?.name || name;
          this.createdThread = thread;
          this.startProofCheck(thread.id);
          return;
        } catch (error) {
          this.whatsappWarning = `The WhatsApp group could not be created: ${this.errorText(error)}. You can bind a chat later from the thread.`;
        }
      }
      this.created.emit(thread);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  openCreatedThread(): void {
    if (this.proofTimer) clearInterval(this.proofTimer);
    if (this.createdThread) this.created.emit(this.createdThread);
  }

  // Watches the new thread for a message from WhatsApp and the agent's reply.
  private startProofCheck(threadId: string): void {
    const check = async () => {
      try {
        const response = await firstValueFrom(this.api.threadMessages(threadId, 50));
        this.proof = whatsappRoundTrip(response.messages || []);
        this.cdr.markForCheck();
        if (this.proof.reply && this.proofTimer) clearInterval(this.proofTimer);
      } catch {
        // Keep polling; the thread may still be starting.
      }
    };
    void check();
    this.proofTimer = setInterval(() => void check(), 3000);
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
  return mode === "relay" ? "relay" : "own";
}

// True once a message that arrived from WhatsApp is followed by an assistant reply.
export function whatsappRoundTrip(messages: ThreadMessage[]): { inbound: boolean; reply: boolean } {
  const index = messages.findIndex((message) => message.role === "user" &&
    (String(message.source || "").startsWith("whatsapp") || message["originSurface"] === "whatsapp"));
  if (index < 0) return { inbound: false, reply: false };
  const reply = messages.slice(index + 1).some((message) => message.role === "assistant" && Boolean(String(message.text || "").trim()));
  return { inbound: true, reply };
}
