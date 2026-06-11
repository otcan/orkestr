import { Component, EventEmitter, Input, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, SetupStatus, ThreadSummary } from "./api.service";

type WizardStepId = "welcome" | "codex" | "whatsapp" | "review";
type WhatsAppAccessMode = "relay" | "own";

@Component({
  selector: "ork-first-thread-wizard",
  imports: [FormsModule],
  templateUrl: "./first-thread-wizard.component.html",
})
export class FirstThreadWizardComponent {
  private readonly api = inject(ApiService);

  @Input() canCancel = true;
  @Input() setupStatus: SetupStatus | null = null;
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<ThreadSummary>();
  @Output() setupRequested = new EventEmitter<"codex">();

  readonly steps: Array<{ id: WizardStepId; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "codex", label: "Connect Codex" },
    { id: "whatsapp", label: "WhatsApp" },
    { id: "review", label: "Start" },
  ];

  stepIndex = 0;
  threadName = "orkest";
  repoUrl = "";
  whatsappAccessMode: WhatsAppAccessMode = "relay";
  busy = false;
  error = "";
  desktopWarning = "";
  creationStage = "";
  private draftName = "";
  private draftThreadId = "";

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
    if (step === "codex") return this.codexReady();
    if (step === "whatsapp") return Boolean(this.whatsappAccessMode);
    return true;
  }

  canCreate(): boolean {
    return Boolean(this.agentName() && this.codexReady() && !this.busy);
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
    return this.whatsappAccessMode === "own" ? "Own WhatsApp bridge" : "Orkestr relay";
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
      let shouldWake = this.codexReady();
      if (!this.codexReady()) {
        const setup = await firstValueFrom(this.api.setupStatus());
        this.setupStatus = setup;
        shouldWake = this.codexReady();
      }
      if (!shouldWake) {
        this.error = this.codexSummary();
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
        executorId: "codex",
        codexMode: "code",
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
      this.creationStage = "Starting Codex in background";
      this.created.emit(thread);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
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
    await firstValueFrom(this.api.acquireDesktopLease(slug, {
      threadId: thread.id,
      reason: "oss_demo_first_thread",
    }));
    await firstValueFrom(this.api.browserAction(slug, "start", {
      threadId: thread.id,
      reason: "oss_demo_first_thread",
    }));
  }

  private errorText(error: unknown): string {
    const value = error as { error?: { message?: string; error?: string }; message?: string };
    return value?.error?.message || value?.error?.error || value?.message || String(error);
  }
}
