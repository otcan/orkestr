import { Component, EventEmitter, Input, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, SetupStatus, ThreadSummary } from "./api.service";

type WizardStepId = "task" | "workspace" | "runtime" | "review";
type CodexMode = "code" | "plan";
type WorkspaceMode = "isolated" | "repo";

interface ThreadTemplate {
  id: string;
  label: string;
  task: string;
  mode: CodexMode;
}

@Component({
  selector: "ork-first-thread-wizard",
  imports: [FormsModule],
  templateUrl: "./first-thread-wizard.component.html",
})
export class FirstThreadWizardComponent {
  private readonly api = inject(ApiService);

  @Input() setupStatus: SetupStatus | null = null;
  @Input() canCancel = true;
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<ThreadSummary>();

  readonly steps: Array<{ id: WizardStepId; label: string }> = [
    { id: "task", label: "Task" },
    { id: "workspace", label: "Workspace" },
    { id: "runtime", label: "Runtime" },
    { id: "review", label: "Start" },
  ];
  readonly templates: ThreadTemplate[] = [
    {
      id: "repo-review",
      label: "Review this repo",
      task: "Inspect this repository and list the top three public-launch blockers. Do not edit files yet.",
      mode: "plan",
    },
    {
      id: "fix-test",
      label: "Fix a failing test",
      task: "Find the failing test, explain the cause briefly, implement the smallest fix, and run the relevant test again.",
      mode: "code",
    },
    {
      id: "readme",
      label: "Improve README",
      task: "Review the README for a first-time user, then make focused edits that clarify install, setup, and first use.",
      mode: "code",
    },
    {
      id: "feature",
      label: "Build a small feature",
      task: "Implement the requested feature with focused code changes, add or update tests, and summarize the result.",
      mode: "code",
    },
  ];

  stepIndex = 0;
  task = "";
  threadName = "";
  workspaceMode: WorkspaceMode = "isolated";
  workspace = "/workspace";
  codexMode: CodexMode = "code";
  busy = false;
  error = "";
  creationStage = "";

  activeStep(): WizardStepId {
    return this.steps[this.stepIndex]?.id || "task";
  }

  progressPercent(): number {
    return Math.round(((this.stepIndex + 1) / this.steps.length) * 100);
  }

  stepDone(index: number): boolean {
    return index < this.stepIndex;
  }

  applyTemplate(template: ThreadTemplate): void {
    this.task = template.task;
    this.codexMode = template.mode;
    if (!this.threadName.trim()) this.threadName = template.label;
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
    if (step === "task") return Boolean(this.task.trim());
    if (step === "workspace") return Boolean(this.workspace.trim());
    return true;
  }

  canCreate(): boolean {
    return Boolean(this.task.trim() && this.workspace.trim() && !this.busy);
  }

  selectedWorkspaceLabel(): string {
    return this.workspaceMode === "isolated" ? "Isolated workspace" : "Existing repo path";
  }

  suggestedThreadName(): string {
    const explicit = this.threadName.trim();
    if (explicit) return explicit;
    const firstLine = this.task.trim().split(/\n+/)[0] || "Coding Agent";
    return firstLine.replace(/[.?!:]$/, "").slice(0, 72) || "Coding Agent";
  }

  openAiConnector(): ConnectorStatus | null {
    return this.connector("openai");
  }

  codexConnector(): ConnectorStatus | null {
    return this.connector("codex");
  }

  connectorReady(id: string): boolean {
    return this.connector(id)?.state === "connected";
  }

  connectorSummary(id: string): string {
    const connector = this.connector(id);
    return connector?.summary || "Not checked yet.";
  }

  async createAndStart(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy = true;
    this.error = "";
    try {
      const name = this.suggestedThreadName();
      const workspace = this.workspace.trim() || "/workspace";
      this.creationStage = "Creating thread";
      const response = await firstValueFrom(this.api.createThread({
        id: this.threadId(name),
        name,
        title: name,
        bindingName: name,
        wakePolicy: "wake-on-message",
        executorId: "codex",
        codexMode: this.codexMode,
        desiredCodexMode: this.codexMode,
        workspace,
        cwd: workspace,
        repoPath: this.workspaceMode === "repo" ? workspace : "",
      }));
      const thread = response.thread;
      this.creationStage = "Sending task";
      await firstValueFrom(this.api.sendThreadInput(thread.id, this.task.trim()));
      this.creationStage = "Starting Codex";
      await firstValueFrom(this.api.wakeThread(thread.id));
      this.creationStage = "Agent running";
      this.created.emit(thread);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private connector(id: string): ConnectorStatus | null {
    return this.setupStatus?.connectors?.find((connector) => connector.id === id) || null;
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
