import { DatePipe } from "@angular/common";
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { FirstThreadWizardComponent } from "./first-thread-wizard.component";
import { OnboardingPageComponent } from "./onboarding-page.component";
import { OpsPageComponent, ToolsView } from "./ops-page.component";
import { RawTerminalController } from "./raw-terminal.controller";
import { renderMessageTextHtml } from "./message-renderer";
import {
  ApiService,
  SetupStatus,
  ThreadAttachResponse,
  ThreadMessage,
  ThreadSummary,
  TimerRecord,
} from "./api.service";
import { appendPendingFiles, messageWithAttachmentPaths, PendingFile, removePendingFile, uploadPendingFiles } from "./thread-uploads";

type Panel = "chat" | "history" | "timers" | "attach" | "settings" | "workers" | "runtime" | "raw" | "ops";
type CodexRateLimitKey = "primary" | "secondary";
type PersistedThreadTextField =
  | "draft"
  | "sidebarWorkerTask"
  | "timerLabel"
  | "timerCadence"
  | "timerTime"
  | "timerPrompt"
  | "approveText"
  | "interruptText";

@Component({
  selector: "ork-root",
  imports: [DatePipe, FormsModule, FirstThreadWizardComponent, OpsPageComponent, OnboardingPageComponent],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit, OnDestroy, AfterViewChecked {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly popStateHandler = () => {
    this.onboardingActive = this.onboardingFromPath();
    this.selectedId = this.idFromPath();
    this.activePanel = this.panelFromPath();
    this.toolsView = this.toolsViewFromPath();
    this.normalizeLegacyRoutePath();
    if (this.onboardingActive) {
      this.closeRawStream();
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (this.activePanel === "ops") {
      this.closeRawStream();
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    this.syncThreadTextState(this.selectedThread(), true);
    void this.loadSelectedThread(true);
  };

  @ViewChild("messagePane") private readonly messagePane?: ElementRef<HTMLElement>;
  @ViewChild("rawTerminalHost") private readonly rawTerminalHost?: ElementRef<HTMLElement>;

  threads: ThreadSummary[] = [];
  readonly messageCache = signal<Record<string, ThreadMessage[]>>({});
  readonly loadingThreadIds = signal<Record<string, boolean>>({});
  readonly activeThreadIds = signal<Record<string, number>>({});
  historyMessages: ThreadMessage[] = [];
  timers: TimerRecord[] = [];
  allTimers: TimerRecord[] = [];
  runtimeDetails: Record<string, unknown> | null = null;
  attachDetails: ThreadAttachResponse | null = null;
  opsSystem: Record<string, unknown> | null = null;
  setupStatus: SetupStatus | null = null;
  selectedId = "";
  filterText = "";
  draft = "";
  error = "";
  apiOnline = false;
  busy = false;
  sending = false;
  threadWizardOpen = false;
  onboardingActive = false;
  activePanel: Panel = "chat";
  toolsView: ToolsView = "system";
  approveText = "Approved. Proceed.";
  interruptText = "";
  timerLabel = "Thread timer";
  timerCadence = "daily";
  timerTime = "09:00";
  timerPrompt = "";
  workerModalOpen = false;
  modelDetailsOpen = false;
  creatingWorker = false;
  workerLabel = "Worker 1";
  workerTask = "";
  workerRepoPath = "";
  workerBranchName = "";
  workerAutoRun = true;
  threadRepoDraft = "";
  threadBranchDraft = "";
  threadMetaThreadId = "";
  savingThreadMeta = false;
  detectingThreadRepo = false;
  whatsappBindingThreadId = "";
  whatsappChatId = "";
  whatsappDisplayName = "";
  whatsappReplyPrefix = "otcanclaw:";
  whatsappOutboundAccountId = "";
  whatsappBindingEnabled = true;
  whatsappAllowOtherPeople = true;
  whatsappMirrorToWhatsApp = true;
  savingThreadBinding = false;
  sidebarWorkerTask = "";
  creatingSidebarWorker = false;
  creatingWorkerParentId = "";
  pendingFiles: PendingFile[] = [];
  draggingUpload = false;
  rawConnectionState = "idle";
  rawConnectionDetail = "";
  sidebarWidth = 460;
  sidebarResizing = false;

  private fallbackPoller?: ReturnType<typeof setInterval>;
  private systemPoller?: ReturnType<typeof setInterval>;
  private summaryReconnectTimer?: ReturnType<typeof setTimeout>;
  private summarySocket?: WebSocket;
  private destroyed = false;
  private applyingSummary = false;
  private readonly rawTerminal = new RawTerminalController({
    host: () => this.rawTerminalHost?.nativeElement || null,
    isActive: () => this.activePanel === "raw",
    onStatus: (state, detail) => {
      this.rawConnectionState = state;
      this.rawConnectionDetail = detail;
      this.renderNow();
    },
  });
  private shouldStickToBottom = true;
  private scrollAfterRender = true;
  private scrollFrame = 0;
  private readonly lastActivityByThread = new Map<string, number>();
  private readonly threadLoadTokens = new Map<string, number>();
  private threadLoadSequence = 0;
  private textStateThreadId = "";
  private readonly readStateVersionKey = "orkestr.threadRead.initialized.v1";
  private readonly sidebarWidthKey = "orkestr.sidebar.width.v1";
  private readonly sidebarDefaultWidth = 460;
  private readonly sidebarMinWidth = 320;
  private readonly sidebarMaxWidth = 760;
  private sidebarResizeStartX = 0;
  private sidebarResizeStartWidth = 0;
  private readonly sidebarResizeMove = (event: Event) => {
    const pointer = event as PointerEvent;
    const nextWidth = this.sidebarResizeStartWidth + pointer.clientX - this.sidebarResizeStartX;
    this.sidebarWidth = this.clampSidebarWidth(nextWidth);
    this.persistSidebarWidth();
    this.renderNow();
  };
  private readonly sidebarResizeEnd = () => {
    if (!this.sidebarResizing) return;
    this.sidebarResizing = false;
    this.persistSidebarWidth();
    globalThis.removeEventListener?.("pointermove", this.sidebarResizeMove);
    globalThis.removeEventListener?.("pointerup", this.sidebarResizeEnd);
    globalThis.document?.body?.classList.remove("sidebar-resizing-body");
    this.renderNow();
  };
  private readonly threadTextDefaults: Record<PersistedThreadTextField, string> = {
    draft: "",
    sidebarWorkerTask: "",
    timerLabel: "Thread timer",
    timerCadence: "daily",
    timerTime: "09:00",
    timerPrompt: "",
    approveText: "Approved. Proceed.",
    interruptText: "",
  };

  ngOnInit(): void {
    this.onboardingActive = this.onboardingFromPath();
    this.selectedId = this.idFromPath();
    this.activePanel = this.panelFromPath();
    this.toolsView = this.toolsViewFromPath();
    this.sidebarWidth = this.loadSidebarWidth();
    this.normalizeLegacyRoutePath();
    globalThis.addEventListener?.("popstate", this.popStateHandler);
    void this.refresh(true);
    this.connectSummaryStream();
    this.systemPoller = setInterval(() => void this.loadSystemSummarySilent(), 30_000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopFallbackPolling();
    if (this.systemPoller) clearInterval(this.systemPoller);
    if (this.summaryReconnectTimer) clearTimeout(this.summaryReconnectTimer);
    this.summarySocket?.close();
    if (this.scrollFrame && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(this.scrollFrame);
    }
    this.rawTerminal.dispose();
    this.sidebarResizeEnd();
    globalThis.removeEventListener?.("popstate", this.popStateHandler);
  }

  ngAfterViewChecked(): void {
    if (!this.scrollAfterRender) return;
    this.scrollMessagePaneToBottom();
  }

  async refresh(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [threadsResult, systemResult, setupResult, timersResult] = await Promise.allSettled([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.timers()),
      ]);
      if (threadsResult.status === "rejected") throw threadsResult.reason;
      const payload = threadsResult.value;
      if (systemResult.status === "fulfilled") this.opsSystem = systemResult.value;
      if (setupResult.status === "fulfilled") this.setupStatus = setupResult.value;
      if (timersResult.status === "fulfilled") this.allTimers = timersResult.value.timers || [];
      this.apiOnline = true;
      this.trackThreadActivity(payload.threads);
      this.threads = [...payload.threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      this.seedReadStateIfNeeded(this.threads);
      if (this.shouldAutoOpenOnboarding()) {
        this.onboardingActive = true;
        this.replaceOnboardingPath();
      }
      if (this.onboardingActive) {
        this.updateDocumentTitle();
        this.error = "";
        return;
      }
      if (this.activePanel !== "ops" && !this.selectedId && this.threads.length) {
        this.selectedId = this.threadSlug(this.threads[0]);
        this.replacePath(this.selectedId, this.activePanel);
      }
      const selected = this.selectedThread();
      this.syncThreadMetaDraft(selected);
      this.syncThreadBindingDraft(selected);
      this.syncThreadTextState(selected);
      await this.loadSelectedThread(false);
      this.updateDocumentTitle();
      this.error = "";
    } catch (error) {
      this.apiOnline = false;
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  private connectSummaryStream(): void {
    if (this.destroyed || typeof globalThis.WebSocket === "undefined") {
      this.startFallbackPolling();
      return;
    }
    if (this.summarySocket && this.summarySocket.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket(this.api.threadSummaryStreamUrl());
    this.summarySocket = socket;
    socket.onopen = () => {
      if (this.summarySocket !== socket) return;
      this.apiOnline = true;
      this.stopFallbackPolling();
      this.renderNow();
    };
    socket.onmessage = (event) => {
      void this.handleSummaryStreamMessage(event.data);
    };
    socket.onclose = () => {
      if (this.summarySocket !== socket) return;
      this.summarySocket = undefined;
      this.startFallbackPolling();
      this.scheduleSummaryReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleSummaryReconnect(): void {
    if (this.destroyed || this.summaryReconnectTimer) return;
    this.summaryReconnectTimer = setTimeout(() => {
      this.summaryReconnectTimer = undefined;
      this.connectSummaryStream();
    }, 5000);
  }

  private startFallbackPolling(): void {
    if (this.fallbackPoller) return;
    this.fallbackPoller = setInterval(() => void this.refresh(false), 30_000);
  }

  private stopFallbackPolling(): void {
    if (!this.fallbackPoller) return;
    clearInterval(this.fallbackPoller);
    this.fallbackPoller = undefined;
  }

  private async loadSystemSummarySilent(): Promise<void> {
    try {
      this.opsSystem = await firstValueFrom(this.api.systemSummary());
      this.renderNow();
    } catch {
      // System telemetry is best-effort and should not surface as a chat error.
    }
  }

  private async handleSummaryStreamMessage(raw: unknown): Promise<void> {
    let payload: { type?: string; threads?: ThreadSummary[] };
    try {
      payload = JSON.parse(String(raw || "{}"));
    } catch {
      return;
    }
    if (payload.type !== "threads_summary" || !Array.isArray(payload.threads)) return;
    await this.applyThreadSummaryStream(payload.threads);
  }

  private async applyThreadSummaryStream(threads: ThreadSummary[]): Promise<void> {
    if (this.applyingSummary) return;
    this.applyingSummary = true;
    try {
      const previousSelected = this.selectedThread();
      const previousSignature = this.threadReloadSignature(previousSelected);
      this.apiOnline = true;
      this.threads = [...threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      this.seedReadStateIfNeeded(this.threads);
      if (this.activePanel !== "ops" && !this.selectedId && this.threads.length) {
        this.selectedId = this.threadSlug(this.threads[0]);
        this.replacePath(this.selectedId, this.activePanel);
      }
      const selected = this.selectedThread();
      this.syncThreadMetaDraft(selected);
      this.syncThreadBindingDraft(selected);
      this.syncThreadTextState(selected);
      const nextSignature = this.threadReloadSignature(selected);
      const cachedMessages = selected ? this.messageCache()[selected.id] || [] : [];
      if (selected && (!cachedMessages.length || previousSignature !== nextSignature)) {
        await this.loadSelectedThread(false);
      }
      this.updateDocumentTitle();
      this.error = "";
      this.renderNow();
    } finally {
      this.applyingSummary = false;
    }
  }

  async selectThread(thread: ThreadSummary, event: MouseEvent): Promise<void> {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    await this.activateThread(thread);
  }

  async activateThread(thread: ThreadSummary): Promise<void> {
    const nextPanel = this.activePanel === "raw" ? "raw" : "chat";
    this.threadWizardOpen = false;
    this.selectedId = this.threadSlug(thread);
    this.activePanel = nextPanel;
    this.modelDetailsOpen = false;
    this.pushPath(this.selectedId, this.activePanel);
    this.beginThreadLoad(thread.id);
    this.clearThreadPanelState();
    this.syncThreadMetaDraft(thread, true);
    this.syncThreadBindingDraft(thread, true);
    this.syncThreadTextState(thread, true);
    this.updateDocumentTitle();
    this.renderNow();
    await this.loadSelectedThread(true);
    this.renderNow();
  }

  private clearThreadPanelState(): void {
    this.historyMessages = [];
    this.timers = [];
    this.runtimeDetails = null;
    this.attachDetails = null;
    this.closeRawStream();
    this.shouldStickToBottom = this.activePanel === "chat";
    this.scrollAfterRender = this.activePanel === "chat";
  }

  async openPanel(panel: Panel): Promise<void> {
    if (panel === "ops") {
      this.openTools(this.toolsView);
      return;
    }
    this.modelDetailsOpen = false;
    if (this.activePanel === "raw" && panel !== "raw") this.closeRawStream();
    this.activePanel = panel;
    const thread = this.selectedThread();
    if (thread) this.pushPath(this.threadSlug(thread), panel);
    if (panel === "history") await this.loadHistory();
    if (panel === "timers") await this.loadTimers();
    if (panel === "runtime") await this.loadRuntime();
    if (panel === "raw") await this.loadRaw();
    if (panel === "settings") this.syncThreadBindingDraft(this.selectedThread(), true);
    if (panel === "chat") {
      this.queueMessagePaneScrollToBottom();
    }
    this.renderNow();
  }

  openTools(view: ToolsView = this.toolsView): void {
    if (this.activePanel === "raw") this.closeRawStream();
    this.modelDetailsOpen = false;
    this.threadWizardOpen = false;
    this.onboardingActive = false;
    this.toolsView = view;
    this.activePanel = "ops";
    this.pushOpsPath(view);
    this.updateDocumentTitle();
    this.renderNow();
  }

  setToolsView(view: ToolsView): void {
    this.toolsView = view;
    this.pushOpsPath(view);
    this.updateDocumentTitle();
  }

  openOnboarding(): void {
    if (this.activePanel === "raw") this.closeRawStream();
    this.threadWizardOpen = false;
    this.onboardingActive = true;
    this.clearOnboardingFlag("skipped");
    this.pushOnboardingPath();
    this.updateDocumentTitle();
    this.renderNow();
  }

  async leaveOnboarding(completed = false): Promise<void> {
    this.onboardingActive = false;
    this.writeOnboardingFlag(completed ? "completed" : "skipped");
    if (completed) {
      this.threadWizardOpen = true;
      this.activePanel = "chat";
      globalThis.history?.pushState({}, "", "/");
    } else {
      this.threadWizardOpen = false;
      this.activePanel = "ops";
      this.toolsView = "connectors";
      this.pushOpsPath("connectors");
    }
    this.updateDocumentTitle();
    await this.refresh(false);
  }

  openThreadWizard(): void {
    if (this.activePanel === "raw") this.closeRawStream();
    this.threadWizardOpen = true;
    this.onboardingActive = false;
    this.activePanel = "chat";
    this.modelDetailsOpen = false;
    this.updateDocumentTitle();
    this.renderNow();
  }

  closeThreadWizard(): void {
    if (!this.threads.length) return;
    this.threadWizardOpen = false;
    this.updateDocumentTitle();
    this.renderNow();
  }

  async handleThreadWizardCreated(thread: ThreadSummary): Promise<void> {
    this.threadWizardOpen = false;
    await this.refresh(false);
    const created = this.threads.find((candidate) => candidate.id === thread.id) || thread;
    await this.activateThread(created);
  }

  async sendMessage(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || this.sending) return;
    const originalText = this.draft.trim();
    if (!originalText && this.pendingFiles.length === 0) return;
    this.sending = true;
    try {
      const attachments = await uploadPendingFiles(this.api, thread.id, this.pendingFiles);
      const text = messageWithAttachmentPaths(originalText, attachments);
      this.markThreadActive(thread.id, 120_000);
      await firstValueFrom(this.api.sendThreadInput(thread.id, text, attachments));
      this.draft = "";
      this.clearThreadTextField(thread, "draft");
      this.pendingFiles = [];
      this.queueMessagePaneScrollToBottom();
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.sending = false;
    }
  }

  async wakeSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.wakeThread(thread.id));
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async sleepSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.sleepThread(thread.id));
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async recoverSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.recoverThread(thread.id));
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async approveSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.approveThread(thread.id, this.approveText.trim() || "Approved. Proceed."));
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async interruptSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.interruptThread(thread.id, this.interruptText.trim()));
      this.interruptText = "";
      this.clearThreadTextField(thread, "interruptText");
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async switchCodexMode(mode: "code" | "plan"): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.setCodexMode(thread.id, mode));
      if (result.thread) this.threads = this.threads.map((item) => item.id === result.thread?.id ? result.thread : item);
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  openModelDetails(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.selectedThread()) return;
    this.modelDetailsOpen = true;
    this.renderNow();
  }

  closeModelDetails(): void {
    if (!this.modelDetailsOpen) return;
    this.modelDetailsOpen = false;
    this.renderNow();
  }

  async loadHistory(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      const payload = await firstValueFrom(this.api.threadHistory(thread.id));
      this.historyMessages = payload.messages || [];
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async loadTimers(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      const payload = await firstValueFrom(this.api.threadTimers(thread.id));
      this.timers = payload.timers || [];
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async loadRuntime(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      this.runtimeDetails = (await firstValueFrom(this.api.threadRuntimeFull(thread.id))) as unknown as Record<string, unknown>;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async loadRaw(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      const [attach, runtime] = await Promise.all([
        firstValueFrom(this.api.attachThread(thread.id)),
        firstValueFrom(this.api.threadRuntimeFull(thread.id)).catch(() => null),
      ]);
      this.attachDetails = attach;
      if (runtime) this.runtimeDetails = runtime as unknown as Record<string, unknown>;
      if (attach.ok) this.openRawStream(thread);
      else this.closeRawStream();
    } catch (error) {
      this.error = this.errorText(error);
      this.closeRawStream();
    } finally {
      this.busy = false;
    }
  }

  async createTimer(): Promise<void> {
    const thread = this.selectedThread();
    const prompt = this.timerPrompt.trim();
    if (!thread || !prompt) return;
    this.busy = true;
    try {
      const body: Record<string, string> = {
        label: this.timerLabel.trim() || "Thread timer",
        cadence: this.timerCadence,
        prompt,
      };
      if (this.timerCadence === "interval") {
        body["every"] = this.timerTime.trim() || "1d";
      } else {
        body["time"] = this.timerTime.trim() || "09:00";
      }
      const payload = await firstValueFrom(this.api.createThreadTimer(thread.id, body));
      if (payload.timer) this.allTimers = this.upsertTimer(this.allTimers, payload.timer);
      this.timerPrompt = "";
      this.clearThreadTextField(thread, "timerPrompt");
      await this.loadTimers();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async deleteTimer(timer: TimerRecord): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.deleteThreadTimer(thread.id, timer.id));
      this.allTimers = this.allTimers.filter((item) => item.id !== timer.id);
      await this.loadTimers();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  openWorkerModal(): void {
    const thread = this.selectedThread();
    if (!thread) return;
    const nextIndex = this.childWorkers(thread).length + 1;
    this.workerLabel = `Worker ${nextIndex}`;
    this.workerRepoPath = this.workerRepoPath.trim() || this.defaultRepoPath(thread);
    this.workerBranchName = "";
    this.workerTask = this.workerTask.trim() || this.draft.trim();
    this.workerAutoRun = true;
    this.workerModalOpen = true;
    this.renderNow();
  }

  closeWorkerModal(): void {
    if (this.creatingWorker) return;
    this.workerModalOpen = false;
  }

  async createWorker(): Promise<void> {
    const thread = this.selectedThread();
    const task = this.workerTask.trim();
    if (!thread || this.creatingWorker) return;
    this.creatingWorker = true;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        label: this.workerLabel.trim() || `Worker ${this.childWorkers(thread).length + 1}`,
        autoRun: this.workerAutoRun && Boolean(task),
      };
      if (task) body["task"] = task;
      if (this.workerRepoPath.trim()) body["repoPath"] = this.workerRepoPath.trim();
      if (this.workerBranchName.trim()) body["branchName"] = this.workerBranchName.trim();
      const result = await firstValueFrom(this.api.createThreadWorker(thread.id, body));
      this.workerModalOpen = false;
      this.workerLabel = "Worker 1";
      this.workerTask = "";
      this.workerBranchName = "";
      this.workerRepoPath = "";
      await this.refresh(false);
      if (result.worker) await this.activateThread(result.worker);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.creatingWorker = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async saveThreadRepo(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.savingThreadMeta) return;
    this.savingThreadMeta = true;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.updateThreadRepo(thread.id, {
        repoPath: this.threadRepoDraft.trim(),
        branchName: this.threadBranchDraft.trim(),
      }));
      if (result.thread) this.replaceThread(result.thread);
      this.syncThreadMetaDraft(result.thread || thread, true);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingThreadMeta = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async detectSelectedThreadRepo(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.detectingThreadRepo) return;
    this.detectingThreadRepo = true;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.detectThreadRepo(thread.id));
      if (result.thread) this.replaceThread(result.thread);
      this.syncThreadMetaDraft(result.thread || thread, true);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.detectingThreadRepo = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async saveThreadBinding(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.savingThreadBinding) return;
    this.savingThreadBinding = true;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.updateThreadBinding(thread.id, {
        connector: "whatsapp",
        chatId: this.whatsappChatId.trim(),
        displayName: this.whatsappDisplayName.trim() || this.threadTitle(thread),
        enabled: this.whatsappBindingEnabled,
        allowOtherPeople: this.whatsappAllowOtherPeople,
        mirrorToWhatsApp: this.whatsappMirrorToWhatsApp,
        replyPrefix: this.whatsappReplyPrefix.trim() || "otcanclaw:",
        outboundAccountId: this.whatsappOutboundAccountId.trim(),
      }));
      if (result.thread) this.replaceThread(result.thread);
      this.syncThreadBindingDraft(result.thread || thread, true);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingThreadBinding = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async createSidebarWorker(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    const parent = this.workerParentThread(thread);
    const task = this.sidebarWorkerTask.trim();
    if (!parent || this.creatingSidebarWorker) return;
    this.creatingSidebarWorker = true;
    this.creatingWorkerParentId = parent.id;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        autoRun: Boolean(task),
      };
      if (task) body["task"] = task;
      const repoPath = this.threadMetaThreadId === parent.id ? this.threadRepoDraft.trim() : this.defaultRepoPath(parent);
      if (repoPath) body["repoPath"] = repoPath;
      const result = await firstValueFrom(this.api.createThreadWorker(parent.id, body));
      this.sidebarWorkerTask = "";
      if (thread) this.clearThreadTextField(thread, "sidebarWorkerTask");
      this.clearThreadTextField(parent, "sidebarWorkerTask");
      await this.refresh(false);
      if (result.worker) await this.activateThread(result.worker);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.creatingSidebarWorker = false;
      this.creatingWorkerParentId = "";
      this.busy = false;
      this.renderNow();
    }
  }

  async createLeftMenuWorker(parent: ThreadSummary, event?: MouseEvent): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    const root = this.workerParentThread(parent);
    if (!root || this.creatingSidebarWorker) return;
    this.creatingSidebarWorker = true;
    this.creatingWorkerParentId = root.id;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        label: `Worker ${this.childWorkers(root).length + 1}`,
        autoRun: false,
      };
      const repoPath = this.defaultRepoPath(root);
      if (repoPath) body["repoPath"] = repoPath;
      const result = await firstValueFrom(this.api.createThreadWorker(root.id, body));
      await this.refresh(false);
      if (result.worker) await this.activateThread(result.worker);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.creatingSidebarWorker = false;
      this.creatingWorkerParentId = "";
      this.busy = false;
      this.renderNow();
    }
  }

  handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void this.sendMessage();
  }

  rememberScrollPosition(): void {
    const pane = this.messagePane?.nativeElement;
    if (!pane) return;
    this.shouldStickToBottom = this.isMessagePaneNearBottom();
  }

  handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  handleDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = true;
  }

  handleDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = false;
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    this.draggingUpload = false;
    this.queueFiles(event.dataTransfer?.files || null);
  }

  focusRawTerminal(): void {
    this.rawTerminal.focus();
  }

  reconnectRaw(): void {
    const thread = this.selectedThread();
    if (!thread) return;
    this.rawTerminal.reconnect(thread.id);
  }

  queueFiles(files: FileList | null): void {
    this.pendingFiles = appendPendingFiles(this.pendingFiles, files);
  }

  removePendingFile(id: string): void {
    this.pendingFiles = removePendingFile(this.pendingFiles, id);
  }

  startSidebarResize(event: PointerEvent): void {
    if (globalThis.innerWidth <= 860) return;
    event.preventDefault();
    this.sidebarResizing = true;
    this.sidebarResizeStartX = event.clientX;
    this.sidebarResizeStartWidth = this.sidebarWidth;
    globalThis.document?.body?.classList.add("sidebar-resizing-body");
    globalThis.addEventListener?.("pointermove", this.sidebarResizeMove);
    globalThis.addEventListener?.("pointerup", this.sidebarResizeEnd);
  }

  resetSidebarWidth(): void {
    this.sidebarWidth = this.sidebarDefaultWidth;
    this.persistSidebarWidth();
    this.renderNow();
  }

  persistThreadTextField(field: PersistedThreadTextField, value: string): void {
    this[field] = value;
    const thread = this.selectedThread();
    if (!thread) return;
    this.writeThreadTextField(thread, field, value);
  }

  filteredThreads(): ThreadSummary[] {
    const needle = this.filterText.trim().toLowerCase();
    if (!needle) return this.threads;
    return this.threads.filter((thread) => this.threadMatchesFilter(thread));
  }

  threadTreeRoots(): ThreadSummary[] {
    const roots = this.threads
      .filter((thread) => !thread.parentThreadId || !this.threads.some((candidate) => candidate.id === thread.parentThreadId))
      .filter((thread) => this.threadVisibleInTree(thread));
    return roots.sort((a, b) => this.familyActivityMs(b) - this.familyActivityMs(a));
  }

  visibleChildWorkers(thread: ThreadSummary | null): ThreadSummary[] {
    const children = this.childWorkers(thread);
    const needle = this.filterText.trim();
    if (!needle || this.threadMatchesFilter(thread)) return children;
    return children.filter((worker) => this.threadMatchesFilter(worker));
  }

  selectedThread(): ThreadSummary | null {
    if (this.onboardingActive) return null;
    if (this.threadWizardOpen) return null;
    if (this.activePanel === "ops") return null;
    if (!this.selectedId) return this.threads[0] || null;
    return this.resolveThread(this.selectedId) || null;
  }

  selectedMessages(): ThreadMessage[] {
    const thread = this.selectedThread();
    return thread ? this.messageCache()[thread.id] || [] : [];
  }

  selectedMessagesLoading(): boolean {
    const thread = this.selectedThread();
    return thread ? this.threadLoading(thread) && this.selectedMessages().length === 0 : false;
  }

  isSelected(thread: ThreadSummary): boolean {
    return this.selectedThread()?.id === thread.id;
  }

  isThreadFamilyActive(thread: ThreadSummary): boolean {
    const selected = this.selectedThread();
    return selected?.id === thread.id || selected?.parentThreadId === thread.id;
  }

  threadTitle(thread: ThreadSummary): string {
    return String(thread.bindingName || thread.name || thread.title || thread.id);
  }

  threadKindLabel(thread: ThreadSummary): string {
    return thread.parentThreadId ? "Worker Thread" : "Conversation";
  }

  threadBranchLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    return String(
      thread.branchName ||
      this.objectValue(thread.runtime, "branchName") ||
      this.objectValue(metadata, "branchName") ||
      thread.baseBranch ||
      "",
    ).trim();
  }

  threadRepoLabel(thread: ThreadSummary | null): string {
    const repo = this.defaultRepoPath(thread);
    if (!repo) return "";
    return repo.split("/").filter(Boolean).at(-1) || repo;
  }

  threadWorkspaceLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const remote = this.threadRemoteLabel(thread);
    const repo = this.threadRepoLabel(thread);
    const gitDelta = this.threadGitDeltaLabel(thread);
    const parts: string[] = [];
    if (remote) parts.push(remote);
    if (!thread.parentThreadId && repo && !remote.toLowerCase().endsWith(`/${repo.toLowerCase()}`)) parts.push(repo);
    if (gitDelta) parts.push(gitDelta);
    return parts.join(" · ");
  }

  threadRemoteLabel(thread: ThreadSummary | null): string {
    return this.formatRemoteUrl(this.threadRemoteUrl(thread));
  }

  threadRemoteUrl(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    return String(
      thread["repoRemoteUrl"] ||
      thread["remoteUrl"] ||
      thread["gitRemoteUrl"] ||
      this.objectValue(thread.runtime, "repoRemoteUrl") ||
      this.objectValue(thread.runtime, "remoteUrl") ||
      this.objectValue(metadata, "repoRemoteUrl") ||
      this.objectValue(metadata, "remoteUrl") ||
      "",
    ).trim();
  }

  threadRemoteBranchLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    const remoteBranch = String(
      thread["remoteBranch"] ||
      thread["gitRemoteBranch"] ||
      thread["upstreamBranch"] ||
      this.objectValue(thread.runtime, "remoteBranch") ||
      this.objectValue(thread.runtime, "gitRemoteBranch") ||
      this.objectValue(metadata, "remoteBranch") ||
      this.objectValue(metadata, "gitRemoteBranch") ||
      "",
    ).trim();
    if (remoteBranch) return remoteBranch;
    const branch = this.threadBranchLabel(thread);
    return branch && this.threadRemoteUrl(thread) ? `origin/${branch}` : "";
  }

  threadGitDeltaLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const baseAhead = this.threadNumberValue(thread, "gitBaseAhead");
    const changedFiles = this.threadNumberValue(thread, "gitChangedFiles");
    const dirtyFiles = this.threadNumberValue(thread, "gitDirtyFiles");
    const baseParts: string[] = [];
    if (Number.isFinite(baseAhead) && baseAhead > 0) baseParts.push(`${baseAhead} commit${baseAhead === 1 ? "" : "s"}`);
    if (Number.isFinite(changedFiles) && changedFiles > 0) baseParts.push(`${changedFiles} file${changedFiles === 1 ? "" : "s"}`);
    if (Number.isFinite(dirtyFiles) && dirtyFiles > 0) baseParts.push(`${dirtyFiles} dirty`);
    if (
      Number.isFinite(baseAhead) &&
      Number.isFinite(changedFiles) &&
      Number.isFinite(dirtyFiles) &&
      baseAhead === 0 &&
      changedFiles === 0 &&
      dirtyFiles === 0
    ) {
      return "";
    }
    if (baseParts.length) {
      const comparison = String(thread.gitComparisonLabel || this.objectValue(thread.runtime, "gitComparisonLabel") || "").trim();
      return `diff${comparison ? ` vs ${comparison}` : ""}: ${baseParts.join(", ")}`;
    }
    const ahead = this.threadNumberValue(thread, "gitAhead");
    const behind = this.threadNumberValue(thread, "gitBehind");
    if (Number.isFinite(ahead) && Number.isFinite(behind) && (ahead > 0 || behind > 0)) return `ahead ${ahead} behind ${behind}`;
    return "";
  }

  threadMetaDirty(thread: ThreadSummary | null = this.selectedThread()): boolean {
    if (!thread || this.threadMetaThreadId !== thread.id) return false;
    return this.threadRepoDraft.trim() !== this.defaultRepoPath(thread) || this.threadBranchDraft.trim() !== this.threadBranchLabel(thread);
  }

  threadBindingDirty(thread: ThreadSummary | null = this.selectedThread()): boolean {
    if (!thread || this.whatsappBindingThreadId !== thread.id) return false;
    const binding = thread.binding || {};
    return this.whatsappChatId.trim() !== String(binding.chatId || "") ||
      this.whatsappDisplayName.trim() !== String(binding.displayName || this.threadTitle(thread)) ||
      this.whatsappReplyPrefix.trim() !== String(binding.replyPrefix || "otcanclaw:") ||
      this.whatsappOutboundAccountId.trim() !== String(binding.outboundAccountId || "") ||
      this.whatsappBindingEnabled !== (binding.enabled !== false) ||
      this.whatsappAllowOtherPeople !== (binding.allowOtherPeople !== false) ||
      this.whatsappMirrorToWhatsApp !== (binding.mirrorToWhatsApp !== false);
  }

  whatsappChatLabel(thread: ThreadSummary | null): string {
    const binding = thread?.binding;
    const chatId = String(binding?.chatId || "").trim();
    if (!chatId) return "No WhatsApp chat connected";
    return String(binding?.displayName || chatId).trim();
  }

  whatsappChatDetail(thread: ThreadSummary | null): string {
    const binding = thread?.binding;
    const chatId = String(binding?.chatId || "").trim();
    if (!chatId) return "Add a chat id to route WhatsApp messages into this thread.";
    const state = binding?.enabled === false ? "inbound off" : "inbound on";
    const mirror = binding?.mirrorToWhatsApp === false ? "WA mirror off" : "WA mirror on";
    return `${chatId} · ${state} · ${mirror}`;
  }

  showWhatsAppChatIcon(thread: ThreadSummary | null): boolean {
    const binding = thread?.binding;
    if (!binding) return false;
    const connector = String(binding.connector || "whatsapp").toLowerCase();
    const chatId = String(binding.chatId || "").toLowerCase();
    return connector === "whatsapp" && Boolean(chatId);
  }

  whatsappAvatarUrl(thread: ThreadSummary | null): string {
    const binding = thread?.binding;
    return this.firstUrl(
      binding?.avatarUrl,
      binding?.iconUrl,
      binding?.pictureUrl,
      binding?.photoUrl,
      binding?.profilePicUrl,
      thread?.["whatsappAvatarUrl"],
      thread?.["avatarUrl"],
      thread?.["iconUrl"],
    );
  }

  whatsappAvatarLines(thread: ThreadSummary | null): string[] {
    const title = this.whatsappChatLabel(thread) || (thread ? this.threadTitle(thread) : "WhatsApp");
    return this.chatIconLines(title);
  }

  isWhatsAppAvatarPrimaryLine(line: string): boolean {
    return /^W\d+$/i.test(String(line || "").trim());
  }

  whatsappChatIconTitle(thread: ThreadSummary | null): string {
    const label = this.whatsappChatLabel(thread);
    const binding = thread?.binding;
    const chatId = String(binding?.chatId || "").toLowerCase();
    const groupSuffix = binding?.allowOtherPeople !== false || chatId.includes("@g.us") || chatId.includes("g.us") ? " · group" : "";
    return `${label} · WhatsApp chat${groupSuffix}`;
  }

  childWorkers(thread: ThreadSummary | null): ThreadSummary[] {
    if (!thread) return [];
    return this.threads
      .filter((item) => item.parentThreadId === thread.id)
      .sort((a, b) => Number(a.workerIndex || 0) - Number(b.workerIndex || 0) || this.activityMs(b) - this.activityMs(a));
  }

  familyWorkers(thread: ThreadSummary | null): ThreadSummary[] {
    if (!thread) return [];
    return this.childWorkers(this.parentThread(thread) || thread);
  }

  parentThread(thread: ThreadSummary | null): ThreadSummary | null {
    if (!thread?.parentThreadId) return null;
    return this.threads.find((item) => item.id === thread.parentThreadId) || null;
  }

  workerParentThread(thread: ThreadSummary | null): ThreadSummary | null {
    if (!thread) return null;
    return this.parentThread(thread) || thread;
  }

  defaultRepoPath(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const repoPath = String(thread.repoPath || this.objectValue(thread.runtime, "repoPath") || "").trim();
    const worktreePath = String(
      thread.worktreePath ||
      this.objectValue(thread.runtime, "worktreePath") ||
      this.objectValue(thread.runtime, "workspace") ||
      thread["cwd"] ||
      thread["workspace"] ||
      "",
    ).trim();
    return thread.parentThreadId ? worktreePath || repoPath : repoPath || worktreePath;
  }

  statusLabel(thread: ThreadSummary): string {
    if (this.isThreadProcessing(thread)) return this.threadProcessingLabel(thread);
    const state = String(thread.publicStatus || thread.status || thread.state || "unknown");
    if (state === "ready") return "Ready";
    if (state === "sleeping") return "Sleeping";
    if (state === "working") return thread.backgroundWork ? "Background" : "Working";
    return state.replace(/_/g, " ");
  }

  statusClass(thread: ThreadSummary): string {
    if (this.isThreadProcessing(thread)) return "hot";
    const state = String(thread.publicStatusCode || thread.status || thread.state || "").toLowerCase();
    if (state.includes("broken") || state.includes("failed")) return "bad";
    if (state.includes("stuck") || state.includes("working") || state.includes("running")) return "hot";
    if (state.includes("ready")) return "ready";
    if (state.includes("sleep")) return "sleep";
    return "idle";
  }

  isThreadProcessing(thread: ThreadSummary | null): boolean {
    if (!thread) return false;
    const activeCount = Number(thread.pendingCount || 0) + Number(thread.runningCount || 0);
    const state = [
      this.threadState(thread),
      thread.publicStatus,
      thread.publicStatusCode,
      this.objectValue(thread.runtime, "state"),
      this.objectValue(thread.runtime, "status"),
      this.objectValue(thread.runtime, "executionState"),
    ].join(" ").toLowerCase();
    return Boolean(
      this.threadLoading(thread) ||
      thread.working ||
      thread.typingActive ||
      thread.backgroundWork ||
      activeCount > 0 ||
      /(?:working|running|processing|waking|pending)/.test(state),
    );
  }

  threadProcessingLabel(thread: ThreadSummary | null): string {
    if (!thread) return "Working";
    if (this.threadLoading(thread)) return "Loading";
    if (thread.backgroundWork) return "Background";
    const state = this.threadState(thread);
    if (state.includes("waking")) return "Starting";
    if (Number(thread.pendingCount || 0) > 0 && !thread.working && !thread.typingActive) return "Queued";
    return "Working";
  }

  threadProcessingShortLabel(thread: ThreadSummary | null): string {
    const label = this.threadProcessingLabel(thread);
    if (label === "Background") return "BG";
    if (label === "Starting") return "Start";
    if (label === "Queued") return "Queue";
    if (label === "Loading") return "Load";
    return "Working";
  }

  canWakeThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    return state.includes("sleep") || state.includes("hibernat");
  }

  canSleepThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    const leaseId = String(thread.activeRuntimeLeaseId || "");
    const reason = String(this.leaseValue("reason") || this.objectValue(thread["runtime"], "reason"));
    if (!thread.activeRuntimeLeaseId && !thread.sessionName) return false;
    if (leaseId.startsWith("adopt-") || reason.includes("adopt_existing")) return false;
    return ["ready", "working", "waking"].some((item) => state.includes(item));
  }

  canRecoverThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    return state.includes("broken") || state.includes("failed") || Boolean(thread["lastError"]);
  }

  activityTime(thread: ThreadSummary): Date {
    return new Date(this.activityMs(thread));
  }

  isThreadUnread(thread: ThreadSummary): boolean {
    const activity = this.activityMs(thread);
    return activity > 0 && activity > this.threadReadMs(thread);
  }

  isThreadFamilyUnread(thread: ThreadSummary): boolean {
    return this.isThreadUnread(thread) || this.childWorkers(thread).some((worker) => this.isThreadUnread(worker));
  }

  threadTimerCount(thread: ThreadSummary): number {
    return this.familyTimers(thread).length;
  }

  ownThreadTimerCount(thread: ThreadSummary): number {
    return this.threadTimersFor(thread).length;
  }

  threadTimerTooltip(thread: ThreadSummary): string {
    const timers = this.familyTimers(thread);
    if (!timers.length) return "No timers";
    const [next] = timers;
    const label = String(next.label || "Timer");
    const count = timers.length === 1 ? "1 timer" : `${timers.length} timers`;
    return `${count}. Next: ${label} at ${this.timerTimeLabel(next)}`;
  }

  threadUrl(thread: ThreadSummary): string {
    return this.pathForPanel(this.threadSlug(thread), this.activePanel === "raw" ? "raw" : "chat");
  }

  rawUrl(thread: ThreadSummary): string {
    return `/ng/thread/${encodeURIComponent(this.threadSlug(thread))}/raw`;
  }

  messageKey(message: ThreadMessage): string {
    return String(message.id || message.eventId || message.cursor || `${message.role}:${message.createdAt}:${message.text}`);
  }

  messageText(message: ThreadMessage): string {
    return String(message.text || message.promptFile || "").trim();
  }

  messageTextHtml(message: ThreadMessage): string {
    return renderMessageTextHtml(this.messageText(message));
  }

  messagePhase(message: ThreadMessage | null): string {
    return String(message?.phase || "").trim().toLowerCase();
  }

  isFinalAssistantMessage(message: ThreadMessage | null): boolean {
    if (String(message?.role || "").toLowerCase() !== "assistant") return false;
    const phase = this.messagePhase(message);
    return !phase || phase === "final_answer" || phase === "final";
  }

  isInfoAssistantMessage(message: ThreadMessage | null): boolean {
    return String(message?.role || "").toLowerCase() === "assistant" && !this.isFinalAssistantMessage(message);
  }

  messageRoleLabel(message: ThreadMessage): string {
    const role = String(message.role || "assistant").toLowerCase();
    if (role === "user") return "You";
    if (this.isFinalAssistantMessage(message)) return "Assistant";
    if (this.messagePhase(message) === "plan") return "Plan";
    return "Update";
  }

  messagePhaseLabel(message: ThreadMessage): string {
    if (String(message.role || "").toLowerCase() !== "assistant") return "";
    const phase = this.messagePhase(message);
    if (!phase || phase === "final_answer" || phase === "final") return "Final answer";
    if (phase === "commentary") return "Info";
    if (phase === "plan") return "Plan";
    return phase.replace(/_/g, " ");
  }

  messageTime(message: ThreadMessage): Date {
    return new Date(String(message.timestamp || message.createdAt || new Date().toISOString()));
  }

  attachmentLabel(attachment: Record<string, unknown>): string {
    return String(attachment["name"] || attachment["filename"] || attachment["path"] || attachment["saved_path"] || "attachment");
  }

  composerRows(): number {
    return Math.max(2, Math.min(10, this.draft.split("\n").length));
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

  codexModeValue(thread: ThreadSummary | null): string {
    const mode = String(
      thread?.codexMode ||
      thread?.desiredCodexMode ||
      thread?.codexModeLabel ||
      thread?.codexModeSource ||
      "",
    ).toLowerCase();
    if (mode.includes("plan")) return "plan";
    if (mode.includes("code")) return "code";
    return "";
  }

  codexModelName(thread: ThreadSummary | null): string {
    return String(
      thread?.codexModel ||
      this.objectValue(thread?.runtime, "codexModel") ||
      this.objectValue(thread?.["executor"], "codexModel") ||
      "Model not synced",
    );
  }

  codexReasoningEffortLabel(thread: ThreadSummary | null): string {
    return String(thread?.codexReasoningEffort || "").trim();
  }

  codexModelProviderLabel(thread: ThreadSummary | null): string {
    return String(thread?.codexModelProvider || "codex").trim() || "codex";
  }

  codexPlanTypeLabel(thread: ThreadSummary | null): string {
    return String(thread?.codexRateLimits?.plan_type || "").trim() || "unknown";
  }

  codexRateLimitNotice(thread: ThreadSummary | null): string {
    const reached = String(thread?.codexRateLimits?.rate_limit_reached_type || "").trim();
    return reached ? `Rate limit reached: ${reached}` : "";
  }

  codexRateRemaining(thread: ThreadSummary | null, key: CodexRateLimitKey): number | null {
    const used = Number(thread?.codexRateLimits?.[key]?.used_percent);
    if (!Number.isFinite(used)) return null;
    return Math.max(0, Math.min(100, 100 - used));
  }

  codexRateRemainingFill(thread: ThreadSummary | null, key: CodexRateLimitKey): number {
    return this.codexRateRemaining(thread, key) ?? 0;
  }

  codexRateRemainingLabel(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const remaining = this.codexRateRemaining(thread, key);
    return remaining === null ? "--" : `${Math.round(remaining)}%`;
  }

  codexRateUsedLabel(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const used = Number(thread?.codexRateLimits?.[key]?.used_percent);
    return Number.isFinite(used) ? `${Math.round(Math.max(0, Math.min(100, used)))}%` : "--";
  }

  codexRateWindowLabel(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const minutes = Number(thread?.codexRateLimits?.[key]?.window_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return "--";
    return this.formatDurationMinutes(minutes);
  }

  codexRateResetRelativeLabel(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const resetAt = this.codexRateResetDate(thread, key);
    if (!resetAt) return "--";
    const diffMs = resetAt.getTime() - Date.now();
    if (diffMs <= 0) return "resetting now";
    return `in ${this.formatDurationMinutes(Math.ceil(diffMs / 60000))}`;
  }

  codexRateResetTimeLabel(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const resetAt = this.codexRateResetDate(thread, key);
    if (!resetAt) return "--";
    return resetAt.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  codexRateTone(thread: ThreadSummary | null, key: CodexRateLimitKey): string {
    const remaining = this.codexRateRemaining(thread, key);
    if (remaining === null) return "unknown";
    if (remaining <= 10) return "danger";
    if (remaining <= 25) return "warn";
    return "ok";
  }

  codexContextPercent(thread: ThreadSummary | null): number | null {
    const total = Number(thread?.codexContextWindow || 0);
    const used = Number(thread?.codexTokenUsage?.["total_tokens"] || thread?.codexTokenUsage?.["input_tokens"] || 0);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null;
    return Math.max(0, Math.min(100, (used / total) * 100));
  }

  codexContextFill(thread: ThreadSummary | null): number {
    return this.codexContextPercent(thread) ?? 0;
  }

  codexContextLabel(thread: ThreadSummary | null): string {
    const percent = this.codexContextPercent(thread);
    return percent === null ? "--" : `${Math.round(percent)}%`;
  }

  codexContextUsedLabel(thread: ThreadSummary | null): string {
    const used = this.codexContextUsedTokens(thread);
    return used === null ? "--" : this.formatTokenCount(used);
  }

  codexContextRemainingLabel(thread: ThreadSummary | null): string {
    const total = Number(thread?.codexContextWindow || 0);
    const used = this.codexContextUsedTokens(thread);
    if (!Number.isFinite(total) || total <= 0 || used === null) return "--";
    return this.formatTokenCount(Math.max(0, total - used));
  }

  codexContextWindowLabel(thread: ThreadSummary | null): string {
    const total = Number(thread?.codexContextWindow || 0);
    return Number.isFinite(total) && total > 0 ? this.formatTokenCount(total) : "--";
  }

  codexContextTone(thread: ThreadSummary | null): string {
    const percent = this.codexContextPercent(thread);
    if (percent === null) return "unknown";
    if (percent >= 90) return "danger";
    if (percent >= 75) return "warn";
    return "ok";
  }

  codexCapacityTooltip(thread: ThreadSummary | null): string {
    return [
      `Model: ${this.codexModelName(thread)}`,
      `Reasoning: ${this.codexReasoningEffortLabel(thread) || "unknown"}`,
      `5h remaining: ${this.codexRateRemainingLabel(thread, "primary")}`,
      `Weekly remaining: ${this.codexRateRemainingLabel(thread, "secondary")}`,
      `Context: ${this.codexContextLabel(thread)}`,
    ].join("\n");
  }

  private codexContextUsedTokens(thread: ThreadSummary | null): number | null {
    const used = Number(thread?.codexTokenUsage?.["total_tokens"] || thread?.codexTokenUsage?.["input_tokens"] || 0);
    return Number.isFinite(used) && used >= 0 ? used : null;
  }

  private codexRateResetDate(thread: ThreadSummary | null, key: CodexRateLimitKey): Date | null {
    const raw = Number(thread?.codexRateLimits?.[key]?.resets_at);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const millis = raw > 1_000_000_000_000 ? raw : raw * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private formatDurationMinutes(totalMinutes: number): string {
    const minutes = Math.max(1, Math.round(totalMinutes));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainderMinutes = minutes % 60;
    if (hours < 24) return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainderHours = hours % 24;
    return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
  }

  private formatTokenCount(value: number): string {
    const tokens = Math.max(0, Math.round(value));
    if (tokens < 1000) return `${tokens}`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`;
    return `${Math.round(tokens / 100_000) / 10}m`;
  }

  runtimeJson(): string {
    return JSON.stringify(this.runtimeDetails || {}, null, 2);
  }

  runtimeValue(key: string): string {
    const runtime = this.runtimeDetails?.["runtime"];
    if (runtime && typeof runtime === "object" && key in runtime) return String((runtime as Record<string, unknown>)[key] || "");
    if (this.attachDetails?.runtime && key in this.attachDetails.runtime) return String(this.attachDetails.runtime[key] || "");
    return "";
  }

  leaseValue(key: string): string {
    const runtime = this.runtimeDetails?.["runtime"];
    const lease = runtime && typeof runtime === "object" ? (runtime as Record<string, unknown>)["lease"] : null;
    if (lease && typeof lease === "object" && key in lease) return String((lease as Record<string, unknown>)[key] || "");
    const attachLease = this.attachDetails?.runtime?.["lease"];
    if (attachLease && typeof attachLease === "object" && key in attachLease) return String((attachLease as Record<string, unknown>)[key] || "");
    return "";
  }

  objectValue(value: unknown, key: string): string {
    if (!value || typeof value !== "object") return "";
    return String((value as Record<string, unknown>)[key] || "");
  }

  private pathValue(value: unknown, path: string): unknown {
    let current = value;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private async loadSelectedThread(forceBottom: boolean): Promise<void> {
    if (this.activePanel === "ops") return;
    const thread = this.selectedThread();
    if (!thread) return;
    const threadId = thread.id;
    const loadToken = this.beginThreadLoad(threadId);
    const wasNearBottom = this.isMessagePaneNearBottom();
    try {
      const payload = await firstValueFrom(this.api.threadMessages(threadId, 150));
      if (this.threadLoadTokens.get(threadId) !== loadToken) return;
      const nextMessages = payload.messages || [];
      const previousMessages = this.messageCache()[threadId] || [];
      const previousSignature = previousMessages.map((message) => this.messageKey(message)).join("|");
      const signature = nextMessages.map((message) => this.messageKey(message)).join("|");
      const changed = signature !== previousSignature;
      this.messageCache.update((cache) => ({ ...cache, [threadId]: nextMessages }));
      const currentThread = this.selectedThread();
      if (currentThread?.id === threadId) this.markThreadRead(currentThread);
      if (forceBottom || (!previousSignature && nextMessages.length > 0) || (changed && wasNearBottom)) {
        this.queueMessagePaneScrollToBottom();
      }
      if (previousSignature && changed && nextMessages.length > 0) this.markThreadActive(threadId, 45_000);
      if (this.activePanel === "history") await this.loadHistory();
      if (this.activePanel === "timers") await this.loadTimers();
      if (this.activePanel === "runtime") await this.loadRuntime();
      if (this.activePanel === "raw") await this.loadRaw();
    } finally {
      this.finishThreadLoad(threadId, loadToken);
    }
    this.renderNow();
  }

  private beginThreadLoad(threadId: string): number {
    const token = ++this.threadLoadSequence;
    this.threadLoadTokens.set(threadId, token);
    this.loadingThreadIds.update((loading) => ({ ...loading, [threadId]: true }));
    return token;
  }

  private finishThreadLoad(threadId: string, token: number): void {
    if (this.threadLoadTokens.get(threadId) !== token) return;
    this.threadLoadTokens.delete(threadId);
    this.loadingThreadIds.update((loading) => {
      const next = { ...loading };
      delete next[threadId];
      return next;
    });
  }

  threadLoading(thread: ThreadSummary | null): boolean {
    return Boolean(thread?.id && this.loadingThreadIds()[thread.id]);
  }

  private trackThreadActivity(threads: ThreadSummary[]): void {
    const now = Date.now();
    for (const thread of threads) {
      const activity = this.activityMs(thread);
      const previous = this.lastActivityByThread.get(thread.id);
      if (previous && activity > previous && activity > now - 120_000) {
        this.markThreadActive(thread.id, 45_000);
      }
      this.lastActivityByThread.set(thread.id, activity);
    }
    this.pruneActiveThreads(now);
  }

  private markThreadActive(threadId: string, durationMs: number): void {
    const until = Date.now() + durationMs;
    this.activeThreadIds.update((active) => ({ ...active, [threadId]: Math.max(Number(active[threadId] || 0), until) }));
  }

  private pruneActiveThreads(now = Date.now()): void {
    const active = this.activeThreadIds();
    const next: Record<string, number> = {};
    for (const [threadId, until] of Object.entries(active)) {
      if (Number(until || 0) > now) next[threadId] = until;
    }
    if (Object.keys(next).length !== Object.keys(active).length) this.activeThreadIds.set(next);
  }

  private threadRecentlyActive(thread: ThreadSummary | null): boolean {
    if (!thread?.id) return false;
    const until = Number(this.activeThreadIds()[thread.id] || 0);
    return until > Date.now();
  }

  private isMessagePaneNearBottom(): boolean {
    const pane = this.messagePane?.nativeElement;
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  }

  private queueMessagePaneScrollToBottom(): void {
    if (this.activePanel !== "chat") return;
    this.shouldStickToBottom = true;
    this.scrollAfterRender = true;
    if (this.scrollFrame && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(this.scrollFrame);
    }
    const run = () => {
      this.scrollFrame = 0;
      this.scrollMessagePaneToBottom();
      globalThis.setTimeout?.(() => this.scrollMessagePaneToBottom(), 0);
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      this.scrollFrame = globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(run));
    } else {
      globalThis.setTimeout?.(run, 0);
    }
  }

  private scrollMessagePaneToBottom(): void {
    if (this.activePanel !== "chat") return;
    const pane = this.messagePane?.nativeElement;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    this.scrollAfterRender = false;
    this.shouldStickToBottom = true;
  }

  private loadSidebarWidth(): number {
    try {
      const stored = Number(globalThis.localStorage?.getItem(this.sidebarWidthKey));
      if (Number.isFinite(stored)) return this.clampSidebarWidth(stored);
    } catch {
      return this.sidebarDefaultWidth;
    }
    return this.sidebarDefaultWidth;
  }

  private persistSidebarWidth(): void {
    try {
      globalThis.localStorage?.setItem(this.sidebarWidthKey, String(Math.round(this.sidebarWidth)));
    } catch {
      // Width persistence is optional; dragging still works for the current session.
    }
  }

  private clampSidebarWidth(value: number): number {
    const viewportMax = Number(globalThis.innerWidth || 0) > 0
      ? Math.max(this.sidebarMinWidth, Math.min(this.sidebarMaxWidth, Number(globalThis.innerWidth) - 520))
      : this.sidebarMaxWidth;
    return Math.max(this.sidebarMinWidth, Math.min(viewportMax, Math.round(value)));
  }

  private openRawStream(thread: ThreadSummary): void {
    this.rawTerminal.open(thread.id);
  }

  private closeRawStream(clearScreen = true): void {
    this.rawTerminal.close(clearScreen);
  }

  private threadState(thread: ThreadSummary): string {
    return String(thread.publicStatusCode || thread.status || thread.state || "").toLowerCase();
  }

  private renderNow(): void {
    this.cdr.detectChanges();
  }

  private replaceThread(updated: ThreadSummary): void {
    this.threads = this.threads
      .map((thread) => thread.id === updated.id ? { ...thread, ...updated } : thread)
      .sort((a, b) => this.activityMs(b) - this.activityMs(a));
  }

  private syncThreadMetaDraft(thread: ThreadSummary | null, force = false): void {
    if (!thread) return;
    if (!force && this.threadMetaThreadId === thread.id && this.threadMetaDirty(thread)) return;
    this.threadMetaThreadId = thread.id;
    this.threadRepoDraft = this.defaultRepoPath(thread);
    this.threadBranchDraft = this.threadBranchLabel(thread);
  }

  private syncThreadBindingDraft(thread: ThreadSummary | null, force = false): void {
    if (!thread) return;
    if (!force && this.whatsappBindingThreadId === thread.id && this.threadBindingDirty(thread)) return;
    const binding = thread.binding || {};
    this.whatsappBindingThreadId = thread.id;
    this.whatsappChatId = String(binding.chatId || "");
    this.whatsappDisplayName = String(binding.displayName || this.threadTitle(thread));
    this.whatsappReplyPrefix = String(binding.replyPrefix || "otcanclaw:");
    this.whatsappOutboundAccountId = String(binding.outboundAccountId || "");
    this.whatsappBindingEnabled = binding.enabled !== false;
    this.whatsappAllowOtherPeople = binding.allowOtherPeople !== false;
    this.whatsappMirrorToWhatsApp = binding.mirrorToWhatsApp !== false;
  }

  private syncThreadTextState(thread: ThreadSummary | null, force = false): void {
    if (!thread) return;
    if (!force && this.textStateThreadId === thread.id) return;
    this.textStateThreadId = thread.id;
    for (const field of Object.keys(this.threadTextDefaults) as PersistedThreadTextField[]) {
      this[field] = this.readThreadTextField(thread, field) ?? this.threadTextDefaults[field];
    }
  }

  private readThreadTextField(thread: ThreadSummary, field: PersistedThreadTextField): string | null {
    try {
      return globalThis.sessionStorage?.getItem(this.threadTextStorageKey(thread, field)) ?? null;
    } catch {
      return null;
    }
  }

  private writeThreadTextField(thread: ThreadSummary, field: PersistedThreadTextField, value: string): void {
    try {
      globalThis.sessionStorage?.setItem(this.threadTextStorageKey(thread, field), value);
    } catch {
      // Session storage can be unavailable in strict browser modes; drafts then remain in memory only.
    }
  }

  private clearThreadTextField(thread: ThreadSummary, field: PersistedThreadTextField): void {
    try {
      globalThis.sessionStorage?.removeItem(this.threadTextStorageKey(thread, field));
    } catch {
      // Ignore storage failures; clearing the in-memory field is already handled by the caller.
    }
  }

  private threadTextStorageKey(thread: ThreadSummary, field: PersistedThreadTextField): string {
    return `orkestr:thread:${thread.id}:text:${field}`;
  }

  private resolveThread(value: string): ThreadSummary | undefined {
    const id = decodeURIComponent(String(value || "").trim());
    return this.threads.find((thread) =>
      [thread.id, thread.name, thread.bindingName, thread.title, thread.codexThreadId, thread.threadId]
        .filter(Boolean)
        .some((candidate) => String(candidate) === id),
    );
  }

  private threadSlug(thread: ThreadSummary): string {
    return String(thread.bindingName || thread.name || thread.id);
  }

  private threadReloadSignature(thread: ThreadSummary | null): string {
    if (!thread) return "";
    return [
      thread.id,
      thread.lastActivityAt || "",
      thread.threadUpdatedAt || "",
      thread.updatedAt || "",
      thread.state || "",
      thread.status || "",
      thread.publicStatusCode || "",
      thread.pendingCount ?? "",
      thread.runningCount ?? "",
      thread.awaitingAckCount ?? "",
      thread.nextDeliveryAttemptAt || "",
      String(thread.awaitingInput || ""),
      String(thread.awaitingInputEventId || ""),
      JSON.stringify(thread.codexTokenUsage || null),
      JSON.stringify(thread.codexRateLimits || null),
    ].join("|");
  }

  private idFromPath(): string {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const threadIndex = parts.indexOf("thread");
    if (threadIndex >= 0 && parts[threadIndex + 1]) return decodeURIComponent(parts[threadIndex + 1]);
    return "";
  }

  private onboardingFromPath(): boolean {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return parts[0] === "setup" || (parts[0] === "ng" && parts[1] === "onboarding");
  }

  private panelFromPath(): Panel {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    if (parts[0] === "ops" || (parts[0] === "ng" && parts[1] === "ops")) return "ops";
    const threadIndex = parts.indexOf("thread");
    const panel = String(parts[threadIndex + 2] || "");
    return ["history", "timers", "attach", "settings", "workers", "runtime", "raw", "ops"].includes(panel) ? panel as Panel : "chat";
  }

  private toolsViewFromPath(): ToolsView {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const candidate = parts[0] === "ops"
      ? String(parts[1] || "system")
      : parts[0] === "ng" && parts[1] === "ops" ? String(parts[2] || "system") : "system";
    return ["system", "timers", "desktops", "models", "settings", "connectors"].includes(candidate) ? candidate as ToolsView : "system";
  }

  private normalizeLegacyRoutePath(): void {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    if (parts[0] === "ng" && parts[1] === "onboarding") {
      globalThis.history?.replaceState({}, "", "/setup");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "ops") {
      const suffix = parts[2] ? `/${parts[2]}` : "";
      globalThis.history?.replaceState({}, "", `/ops${suffix}`);
      return;
    }
    if (parts[0] === "ng" && parts[1] === "thread" && parts[2]) {
      const suffix = parts[3] ? `/${parts[3]}` : "";
      globalThis.history?.replaceState({}, "", `/thread/${parts[2]}${suffix}`);
      return;
    }
    const threadIndex = parts.indexOf("thread");
    if (threadIndex >= 0 && parts[threadIndex + 2] === "ops") {
      globalThis.history?.replaceState({}, "", this.opsPath(this.toolsView));
    }
  }

  private pushPath(id: string, panel: Panel = "chat"): void {
    const next = this.pathForPanel(id, panel);
    if (globalThis.location?.pathname === next) return;
    globalThis.history?.pushState({}, "", next);
  }

  private replacePath(id: string, panel: Panel = "chat"): void {
    globalThis.history?.replaceState({}, "", this.pathForPanel(id, panel));
  }

  private pushOnboardingPath(): void {
    if (globalThis.location?.pathname === "/setup") return;
    globalThis.history?.pushState({}, "", "/setup");
  }

  private replaceOnboardingPath(): void {
    if (globalThis.location?.pathname === "/setup") return;
    globalThis.history?.replaceState({}, "", "/setup");
  }

  private pathForPanel(id: string, panel: Panel): string {
    if (panel === "ops") return this.opsPath(this.toolsView);
    const suffix = panel === "chat" ? "" : `/${panel}`;
    return `/thread/${encodeURIComponent(id)}${suffix}`;
  }

  private pushOpsPath(view: ToolsView): void {
    const next = this.opsPath(view);
    if (globalThis.location?.pathname === next) return;
    globalThis.history?.pushState({}, "", next);
  }

  private opsPath(view: ToolsView): string {
    return view === "system" ? "/ops" : `/ops/${view}`;
  }

  private shouldAutoOpenOnboarding(): boolean {
    if (this.onboardingActive || !this.setupStatus || this.setupStatus.setupState === "ready") return false;
    if (this.readOnboardingFlag("skipped") || this.readOnboardingFlag("completed")) return false;
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return parts.length === 0 || (parts.length === 1 && parts[0] === "ng");
  }

  private readOnboardingFlag(name: "skipped" | "completed"): boolean {
    try {
      return globalThis.localStorage?.getItem(`orkestr:onboarding:${name}`) === "1";
    } catch {
      return false;
    }
  }

  private writeOnboardingFlag(name: "skipped" | "completed"): void {
    try {
      globalThis.localStorage?.setItem(`orkestr:onboarding:${name}`, "1");
    } catch {
      // Local storage can be unavailable; the URL still records the current view.
    }
  }

  private clearOnboardingFlag(name: "skipped" | "completed"): void {
    try {
      globalThis.localStorage?.removeItem(`orkestr:onboarding:${name}`);
    } catch {
      // Ignore storage failures.
    }
  }

  private activityMs(thread: ThreadSummary): number {
    const value = thread.lastActivityAt || thread.threadUpdatedAt || thread.updatedAt || thread.createdAt || "";
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : 0;
  }

  private familyActivityMs(thread: ThreadSummary): number {
    return Math.max(this.activityMs(thread), ...this.childWorkers(thread).map((worker) => this.activityMs(worker)));
  }

  private threadTimersFor(thread: ThreadSummary | null): TimerRecord[] {
    if (!thread) return [];
    const candidates = [thread.id, thread.name, thread.bindingName, thread.title]
      .filter(Boolean)
      .map((value) => String(value));
    return this.allTimers
      .filter((timer) => timer.enabled !== false)
      .filter((timer) => {
        const targetType = String(timer.targetType || (timer.threadId ? "thread" : "")).toLowerCase();
        if (targetType && targetType !== "thread") return false;
        const target = String(timer.target || timer.threadId || "").trim();
        return Boolean(target && candidates.includes(target));
      })
      .sort((a, b) => this.timerMs(a) - this.timerMs(b));
  }

  private familyTimers(thread: ThreadSummary): TimerRecord[] {
    const timers = [thread, ...this.childWorkers(thread)].flatMap((item) => this.threadTimersFor(item));
    return [...new Map(timers.map((timer) => [timer.id, timer])).values()].sort((a, b) => this.timerMs(a) - this.timerMs(b));
  }

  private upsertTimer(timers: TimerRecord[], timer: TimerRecord): TimerRecord[] {
    return [...timers.filter((item) => item.id !== timer.id), timer].sort((a, b) => this.timerMs(a) - this.timerMs(b));
  }

  private timerMs(timer: TimerRecord): number {
    const ms = Date.parse(String(timer.nextRunAt || ""));
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }

  private timerTimeLabel(timer: TimerRecord): string {
    const ms = this.timerMs(timer);
    if (!Number.isFinite(ms) || ms === Number.MAX_SAFE_INTEGER) return "not scheduled";
    return new Date(ms).toLocaleString();
  }

  private threadReadMs(thread: ThreadSummary): number {
    const storage = this.readStateStorage();
    if (!storage) return this.activityMs(thread);
    const parsed = Number(storage.getItem(this.threadReadKey(thread.id)) || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private markThreadRead(thread: ThreadSummary | null = this.selectedThread()): void {
    if (!thread) return;
    const storage = this.readStateStorage();
    if (!storage) return;
    storage.setItem(this.threadReadKey(thread.id), String(this.activityMs(thread)));
  }

  private seedReadStateIfNeeded(threads: ThreadSummary[]): void {
    const storage = this.readStateStorage();
    if (!storage || storage.getItem(this.readStateVersionKey)) return;
    for (const thread of threads) {
      storage.setItem(this.threadReadKey(thread.id), String(this.activityMs(thread)));
    }
    storage.setItem(this.readStateVersionKey, new Date().toISOString());
  }

  private readStateStorage(): Storage | null {
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  }

  private threadReadKey(threadId: string): string {
    return `orkestr.threadRead.${threadId}`;
  }

  private threadVisibleInTree(thread: ThreadSummary): boolean {
    if (!this.filterText.trim()) return true;
    return this.threadMatchesFilter(thread) || this.childWorkers(thread).some((worker) => this.threadMatchesFilter(worker));
  }

  private threadMatchesFilter(thread: ThreadSummary | null): boolean {
    if (!thread) return false;
    const needle = this.filterText.trim().toLowerCase();
    if (!needle) return true;
    return [
      thread.id,
      thread.name,
      thread.bindingName,
      thread.title,
      thread.codexThreadId,
      thread.parentThreadId,
      thread.repoPath,
      thread.branchName,
      thread.worktreePath,
      thread["repoRemoteUrl"],
      thread["remoteBranch"],
      this.threadRemoteLabel(thread),
      this.threadRemoteBranchLabel(thread),
      this.threadWorkspaceLabel(thread),
      this.threadGitDeltaLabel(thread),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  }

  private formatRemoteUrl(value: string): string {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withoutGitSuffix = raw.replace(/\.git$/i, "");
    const sshMatch = withoutGitSuffix.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
    const protocolMatch = withoutGitSuffix.match(/^[a-z]+:\/\/([^/]+)\/(.+)$/i);
    if (protocolMatch) return `${protocolMatch[1]}/${protocolMatch[2]}`;
    return withoutGitSuffix;
  }

  private firstUrl(...values: unknown[]): string {
    for (const value of values) {
      const text = String(value || "").trim();
      if (/^(https?:|data:image\/|\/)/i.test(text)) return text;
    }
    return "";
  }

  private splitChatIconWords(title: string): string[] {
    const cleaned = String(title || "")
      .replace(/^otcanclaw[-_\s]*/i, "")
      .replace(/personalized/gi, "personal")
      .replace(/metabolimics/gi, "metabolomics")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim();
    return cleaned ? cleaned.split(/\s+/).filter(Boolean) : ["main"];
  }

  private chatIconLines(title: string): string[] {
    const words = this.splitChatIconWords(title);
    const workerIndex = words.findIndex((word) => /^worker$/i.test(word));
    if (workerIndex >= 0 && words[workerIndex + 1]) {
      const topic = words.slice(0, workerIndex).join(" ") || "chat";
      return ["ORKESTR", `W${words[workerIndex + 1]}`, topic.toUpperCase()].map((line) => line.slice(0, 11));
    }
    if (words.length === 1 && /^main$/i.test(words[0])) {
      return ["ORKESTR", "MAIN"];
    }
    if (words.length === 1) {
      return ["ORKESTR", words[0].toUpperCase().slice(0, 12)];
    }
    return ["ORKESTR", words[0].toUpperCase().slice(0, 11), words.slice(1).join(" ").toUpperCase().slice(0, 11)];
  }

  private threadNumberValue(thread: ThreadSummary | null, key: string): number {
    if (!thread) return Number.NaN;
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    const raw = thread[key] ?? this.pathValue(thread.runtime, key) ?? this.pathValue(metadata, key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  private booleanThreadValue(thread: ThreadSummary | null, key: string): boolean {
    if (!thread) return false;
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    const raw = thread[key] ?? this.pathValue(thread.runtime, key) ?? this.pathValue(metadata, key);
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  }

  private updateDocumentTitle(): void {
    if (this.onboardingActive) {
      globalThis.document.title = "Setup · Orkestr";
      return;
    }
    if (this.activePanel === "ops") {
      globalThis.document.title = "Ops · Orkestr";
      return;
    }
    const thread = this.selectedThread();
    globalThis.document.title = thread ? `${this.threadTitle(thread)} · Orkestr` : "Orkestr";
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }
}
