import { Component, EventEmitter, Input, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadSummary } from "./api.service";

type WizardStepId = "name" | "repository" | "review";

@Component({
  selector: "ork-first-thread-wizard",
  imports: [FormsModule],
  templateUrl: "./first-thread-wizard.component.html",
})
export class FirstThreadWizardComponent {
  private readonly api = inject(ApiService);

  @Input() canCancel = true;
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<ThreadSummary>();

  readonly steps: Array<{ id: WizardStepId; label: string }> = [
    { id: "name", label: "Name" },
    { id: "repository", label: "Repository" },
    { id: "review", label: "Create" },
  ];

  stepIndex = 0;
  threadName = "";
  repoUrl = "";
  busy = false;
  error = "";
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
    if (step === "name") return Boolean(this.agentName());
    if (step === "repository") return true;
    return true;
  }

  canCreate(): boolean {
    return Boolean(this.agentName() && !this.busy);
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
    try {
      const name = this.agentName();
      const repoUrl = this.repoUrlValue();
      const cloneRepo = Boolean(repoUrl);
      this.creationStage = cloneRepo ? "Cloning repo" : "Initializing local git repo";
      const response = await firstValueFrom(this.api.createThread({
        id: this.generatedWorkspaceName(),
        name,
        title: name,
        bindingName: name,
        wakePolicy: "wake-on-message",
        executorId: "codex",
        codexMode: "code",
        desiredCodexMode: "code",
        autoWorkspace: true,
        initGit: !cloneRepo,
        repoRemoteUrl: repoUrl,
        cloneRepo,
      }));
      const thread = response.thread;
      this.creationStage = "Starting Codex";
      await firstValueFrom(this.api.wakeThread(thread.id));
      this.creationStage = "Agent ready";
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
      .slice(0, 48) || "coding-agent";
    return `${slug}-${Date.now().toString(36)}`;
  }

  private errorText(error: unknown): string {
    const value = error as { error?: { message?: string; error?: string }; message?: string };
    return value?.error?.message || value?.error?.error || value?.message || String(error);
  }
}
