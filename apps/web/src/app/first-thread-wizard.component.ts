import { Component, EventEmitter, Input, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadSummary, WorkspaceFolderEntry } from "./api.service";

type WizardStepId = "name" | "workspace" | "review";
type WorkspaceMode = "" | "workspace" | "clone";

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
    { id: "workspace", label: "Workspace" },
    { id: "review", label: "Create" },
  ];

  stepIndex = 0;
  threadName = "";
  workspaceMode: WorkspaceMode = "";
  workspace = "";
  workFolder = "";
  repoUrl = "";
  cloneTarget = "";
  folderBrowserOpen = false;
  folderLoading = false;
  folderError = "";
  folderPath = "";
  folderRoots: WorkspaceFolderEntry[] = [];
  folderEntries: WorkspaceFolderEntry[] = [];
  folderParent: string | null = null;
  busy = false;
  error = "";
  creationStage = "";

  activeStep(): WizardStepId {
    return this.steps[this.stepIndex]?.id || "name";
  }

  progressPercent(): number {
    return Math.round(((this.stepIndex + 1) / this.steps.length) * 100);
  }

  stepDone(index: number): boolean {
    return index < this.stepIndex;
  }

  chooseWorkspaceMode(mode: Exclude<WorkspaceMode, "">): void {
    this.workspaceMode = mode;
    if (mode === "workspace") {
      this.folderBrowserOpen = true;
      void this.loadWorkspaceFolders(this.workspace.trim());
    } else {
      void this.loadWorkspaceFolders("");
    }
  }

  async toggleWorkspaceBrowser(): Promise<void> {
    if (this.busy) return;
    this.folderBrowserOpen = !this.folderBrowserOpen;
    if (this.folderBrowserOpen) await this.loadWorkspaceFolders(this.workspace.trim());
  }

  async loadWorkspaceFolders(targetPath = ""): Promise<void> {
    if (this.busy && !this.folderBrowserOpen) return;
    this.folderLoading = true;
    this.folderError = "";
    try {
      const response = await firstValueFrom(this.api.workspaceFolders(targetPath));
      this.folderPath = response.path || targetPath;
      this.folderParent = response.parent || null;
      this.folderRoots = response.roots || [];
      this.folderEntries = response.entries || [];
      if (!response.ok) this.folderError = response.error || "Folder cannot be opened.";
      if (!this.workspace.trim() && response.ok && response.path) this.workspace = response.path;
    } catch (error) {
      this.folderError = this.errorText(error);
      this.folderEntries = [];
    } finally {
      this.folderLoading = false;
    }
  }

  async browseWorkspaceFolder(folderPath: string): Promise<void> {
    if (this.busy) return;
    this.workspace = folderPath;
    await this.loadWorkspaceFolders(folderPath);
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
    if (step === "workspace") return this.workspaceReady();
    return true;
  }

  canCreate(): boolean {
    return Boolean(this.agentName() && this.workspaceReady() && !this.busy);
  }

  agentName(): string {
    return this.threadName.trim();
  }

  workspaceReady(): boolean {
    if (this.workFolderInvalid()) return false;
    if (this.workspaceMode === "workspace") return Boolean(this.workspace.trim());
    if (this.workspaceMode === "clone") return Boolean(this.repoUrl.trim() && this.cloneWorkspacePath());
    return false;
  }

  workspaceModeLabel(): string {
    if (this.workspaceMode === "clone") return "Clone repo";
    if (this.workspaceMode === "workspace") return "Existing workspace";
    return "Not selected";
  }

  cloneWorkspacePath(): string {
    return this.cloneTarget.trim() || this.suggestedCloneTarget();
  }

  codebasePath(): string {
    return this.workspaceMode === "clone" ? this.cloneWorkspacePath() : this.workspace.trim();
  }

  finalWorkFolder(): string {
    return this.normalizeWorkFolder(this.workFolder);
  }

  finalWorkspacePath(): string {
    const root = this.codebasePath();
    const folder = this.finalWorkFolder();
    return folder ? `${root.replace(/\/+$/, "")}/${folder}` : root;
  }

  suggestedCloneTarget(): string {
    return `${this.defaultWorkspaceRoot().replace(/\/+$/, "")}/${this.repoSlug(this.repoUrl)}`;
  }

  workFolderInvalid(): boolean {
    const raw = this.workFolder.trim();
    if (!raw) return false;
    const normalized = this.normalizeWorkFolder(raw);
    return !normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..";
  }

  workFolderError(): string {
    return this.workFolderInvalid() ? "Use a relative folder inside the codebase, like apps/web." : "";
  }

  async createAndStart(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy = true;
    this.error = "";
    try {
      const name = this.agentName();
      const codebase = this.codebasePath();
      const workspace = this.finalWorkspacePath();
      const workFolder = this.finalWorkFolder();
      this.creationStage = this.workspaceMode === "clone" ? "Cloning repo" : "Creating agent";
      const response = await firstValueFrom(this.api.createThread({
        id: this.threadId(name),
        name,
        title: name,
        bindingName: name,
        wakePolicy: "wake-on-message",
        executorId: "codex",
        codexMode: "code",
        desiredCodexMode: "code",
        workspace: codebase,
        cwd: workspace,
        repoPath: codebase,
        workFolder,
        workdirRelativePath: workFolder,
        repoRemoteUrl: this.workspaceMode === "clone" ? this.repoUrl.trim() : "",
        cloneRepo: this.workspaceMode === "clone",
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

  private repoSlug(repoUrl: string): string {
    const raw = String(repoUrl || "").trim();
    const fallback = this.agentName() || "repo";
    const withoutGit = raw.replace(/\.git$/i, "");
    const tail = withoutGit.split(/[/:]/).filter(Boolean).at(-1) || fallback;
    return tail
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "repo";
  }

  private defaultWorkspaceRoot(): string {
    return this.folderRoots[0]?.path || "/workspace";
  }

  private normalizeWorkFolder(value: string): string {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "");
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
