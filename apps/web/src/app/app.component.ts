import { DatePipe } from "@angular/common";
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { FirstThreadWizardComponent } from "./first-thread-wizard.component";
import { FilesPageComponent } from "./files-page.component";
import { OnboardingPageComponent } from "./onboarding-page.component";
import { PairingRequiredPageComponent } from "./pairing-required-page.component";
import { OpsPageComponent, ToolsView } from "./ops-page.component";
import { RawTerminalController } from "./raw-terminal.controller";
import { ConnectorStore } from "./stores/connector.store";
import { RuntimeStore } from "./stores/runtime.store";
import { ThreadStore } from "./stores/thread.store";
import { ThreadComposerComponent } from "./thread-composer.component";
import { ThreadMessageListComponent } from "./thread-message-list.component";
import { UserConnectorsPageComponent } from "./user-connectors-page.component";
import { UserDeskPageComponent } from "./user-desk-page.component";
import { UserTimersPageComponent } from "./user-timers-page.component";
import { hasProposedPlanEnvelope, renderMessageTextHtml } from "./message-renderer";
import {
  createOptimisticUserMessage,
  failOptimisticThreadMessage,
  mergeServerMessagesWithOptimistic,
  replaceOptimisticThreadMessage,
  updateOptimisticThreadMessage,
} from "./optimistic-thread-messages";
import { SLASH_COMMANDS, SlashCommandInfo } from "./slash-commands";
import {
  ApiService,
  ConnectorStatus,
  CreditUsageSummary,
  RouterTraceRecord,
  SetupStatus,
  ThreadAttachResponse,
  ThreadMessage,
  ThreadMessagesResponse,
  ThreadSummary,
  TimerRecord,
  OrkestrUser,
  VersionResponse,
  WhatsAppAccount,
  WhatsAppChat,
  WhatsAppOutboxJob,
  WhatsAppParticipant,
  WhatsAppStatusResponse,
} from "./api.service";
import { appendPendingFiles, messageWithAttachmentPaths, PendingFile, removePendingFile, uploadPendingFiles } from "./thread-uploads";

type Panel = "chat" | "history" | "delivery" | "timers" | "attach" | "settings" | "workers" | "runtime" | "raw" | "ops" | "files" | "userTimers" | "userDesk" | "userConnectors";
type CodexRateLimitKey = "primary" | "secondary";
type SetupPageMode = "setup" | "onboarding";
type SetupSection = "system" | "security" | "secrets" | "maintenance" | "codex" | "whatsapp" | "browsers";
type PersistedThreadTextField =
  | "draft"
  | "sidebarWorkerTask"
  | "timerLabel"
  | "timerCadence"
  | "timerTime"
  | "timerPrompt"
  | "approveText"
  | "interruptText";

interface ThreadMessagePageState {
  oldestCursor: number | null;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
}

const DEFAULT_WHATSAPP_REPLY_PREFIX = "orkestr:";
const MESSAGE_PAGE_LIMIT = 100;

@Component({
  selector: "ork-root",
  imports: [DatePipe, FormsModule, FirstThreadWizardComponent, FilesPageComponent, OpsPageComponent, OnboardingPageComponent, PairingRequiredPageComponent, ThreadComposerComponent, ThreadMessageListComponent, UserConnectorsPageComponent, UserDeskPageComponent, UserTimersPageComponent],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit, OnDestroy, AfterViewChecked {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly connectorStore = inject(ConnectorStore);
  private readonly runtimeStore = inject(RuntimeStore);
  private readonly threadStore = inject(ThreadStore);
  private readonly popStateHandler = () => {
    this.onboardingActive = this.onboardingFromPath();
    this.setupPageMode = this.setupPageModeFromPath();
    this.setupSection = this.setupSectionFromPath();
    this.selectedId = this.idFromPath();
    this.activePanel = this.panelFromPath();
    this.toolsView = this.toolsViewFromPath();
    this.normalizeLegacyRoutePath();
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (this.onboardingActive) {
      this.closeRawStream();
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (this.isRouteLevelUserPanel(this.activePanel)) {
      this.closeRawStream();
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (this.activePanel === "settings") {
      const selected = this.selectedThread();
      this.syncThreadMetaDraft(selected, true);
      this.syncThreadBindingDraft(selected, true);
      this.syncThreadTextState(selected, true);
      void this.refreshWhatsAppSettings().then(() => {
        void this.loadCreditUsage(this.selectedThread());
        if (!this.redirectThreadSettingsToWhatsAppSetupIfNeeded(this.selectedThread())) {
          void this.loadSelectedThread(true);
        }
      });
      return;
    }
    this.syncThreadTextState(this.selectedThread(), true);
    void this.loadSelectedThread(true);
  };

  @ViewChild("messagePane") private readonly messagePane?: ElementRef<HTMLElement>;
  @ViewChild("rawTerminalHost") private readonly rawTerminalHost?: ElementRef<HTMLElement>;
  @ViewChild(ThreadComposerComponent) private readonly composer?: ThreadComposerComponent;

  threads: ThreadSummary[] = [];
  readonly messageCache = signal<Record<string, ThreadMessage[]>>({});
  readonly messagePageState = signal<Record<string, ThreadMessagePageState>>({});
  readonly loadingThreadIds = signal<Record<string, boolean>>({});
  readonly activeThreadIds = signal<Record<string, number>>({});
  readonly slashCommands = SLASH_COMMANDS;
  historyMessages: ThreadMessage[] = [];
  deliveryTraces: RouterTraceRecord[] = [];
  deliveryOutboxJobs: WhatsAppOutboxJob[] = [];
  deliveryOutboxBusyJobId = "";
  timers: TimerRecord[] = [];
  allTimers: TimerRecord[] = [];
  runtimeDetails: Record<string, unknown> | null = null;
  attachDetails: ThreadAttachResponse | null = null;
  opsSystem: Record<string, unknown> | null = null;
  setupStatus: SetupStatus | null = null;
  versionInfo: VersionResponse | null = null;
  currentUser: OrkestrUser | null = null;
  selectedId = "";
  filterText = "";
  draft = "";
  error = "";
  apiOnline = false;
  busy = false;
  appReady = false;
  pairingRequired = false;
  sending = false;
  sendingNow = false;
  implementingPlan = false;
  threadWizardOpen = false;
  onboardingActive = false;
  setupPageMode: SetupPageMode = "setup";
  setupSection: SetupSection = "system";
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
  slashHelpOpen = false;
  creatingWorker = false;
  workerLabel = "Worker 1";
  workerTask = "";
  workerRepoPath = "";
  workerBranchName = "";
  workerAutoRun = true;
  gitDetailsThreadId = "";
  syncingThreadId = "";
  threadRepoDraft = "";
  threadBranchDraft = "";
  threadRemoteUrlDraft = "";
  threadRemoteBranchDraft = "";
  threadBaseBranchDraft = "";
  threadMetaThreadId = "";
  savingThreadMeta = false;
  detectingThreadRepo = false;
  whatsappBindingThreadId = "";
  whatsappChatId = "";
  whatsappDisplayName = "";
  whatsappReplyPrefix = DEFAULT_WHATSAPP_REPLY_PREFIX;
  whatsappSenderAccountId = "";
  whatsappOutboundAccountId = "";
  whatsappBindingEnabled = true;
  whatsappAllowOtherPeople = false;
  whatsappMirrorToWhatsApp = true;
  whatsappStatusDetails: WhatsAppStatusResponse | null = null;
  whatsappChats: WhatsAppChat[] = [];
  whatsappParticipants: WhatsAppParticipant[] = [];
  whatsappAdditionalParticipantIds: string[] = [];
  whatsappAdditionalParticipantLabels: Record<string, string> = {};
  whatsappChatsLoading = false;
  whatsappParticipantsLoading = false;
  savingThreadBinding = false;
  creatingWhatsAppChat = false;
  detachingWhatsAppChat = false;
  deletingThread = false;
  deleteThreadConfirm = "";
  deleteThreadWorkers = false;
  creditUsage: CreditUsageSummary | null = null;
  creditUsageLoading = false;
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
    this.setupPageMode = this.setupPageModeFromPath();
    this.setupSection = this.setupSectionFromPath();
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
      const [threadsResult, systemResult, setupResult, timersResult, whatsappResult, userResult, versionResult] = await Promise.allSettled([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.timers()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.currentUser()),
        firstValueFrom(this.api.version()),
      ]);
      if (systemResult.status === "fulfilled") this.opsSystem = systemResult.value;
      if (setupResult.status === "fulfilled") this.setupStatus = setupResult.value;
      if (timersResult.status === "fulfilled") this.allTimers = timersResult.value.timers || [];
      if (whatsappResult.status === "fulfilled") this.whatsappStatusDetails = whatsappResult.value;
      if (userResult.status === "fulfilled") this.currentUser = userResult.value.user;
      if (versionResult.status === "fulfilled") this.versionInfo = versionResult.value;
      this.appReady = true;
      if (this.isPairingRequiredFromSetup()) {
        this.apiOnline = true;
        this.enterPairingRequired();
        return;
      }
      this.pairingRequired = false;
      if (!this.uiRuntimeReady() && !this.onboardingActive) {
        this.apiOnline = true;
        this.threadWizardOpen = false;
        this.modelDetailsOpen = false;
        this.slashHelpOpen = false;
        this.gitDetailsThreadId = "";
        this.activePanel = "chat";
        this.closeRawStream();
        this.disconnectSummaryStream();
        this.updateDocumentTitle();
        this.error = "";
        return;
      }
      if (threadsResult.status === "rejected") {
        if (this.isPairingRequiredError(threadsResult.reason)) {
          this.apiOnline = true;
          this.enterPairingRequired();
          return;
        }
        throw threadsResult.reason;
      }
      const payload = threadsResult.value;
      this.apiOnline = true;
      this.trackThreadActivity(payload.threads);
      this.threads = [...payload.threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      this.seedReadStateIfNeeded(this.threads);
      this.normalizeUserModeView();
      if (this.shouldAutoOpenOnboarding()) {
        this.onboardingActive = true;
        this.setupPageMode = "setup";
        this.replaceSetupPath(this.setupSection || "system");
      }
      if (this.onboardingActive) {
        this.updateDocumentTitle();
        this.error = "";
        return;
      }
      if (!this.isRouteLevelUserPanel(this.activePanel) && !this.selectedId && this.threads.length) {
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
      this.connectSummaryStream();
    } catch (error) {
      this.apiOnline = false;
      this.error = this.errorText(error);
      this.appReady = true;
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  private isPairingRequiredFromSetup(setup: SetupStatus | null = this.setupStatus): boolean {
    const security = setup?.security;
    return Boolean((security?.authEnabled || security?.authRequired) && !security?.paired);
  }

  private isPairingRequiredError(error: unknown): boolean {
    const record = error && typeof error === "object" ? error as { error?: unknown; message?: unknown } : null;
    const body = record?.error;
    const bodyRecord = body && typeof body === "object" ? body as { error?: unknown; code?: unknown } : null;
    return (
      bodyRecord?.error === "browser_pairing_required" ||
      bodyRecord?.code === "browser_pairing_required" ||
      String(record?.message || body || error || "").includes("browser_pairing_required")
    );
  }

  private enterPairingRequired(setup: SetupStatus | null = this.setupStatus): void {
    if (setup) this.setupStatus = setup;
    this.apiOnline = true;
    this.appReady = true;
    this.pairingRequired = true;
    this.onboardingActive = false;
    this.setupPageMode = "setup";
    this.setupSection = "security";
    this.threadWizardOpen = false;
    this.modelDetailsOpen = false;
    this.slashHelpOpen = false;
    this.gitDetailsThreadId = "";
    this.activePanel = "chat";
    this.error = "";
    this.closeRawStream();
    this.disconnectSummaryStream();
    this.replacePairingPath();
    this.updateDocumentTitle();
    this.renderNow();
  }

  codexConnector(): ConnectorStatus | null {
    return this.setupStatus?.connectors?.find((connector) => connector.id === "codex") || null;
  }

  codexAgentReady(): boolean {
    return this.codexConnector()?.state === "connected";
  }

  private codexConnectorReason(): string {
    return String(this.codexConnector()?.details?.["reason"] || "").trim().toLowerCase();
  }

  private setupStatusRedacted(): boolean {
    return Boolean(this.setupStatus?.redacted);
  }

  private authContextIssue(): boolean {
    return this.pairingRequired || this.setupStatusRedacted() || this.isPairingRequiredFromSetup();
  }

  private codexStatusAuthoritative(): boolean {
    if (!this.setupStatus || this.authContextIssue()) return false;
    return Array.isArray(this.setupStatus.connectors) && this.setupStatus.connectors.some((connector) => connector.id === "codex");
  }

  isAdminMode(): boolean {
    return String(this.currentUser?.role || "admin").trim().toLowerCase() === "admin";
  }

  isUserMode(): boolean {
    return !this.isAdminMode();
  }

  uiRuntimeReady(): boolean {
    return true;
  }

  threadInputReady(): boolean {
    return this.isUserMode() || !this.codexStatusAuthoritative() || this.codexAgentReady();
  }

  shouldShowCodexRequiredShell(): boolean {
    return false;
  }

  shouldShowCodexNotice(): boolean {
    return this.isAdminMode() && this.codexStatusAuthoritative() && !this.codexAgentReady();
  }

  currentUserDisplayName(): string {
    return String(this.currentUser?.displayName || this.currentUser?.id || "User");
  }

  currentUserContactLabel(): string {
    return String(this.currentUser?.email || this.currentUser?.phoneNumber || this.currentUser?.id || "paired browser");
  }

  sidebarTitle(): string {
    return this.isUserMode() ? "My chat" : "Threads";
  }

  sidebarEyebrow(): string {
    return this.isUserMode() ? "Orkestr user" : "Orkestr";
  }

  sidebarSearchPlaceholder(): string {
    return this.isUserMode() ? "search my chat" : "agent, project, thread";
  }

  newThreadButtonLabel(): string {
    return this.isUserMode() ? "New chat" : "New Coding Agent";
  }

  emptyThreadTitle(): string {
    return this.isUserMode() ? "No chat assigned" : "No thread selected";
  }

  emptyThreadBody(): string {
    return this.isUserMode()
      ? "This user account does not have a chat yet."
      : "Select a thread from the left sidebar or create a new coding agent.";
  }

  userThreadLimitLabel(): string {
    const max = this.currentUser?.limits?.maxThreads;
    const count = this.threads.filter((thread) => !thread.parentThreadId).length;
    if (max === null || max === undefined) return `${count} chats`;
    return `${count}/${max} chats`;
  }

  canCreateThreadFromSidebar(): boolean {
    if (this.isAdminMode()) return true;
    const max = this.currentUser?.limits?.maxThreads;
    if (max === null || max === undefined) return false;
    const count = this.threads.filter((thread) => !thread.parentThreadId).length;
    return count < Number(max || 0);
  }

  panelAllowedForCurrentUser(panel: Panel): boolean {
    if (this.isAdminMode()) return true;
    return ["chat", "history", "delivery", "timers", "files", "userTimers", "userDesk", "userConnectors"].includes(panel);
  }

  isUserNavPanelActive(panel: Panel): boolean {
    if (panel === "chat") return ["chat", "history", "delivery", "timers"].includes(this.activePanel);
    return this.activePanel === panel;
  }

  private isRouteLevelUserPanel(panel: Panel): boolean {
    return ["ops", "files", "userTimers", "userDesk", "userConnectors"].includes(panel);
  }

  rawTerminalAvailable(thread: ThreadSummary | null = this.selectedThread()): boolean {
    return this.isAdminMode() && this.embeddedRawTerminalAvailable(thread);
  }

  embeddedRawTerminalAvailable(thread: ThreadSummary | null = this.selectedThread()): boolean {
    return Boolean(thread);
  }

  codexAgentStateLabel(): string {
    const connector = this.codexConnector();
    const state = String(connector?.state || "checking").toLowerCase();
    const reason = this.codexConnectorReason();
    if (state === "connected") return "connected";
    if (state === "partial") return "sign-in required";
    if (state === "not_connected" && reason === "codex_missing") return "runtime missing";
    if (state === "not_connected" && reason.includes("disabled")) return "disabled";
    if (state === "not_connected") return "runtime unavailable";
    return state.replace(/_/g, " ");
  }

  codexAgentSummary(): string {
    if (this.codexAgentReady()) return this.codexConnector()?.summary || "Codex Agent is connected.";
    if (this.authContextIssue()) return "This browser is not paired with the current Orkestr instance. Pair this browser or sign in before checking Codex runtime status.";
    const summary = this.codexConnector()?.summary || "Checking Codex Agent status.";
    if (this.codexConnectorReason() !== "codex_auth_invalid" && /Stored Codex sign-in is no longer valid/i.test(summary)) {
      return "Codex runtime status could not be confirmed for this Orkestr instance. Refresh same-origin setup status or check the browser pairing/login context.";
    }
    return `${summary} Connect Codex Agent before starting coding agents or sending coding-agent tasks.`;
  }

  codexRuntimeNoticeTitle(): string {
    const state = String(this.codexConnector()?.state || "").toLowerCase();
    const reason = this.codexConnectorReason();
    if (reason === "codex_auth_invalid") return "Codex sign-in expired";
    if (reason === "codex_app_server_auth_invalid") return "Codex app-server auth expired";
    if (reason === "codex_app_server_unavailable") return "Codex app-server unavailable";
    if (state === "broken") return "Codex runtime issue";
    if (state === "partial") return "Codex sign-in required";
    if (state === "not_connected") return "Codex runtime unavailable";
    return `Codex Agent ${this.codexAgentStateLabel()}`;
  }

  openCodexSetup(): void {
    this.openSetup("codex", true);
  }

  private guardCodexRuntime(): boolean {
    if (this.threadInputReady()) return true;
    this.error = "Connect Codex Agent before using the coding-agent runtime.";
    this.renderNow();
    return false;
  }

  private connectSummaryStream(): void {
    if (!this.appReady || this.pairingRequired || !this.uiRuntimeReady()) return;
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
    if (this.destroyed || this.pairingRequired || !this.appReady || !this.uiRuntimeReady() || this.summaryReconnectTimer) return;
    this.summaryReconnectTimer = setTimeout(() => {
      this.summaryReconnectTimer = undefined;
      this.connectSummaryStream();
    }, 5000);
  }

  private startFallbackPolling(): void {
    if (this.pairingRequired || !this.appReady || !this.uiRuntimeReady()) return;
    if (this.fallbackPoller) return;
    this.fallbackPoller = setInterval(() => void this.refresh(false), 30_000);
  }

  private stopFallbackPolling(): void {
    if (!this.fallbackPoller) return;
    clearInterval(this.fallbackPoller);
    this.fallbackPoller = undefined;
  }

  private disconnectSummaryStream(): void {
    if (this.summaryReconnectTimer) {
      clearTimeout(this.summaryReconnectTimer);
      this.summaryReconnectTimer = undefined;
    }
    const socket = this.summarySocket;
    this.summarySocket = undefined;
    socket?.close();
    this.stopFallbackPolling();
  }

  private async loadSystemSummarySilent(): Promise<void> {
    if (!this.onboardingActive && !this.pairingRequired && !this.uiRuntimeReady()) return;
    try {
      this.opsSystem = await firstValueFrom(this.api.systemSummary());
      this.renderNow();
    } catch {
      // System telemetry is best-effort and should not surface as a chat error.
    }
  }

  private async handleSummaryStreamMessage(raw: unknown): Promise<void> {
    if (this.pairingRequired || !this.uiRuntimeReady()) return;
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
    if (this.pairingRequired || !this.uiRuntimeReady()) return;
    if (this.applyingSummary) return;
    this.applyingSummary = true;
    try {
      const previousSelected = this.selectedThread();
      const previousSignature = this.threadReloadSignature(previousSelected);
      this.apiOnline = true;
      this.appReady = true;
      this.threads = [...threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      this.seedReadStateIfNeeded(this.threads);
      if (!this.isRouteLevelUserPanel(this.activePanel) && !this.selectedId && this.threads.length) {
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
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    const nextPanel = "chat";
    this.threadWizardOpen = false;
    this.selectedId = this.threadSlug(thread);
    this.activePanel = nextPanel;
    this.modelDetailsOpen = false;
    this.slashHelpOpen = false;
    this.gitDetailsThreadId = "";
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
    this.deliveryTraces = [];
    this.deliveryOutboxJobs = [];
    this.deliveryOutboxBusyJobId = "";
    this.timers = [];
    this.runtimeDetails = null;
    this.attachDetails = null;
    this.closeRawStream();
    this.shouldStickToBottom = this.activePanel === "chat";
    this.scrollAfterRender = this.activePanel === "chat";
  }

  private normalizeUserModeView(): void {
    if (!this.isUserMode()) return;
    if (this.activePanel === "raw") this.closeRawStream();
    this.modelDetailsOpen = false;
    this.gitDetailsThreadId = "";
    this.onboardingActive = false;
    if (!this.canCreateThreadFromSidebar()) this.threadWizardOpen = false;
    if (this.activePanel === "ops" || !this.panelAllowedForCurrentUser(this.activePanel)) {
      this.activePanel = "chat";
      const thread = this.selectedThread();
      if (thread) this.replacePath(this.threadSlug(thread), "chat");
    }
  }

  async openPanel(panel: Panel): Promise<void> {
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (!this.panelAllowedForCurrentUser(panel)) {
      this.activePanel = "chat";
      const thread = this.selectedThread();
      if (thread) this.replacePath(this.threadSlug(thread), "chat");
      this.renderNow();
      return;
    }
    if (panel === "ops") {
      this.openTools(this.toolsView);
      return;
    }
    if (panel === "files") {
      this.modelDetailsOpen = false;
      this.slashHelpOpen = false;
      this.gitDetailsThreadId = "";
      this.threadWizardOpen = false;
      if (this.activePanel === "raw") this.closeRawStream();
      this.activePanel = "files";
      this.pushPath("", "files");
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (panel === "userTimers") {
      this.modelDetailsOpen = false;
      this.slashHelpOpen = false;
      this.gitDetailsThreadId = "";
      this.threadWizardOpen = false;
      if (this.activePanel === "raw") this.closeRawStream();
      this.activePanel = "userTimers";
      this.pushPath("", "userTimers");
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (panel === "userDesk") {
      this.modelDetailsOpen = false;
      this.slashHelpOpen = false;
      this.gitDetailsThreadId = "";
      this.threadWizardOpen = false;
      if (this.activePanel === "raw") this.closeRawStream();
      this.activePanel = "userDesk";
      this.pushPath("", "userDesk");
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if (panel === "userConnectors") {
      this.modelDetailsOpen = false;
      this.slashHelpOpen = false;
      this.gitDetailsThreadId = "";
      this.threadWizardOpen = false;
      if (this.activePanel === "raw") this.closeRawStream();
      this.activePanel = "userConnectors";
      this.pushPath("", "userConnectors");
      this.updateDocumentTitle();
      this.renderNow();
      return;
    }
    if ((panel === "raw" || panel === "runtime") && !this.guardCodexRuntime()) return;
    if (panel === "raw" && !this.rawTerminalAvailable()) {
      this.activePanel = "chat";
      const thread = this.selectedThread();
      if (thread) this.pushPath(this.threadSlug(thread), "chat");
      return;
    }
    this.modelDetailsOpen = false;
    this.slashHelpOpen = false;
    this.gitDetailsThreadId = "";
    if (this.activePanel === "raw" && panel !== "raw") this.closeRawStream();
    this.activePanel = panel;
    const thread = this.selectedThread();
    if (thread) this.pushPath(this.threadSlug(thread), panel);
    if (panel === "history") await this.loadHistory();
    if (panel === "delivery") await this.loadDeliveryTraces();
    if (panel === "timers") await this.loadTimers();
    if (panel === "runtime") await this.loadRuntime();
    if (panel === "raw") await this.loadRaw();
    if (panel === "settings") {
      this.syncThreadBindingDraft(this.selectedThread(), true);
      await this.refreshWhatsAppSettings();
      await this.loadCreditUsage();
      if (this.redirectThreadSettingsToWhatsAppSetupIfNeeded(this.selectedThread())) return;
    }
    if (panel === "chat") {
      this.queueMessagePaneScrollToBottom();
    }
    this.renderNow();
  }

  openTools(view: ToolsView = this.toolsView): void {
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (this.isUserMode()) {
      this.activePanel = "chat";
      const thread = this.selectedThread();
      if (thread) this.replacePath(this.threadSlug(thread), "chat");
      this.renderNow();
      return;
    }
    if (this.activePanel === "raw") this.closeRawStream();
    this.modelDetailsOpen = false;
    this.slashHelpOpen = false;
    this.gitDetailsThreadId = "";
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
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (this.isUserMode()) {
      this.activePanel = "chat";
      const thread = this.selectedThread();
      if (thread) this.replacePath(this.threadSlug(thread), "chat");
      this.renderNow();
      return;
    }
    if (this.activePanel === "raw") this.closeRawStream();
    this.threadWizardOpen = false;
    this.onboardingActive = true;
    this.setupPageMode = "setup";
    this.clearOnboardingFlag("skipped");
    this.pushSetupPath(this.setupSection || "system");
    this.updateDocumentTitle();
    this.renderNow();
  }

  openSetup(section: SetupSection = this.setupSection || "system", replace = false): void {
    if (this.pairingRequired) section = "security";
    if (!this.pairingRequired && this.isUserMode()) {
      this.activePanel = "chat";
      this.onboardingActive = false;
      const thread = this.selectedThread();
      if (thread) this.replacePath(this.threadSlug(thread), "chat");
      this.renderNow();
      return;
    }
    if (this.activePanel === "raw") this.closeRawStream();
    this.threadWizardOpen = false;
    this.onboardingActive = true;
    this.setupPageMode = "setup";
    this.setupSection = section;
    if (replace) this.replaceSetupPath(section);
    else this.pushSetupPath(section);
    this.updateDocumentTitle();
    this.renderNow();
  }

  handleSetupSectionChange(section: string): void {
    this.openSetup(this.normalizeSetupSection(section));
  }

  async leaveOnboarding(completed = false): Promise<void> {
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (this.setupPageMode === "setup") {
      this.onboardingActive = false;
      this.threadWizardOpen = false;
      if (this.selectedThread()) {
        this.activePanel = "chat";
        this.pushPath(this.selectedId, "chat");
      } else {
        this.activePanel = "ops";
        this.toolsView = "connectors";
        this.pushOpsPath("connectors");
      }
      this.updateDocumentTitle();
      await this.refresh(false);
      return;
    }
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

  async handleBrowserPaired(): Promise<void> {
    const returnUrl = this.sameOriginPairingReturnUrl();
    if (returnUrl) {
      globalThis.location.replace(returnUrl);
      return;
    }
    this.pairingRequired = false;
    this.appReady = true;
    this.onboardingActive = false;
    globalThis.history?.replaceState({}, "", "/");
    await this.refresh(false);
  }

  openThreadWizard(): void {
    if (this.pairingRequired) {
      this.enterPairingRequired();
      return;
    }
    if (!this.canCreateThreadFromSidebar()) {
      this.error = "This user account is limited to one chat.";
      this.renderNow();
      return;
    }
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
    if (!thread || this.sending || this.sendingNow || this.implementingPlan) return;
    const originalText = this.draft.trim();
    if (!originalText && this.pendingFiles.length === 0) return;
    if (!this.guardCodexRuntime()) return;
    const pendingFiles = [...this.pendingFiles];
    const optimisticId = this.appendOptimisticUserMessage(thread.id, originalText, pendingFiles);
    this.clearSubmittedComposer(thread);
    this.sending = true;
    try {
      const attachments = await uploadPendingFiles(this.api, thread.id, pendingFiles);
      const text = messageWithAttachmentPaths(originalText, attachments);
      this.updateOptimisticUserMessage(thread.id, optimisticId, { text, attachments });
      this.markThreadActive(thread.id, 120_000);
      const response = await firstValueFrom(this.api.sendThreadInput(thread.id, text, attachments));
      this.replaceOptimisticUserMessage(thread.id, optimisticId, response.message);
      this.queueMessagePaneScrollToBottom();
      await this.refresh(false);
    } catch (error) {
      const detail = this.errorText(error);
      this.error = detail;
      this.failOptimisticUserMessage(thread.id, optimisticId, detail);
    } finally {
      this.sending = false;
    }
  }

  async sendMessageNow(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || this.sending || this.sendingNow || this.implementingPlan) return;
    const originalText = this.draft.trim();
    if (!originalText && this.pendingFiles.length === 0) return;
    if (!this.guardCodexRuntime()) return;
    const pendingFiles = [...this.pendingFiles];
    const optimisticId = this.appendOptimisticUserMessage(thread.id, originalText, pendingFiles, "interrupt", "interrupting");
    this.clearSubmittedComposer(thread);
    this.sendingNow = true;
    try {
      const attachments = await uploadPendingFiles(this.api, thread.id, pendingFiles);
      const text = messageWithAttachmentPaths(originalText, attachments);
      this.updateOptimisticUserMessage(thread.id, optimisticId, { text, attachments });
      this.markThreadActive(thread.id, 120_000);
      const response = await firstValueFrom(this.api.interruptThread(thread.id, text, attachments));
      this.replaceOptimisticUserMessage(thread.id, optimisticId, response.message);
      this.queueMessagePaneScrollToBottom();
      await this.refresh(false);
    } catch (error) {
      const detail = this.errorText(error);
      this.error = detail;
      this.failOptimisticUserMessage(thread.id, optimisticId, detail);
    } finally {
      this.sendingNow = false;
    }
  }

  async implementPlanSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || this.sending || this.sendingNow || this.implementingPlan) return;
    if (!this.guardCodexRuntime()) return;
    const optimisticId = this.appendOptimisticUserMessage(thread.id, "/implement", [], "implement_command");
    this.implementingPlan = true;
    try {
      this.markThreadActive(thread.id, 120_000);
      const response = await firstValueFrom(this.api.sendThreadInput(thread.id, "/implement"));
      this.replaceOptimisticUserMessage(thread.id, optimisticId, response.message);
      this.queueMessagePaneScrollToBottom();
      await this.refresh(false);
    } catch (error) {
      const detail = this.errorText(error);
      this.error = detail;
      this.failOptimisticUserMessage(thread.id, optimisticId, detail);
    } finally {
      this.implementingPlan = false;
    }
  }

  async wakeSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    if (!this.guardCodexRuntime()) return;
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

  async stopSelected(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.stopThread(thread.id));
      this.markThreadActive(thread.id, 15_000);
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
    if (!this.guardCodexRuntime()) return;
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
    if (!this.guardCodexRuntime()) return;
    if (!this.hasActionablePendingApproval(thread)) {
      this.error = "No Codex approval request is pending for this thread.";
      return;
    }
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
    if (!this.guardCodexRuntime()) return;
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
    if (!this.guardCodexRuntime()) return;
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
    this.gitDetailsThreadId = "";
    this.slashHelpOpen = false;
    this.modelDetailsOpen = true;
    this.renderNow();
  }

  closeModelDetails(): void {
    if (!this.modelDetailsOpen) return;
    this.modelDetailsOpen = false;
    this.renderNow();
  }

  openGitDetails(thread: ThreadSummary | null, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!thread) return;
    this.modelDetailsOpen = false;
    this.slashHelpOpen = false;
    this.gitDetailsThreadId = thread.id;
    this.renderNow();
  }

  closeGitDetails(): void {
    if (!this.gitDetailsThreadId) return;
    this.gitDetailsThreadId = "";
    this.renderNow();
  }

  handleGitBadgeAction(thread: ThreadSummary | null, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!thread) return;
    if (this.canDirectSyncThread(thread)) {
      void this.directSyncThread(thread);
      return;
    }
    this.openGitDetails(thread);
  }

  gitDetailsThread(): ThreadSummary | null {
    return this.gitDetailsThreadId ? this.threads.find((thread) => thread.id === this.gitDetailsThreadId) || null : null;
  }

  async directSyncThread(thread: ThreadSummary | null, event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    if (!thread || this.busy || !this.canDirectSyncThread(thread) || this.syncingThreadId) return;
    this.syncingThreadId = thread.id;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.syncThreadWithParent(thread.id));
      if (result.thread) this.replaceThread(result.thread);
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.syncingThreadId = "";
      this.busy = false;
      this.renderNow();
    }
  }

  async prepareIntelligentSync(thread: ThreadSummary | null, event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    if (!thread || !this.canPrepareIntelligentSync(thread)) return;
    if (this.selectedThread()?.id !== thread.id) {
      await this.activateThread(thread);
    }
    const prompt = this.intelligentSyncPrompt(thread);
    this.draft = prompt;
    this.persistThreadTextField("draft", prompt);
    this.closeGitDetails();
    this.queueMessagePaneScrollToBottom();
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

  async loadDeliveryTraces(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    this.busy = true;
    try {
      const [tracePayload, outboxPayload] = await Promise.all([
        firstValueFrom(this.api.routerTraces({ threadId: thread.id })),
        this.isAdminMode()
          ? firstValueFrom(this.api.whatsappOutbox({ threadId: thread.id, limit: 50 }))
          : Promise.resolve({ jobs: [], count: 0, total: 0 }),
      ]);
      this.deliveryTraces = tracePayload.traces || [];
      this.deliveryOutboxJobs = outboxPayload.jobs || [];
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
    if (!this.rawTerminalAvailable(thread)) {
      this.attachDetails = null;
      this.closeRawStream();
      this.activePanel = "chat";
      return;
    }
    this.busy = true;
    try {
      const [attach, runtime] = await Promise.all([
        firstValueFrom(this.api.attachThread(thread.id)),
        firstValueFrom(this.api.threadRuntimeFull(thread.id)).catch(() => null),
      ]);
      this.attachDetails = attach;
      if (runtime) this.runtimeDetails = runtime as unknown as Record<string, unknown>;
      if (attach.ok && !attach.watchOnly && this.embeddedRawTerminalAvailable(thread)) this.openRawStream(thread);
      else this.closeRawStream();
    } catch (error) {
      this.error = this.errorText(error);
      this.closeRawStream();
    } finally {
      this.busy = false;
    }
  }

  async takeoverRaw(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || !this.rawTerminalAvailable(thread)) return;
    this.busy = true;
    try {
      const [attach, runtime] = await Promise.all([
        firstValueFrom(this.api.attachThread(thread.id, { takeover: true, yes: true })),
        firstValueFrom(this.api.threadRuntimeFull(thread.id)).catch(() => null),
      ]);
      this.attachDetails = attach;
      if (runtime) this.runtimeDetails = runtime as unknown as Record<string, unknown>;
      if (!attach.ok) {
        this.error = attach.message || "Raw terminal takeover failed.";
        this.closeRawStream();
        return;
      }
      this.openRawStream(thread);
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

  async runTimer(timer: TimerRecord): Promise<void> {
    if (!timer.id || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.runTimer(timer.id));
      await this.loadTimers();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async toggleTimer(timer: TimerRecord): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || !timer.id || this.busy) return;
    this.busy = true;
    try {
      const payload = timer.enabled === false
        ? await firstValueFrom(this.api.resumeThreadTimer(thread.id, timer.id))
        : await firstValueFrom(this.api.pauseThreadTimer(thread.id, timer.id));
      if (payload.timer) this.allTimers = this.upsertTimer(this.allTimers, payload.timer);
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
    if (task && this.workerAutoRun && !this.guardCodexRuntime()) return;
    const shouldWake = this.codexAgentReady();
    this.creatingWorker = true;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        label: this.workerLabel.trim() || `Worker ${this.childWorkers(thread).length + 1}`,
        autoRun: this.workerAutoRun && Boolean(task) && shouldWake,
        wake: shouldWake,
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
        repoRemoteUrl: this.threadRemoteUrlDraft.trim(),
        branchName: this.threadBranchDraft.trim(),
        remoteBranch: this.threadRemoteBranchDraft.trim(),
        baseBranch: this.threadBaseBranchDraft.trim(),
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

  whatsappChatNamePlaceholder(): string {
    const prefix = this.whatsappChatNamePrefix();
    return prefix ? `${prefix}-features-worker-1` : "team-features-worker-1";
  }

  private defaultWhatsAppReplyPrefix(): string {
    return String(this.setupStatus?.whatsappDefaults?.replyPrefix || DEFAULT_WHATSAPP_REPLY_PREFIX).trim() || DEFAULT_WHATSAPP_REPLY_PREFIX;
  }

  private whatsappChatNamePrefix(): string {
    return String(this.setupStatus?.whatsappDefaults?.chatNamePrefix || "").trim().replace(/-+$/g, "");
  }

  private withWhatsAppChatNamePrefix(name: string): string {
    const cleanName = String(name || "").trim();
    const prefix = this.whatsappChatNamePrefix();
    if (!cleanName || !prefix) return cleanName;
    const lowerName = cleanName.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lowerName === lowerPrefix || lowerName.startsWith(`${lowerPrefix}-`)) return cleanName;
    return `${prefix}-${cleanName}`;
  }

  async saveThreadBinding(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.savingThreadBinding) return;
    this.savingThreadBinding = true;
    this.busy = true;
    try {
      const additionalParticipantIds = this.whatsappAllowOtherPeople ? this.whatsappSelectedAdditionalParticipantIds(thread) : [];
      const receivingAccountId = this.selectedWhatsAppInboundAccountId();
      const replyAccountId = this.selectedWhatsAppReplyAccountId();
      const result = await firstValueFrom(this.api.updateThreadBinding(thread.id, {
        connector: "whatsapp",
        chatId: this.whatsappChatId.trim(),
        displayName: this.whatsappDisplayName.trim() || this.threadTitle(thread),
        enabled: this.whatsappBindingEnabled,
        allowOtherPeople: this.whatsappAllowOtherPeople,
        additionalParticipantsEnabled: this.whatsappAllowOtherPeople,
        additionalParticipantIds,
        additionalParticipantLabels: this.whatsappAllowOtherPeople ? this.whatsappSelectedParticipantLabels(thread) : {},
        mirrorToWhatsApp: this.whatsappMirrorToWhatsApp,
        replyPrefix: this.whatsappReplyPrefix.trim() || this.defaultWhatsAppReplyPrefix(),
        receivingAccountId,
        inboundAccountId: receivingAccountId,
        senderAccountId: receivingAccountId,
        replyAccountId,
        bridgeAccountId: replyAccountId,
        responderConnectorAccountId: replyAccountId,
        responderAccountId: replyAccountId,
        outboundAccountId: replyAccountId,
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

  async refreshWhatsAppSettings(): Promise<void> {
    try {
      this.whatsappStatusDetails = await firstValueFrom(this.api.whatsappStatus());
      await this.loadWhatsAppChats();
      await this.loadWhatsAppParticipants();
    } catch (error) {
      this.error = this.errorText(error);
    }
  }

  async loadCreditUsage(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    const ownerUserId = this.threadOwnerUserId(thread);
    if (!ownerUserId) {
      this.creditUsage = null;
      return;
    }
    this.creditUsageLoading = true;
    try {
      this.creditUsage = (await firstValueFrom(this.api.userCreditUsage(ownerUserId))).usage || null;
    } catch (error) {
      this.creditUsage = null;
      this.error = this.errorText(error);
    } finally {
      this.creditUsageLoading = false;
      this.renderNow();
    }
  }

  async changeWhatsAppSenderAccount(accountId: string): Promise<void> {
    this.whatsappSenderAccountId = accountId;
    await this.loadWhatsAppParticipants();
  }

  async changeWhatsAppAccount(accountId: string): Promise<void> {
    this.whatsappOutboundAccountId = accountId;
    await this.loadWhatsAppChats();
    await this.loadWhatsAppParticipants();
  }

  async changeWhatsAppInboundAccount(accountId: string): Promise<void> {
    await this.changeWhatsAppSenderAccount(accountId);
  }

  async changeWhatsAppReplyAccount(accountId: string): Promise<void> {
    await this.changeWhatsAppAccount(accountId);
  }

  async startWhatsAppAccount(accountId: string): Promise<void> {
    if (!accountId || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.startWhatsAppAccount(accountId));
      await this.refreshWhatsAppSettings();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async logoutWhatsAppAccount(accountId: string): Promise<void> {
    if (!accountId || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.logoutWhatsAppAccount(accountId));
      await this.refreshWhatsAppSettings();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async startSelectedWhatsAppAccount(): Promise<void> {
    await this.startWhatsAppAccount(this.selectedWhatsAppAccountId());
  }

  async logoutSelectedWhatsAppAccount(): Promise<void> {
    await this.logoutWhatsAppAccount(this.selectedWhatsAppAccountId());
  }

  async startSelectedWhatsAppInboundAccount(): Promise<void> {
    await this.startWhatsAppAccount(this.selectedWhatsAppInboundAccountId());
  }

  async logoutSelectedWhatsAppInboundAccount(): Promise<void> {
    await this.logoutWhatsAppAccount(this.selectedWhatsAppInboundAccountId());
  }

  async startSelectedWhatsAppReplyAccount(): Promise<void> {
    await this.startWhatsAppAccount(this.selectedWhatsAppReplyAccountId());
  }

  async logoutSelectedWhatsAppReplyAccount(): Promise<void> {
    await this.logoutWhatsAppAccount(this.selectedWhatsAppReplyAccountId());
  }

  async createAndConnectWhatsAppChat(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.creatingWhatsAppChat || this.savingThreadBinding) return;
    const name = this.withWhatsAppChatNamePrefix(this.whatsappDisplayName.trim() || this.threadTitle(thread));
    if (!name) return;
    this.creatingWhatsAppChat = true;
    this.savingThreadBinding = true;
    this.busy = true;
    try {
      const receivingAccountId = this.selectedWhatsAppInboundAccountId();
      const replyAccountId = this.selectedWhatsAppReplyAccountId();
      const created = await firstValueFrom(this.api.createWhatsAppBridgeChat({
        name,
        receivingAccountId,
        senderAccountId: receivingAccountId,
        replyAccountId,
        bridgeAccountId: replyAccountId,
        responderAccountId: replyAccountId,
      }));
      const chatId = String(created.chat?.id || "").trim();
      if (!chatId) throw new Error("WhatsApp chat was not created.");
      this.whatsappChatId = chatId;
      this.whatsappDisplayName = String(created.chat?.name || name).trim();
      this.whatsappBindingEnabled = true;
      this.whatsappAllowOtherPeople = false;
      this.whatsappAdditionalParticipantIds = [];
      this.whatsappAdditionalParticipantLabels = {};
      this.whatsappMirrorToWhatsApp = true;
      const result = await firstValueFrom(this.api.updateThreadBinding(thread.id, {
        connector: "whatsapp",
        chatId,
        displayName: this.whatsappDisplayName,
        enabled: true,
        allowOtherPeople: false,
        additionalParticipantsEnabled: false,
        additionalParticipantIds: [],
        additionalParticipantLabels: {},
        mirrorToWhatsApp: true,
        replyPrefix: this.whatsappReplyPrefix.trim() || this.defaultWhatsAppReplyPrefix(),
        receivingAccountId,
        inboundAccountId: receivingAccountId,
        senderAccountId: receivingAccountId,
        replyAccountId,
        bridgeAccountId: replyAccountId,
        responderConnectorAccountId: replyAccountId,
        responderAccountId: replyAccountId,
        outboundAccountId: replyAccountId,
        senderContactId: created.senderContactId || "",
        responderContactId: created.responderContactId || "",
        generated: true,
      }));
      if (result.thread) this.replaceThread(result.thread);
      this.syncThreadBindingDraft(result.thread || thread, true);
      await this.loadWhatsAppChats();
      await this.loadWhatsAppParticipants();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.creatingWhatsAppChat = false;
      this.savingThreadBinding = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async detachWhatsAppChat(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.detachingWhatsAppChat) return;
    const confirmed = typeof globalThis.confirm === "function"
      ? globalThis.confirm("Detach this WhatsApp chat? Orkestr will stop listening and stop sending replies. The WhatsApp chat itself will not be deleted.")
      : true;
    if (!confirmed) return;
    this.detachingWhatsAppChat = true;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.updateThreadBinding(thread.id, {
        connector: "whatsapp",
        chatId: "",
        displayName: this.threadTitle(thread),
        enabled: false,
        allowOtherPeople: false,
        additionalParticipantsEnabled: false,
        additionalParticipantIds: [],
        additionalParticipantLabels: {},
        mirrorToWhatsApp: false,
        replyPrefix: this.whatsappReplyPrefix.trim() || this.defaultWhatsAppReplyPrefix(),
        inboundAccountId: "",
        senderAccountId: "",
        responderConnectorAccountId: "",
        responderAccountId: "",
        outboundAccountId: "",
        senderContactId: "",
        responderContactId: "",
        generated: false,
      }));
      if (result.thread) this.replaceThread(result.thread);
      this.syncThreadBindingDraft(result.thread || thread, true);
      this.whatsappParticipants = [];
      this.whatsappAdditionalParticipantIds = [];
      this.whatsappAdditionalParticipantLabels = {};
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.detachingWhatsAppChat = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async loadWhatsAppChats(): Promise<void> {
    const accountId = this.selectedWhatsAppReplyAccountId();
    if (!accountId || !this.canLoadLocalWhatsAppChats(accountId)) {
      this.whatsappChats = [];
      return;
    }
    this.whatsappChatsLoading = true;
    try {
      const result = await firstValueFrom(this.api.whatsappBridgeChats(accountId));
      this.whatsappChats = result.chats || [];
    } catch {
      this.whatsappChats = [];
    } finally {
      this.whatsappChatsLoading = false;
      this.renderNow();
    }
  }

  async loadWhatsAppParticipants(): Promise<void> {
    const accountId = this.selectedWhatsAppInboundAccountId();
    const chatId = this.whatsappChatId.trim();
    if (!accountId || !chatId) {
      this.whatsappParticipants = [];
      return;
    }
    this.whatsappParticipantsLoading = true;
    try {
      const result = await firstValueFrom(this.api.whatsappBridgeChatParticipants(accountId, chatId));
      this.whatsappParticipants = result.participants || [];
      this.mergeWhatsAppParticipantLabels();
    } catch {
      this.whatsappParticipants = [];
    } finally {
      this.whatsappParticipantsLoading = false;
      this.renderNow();
    }
  }

  async changeWhatsAppAdditionalParticipants(enabled: boolean): Promise<void> {
    this.whatsappAllowOtherPeople = enabled;
    if (!enabled) {
      this.whatsappAdditionalParticipantIds = [];
      return;
    }
    await this.loadWhatsAppParticipants();
  }

  changeWhatsAppParticipantAccess(participant: WhatsAppParticipant, enabled: boolean): void {
    const id = this.whatsappParticipantId(participant);
    if (!id) return;
    const next = new Set(this.whatsappAdditionalParticipantIds.map((value) => value.toLowerCase()));
    if (enabled) {
      next.add(id.toLowerCase());
      const name = this.whatsappParticipantName(participant);
      if (name) this.whatsappAdditionalParticipantLabels[id] = name;
    } else {
      next.delete(id.toLowerCase());
      delete this.whatsappAdditionalParticipantLabels[id];
    }
    this.whatsappAdditionalParticipantIds = this.whatsappParticipants
      .map((item) => this.whatsappParticipantId(item))
      .concat(this.whatsappAdditionalParticipantIds)
      .filter((value, index, values) => value && values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index)
      .filter((value) => next.has(value.toLowerCase()));
  }

  changeWhatsAppParticipantIdAccess(participantId: string, enabled: boolean): void {
    this.changeWhatsAppParticipantAccess({ id: participantId }, enabled);
  }

  selectWhatsAppChat(chatId: string): void {
    this.whatsappChatId = chatId;
    const chat = this.whatsappChats.find((item) => item.id === chatId);
    if (chat?.name) this.whatsappDisplayName = chat.name;
  }

  async deleteSelectedThread(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    if (!thread || this.deletingThread || !this.threadDeleteConfirmMatches(thread)) return;
    const title = this.threadTitle(thread);
    const confirmed = typeof globalThis.confirm === "function"
      ? globalThis.confirm(`Delete "${title}" from Orkestr? This removes stored messages and cannot be undone.`)
      : true;
    if (!confirmed) return;
    this.deletingThread = true;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.deleteThread(thread.id, this.deleteThreadWorkers));
      const deleted = new Set(result.deletedThreads || [thread.id]);
      this.messageCache.update((cache) => {
        const next = { ...cache };
        for (const id of deleted) delete next[id];
        return next;
      });
      this.selectedId = "";
      this.deleteThreadConfirm = "";
      this.deleteThreadWorkers = false;
      this.activePanel = "chat";
      await this.refresh(false);
      if (!this.threads.length) {
        this.threadWizardOpen = true;
        globalThis.history?.pushState({}, "", "/");
      }
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.deletingThread = false;
      this.busy = false;
      this.renderNow();
    }
  }

  async createSidebarWorker(thread: ThreadSummary | null = this.selectedThread()): Promise<void> {
    const parent = this.workerParentThread(thread);
    const task = this.sidebarWorkerTask.trim();
    if (!parent || this.creatingSidebarWorker) return;
    if (task && !this.guardCodexRuntime()) return;
    const shouldWake = this.codexAgentReady();
    this.creatingSidebarWorker = true;
    this.creatingWorkerParentId = parent.id;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        autoRun: Boolean(task) && shouldWake,
        wake: shouldWake,
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
    const shouldWake = this.codexAgentReady();
    this.creatingSidebarWorker = true;
    this.creatingWorkerParentId = root.id;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        label: `Worker ${this.childWorkers(root).length + 1}`,
        autoRun: false,
        wake: shouldWake,
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

  rememberScrollPosition(): void {
    const pane = this.messagePane?.nativeElement;
    if (!pane) return;
    this.shouldStickToBottom = this.isMessagePaneNearBottom();
  }

  private restoreMessagePaneOffset(previousScrollHeight: number, previousScrollTop: number): void {
    if (this.activePanel !== "chat") return;
    const run = () => {
      const pane = this.messagePane?.nativeElement;
      if (!pane) return;
      const delta = pane.scrollHeight - previousScrollHeight;
      pane.scrollTop = previousScrollTop + Math.max(0, delta);
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(run));
    } else {
      globalThis.setTimeout?.(run, 0);
    }
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

  private focusComposerSoon(): void {
    globalThis.setTimeout(() => {
      this.composer?.focusEnd();
    }, 0);
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

  selectedMessagesHasOlder(): boolean {
    const thread = this.selectedThread();
    if (!thread) return false;
    const page = this.messagePageState()[thread.id];
    return Boolean(page?.hasMoreBefore);
  }

  selectedMessagesLoadingOlder(): boolean {
    const thread = this.selectedThread();
    if (!thread) return false;
    const page = this.messagePageState()[thread.id];
    return Boolean(page?.loadingOlder);
  }

  private appendOptimisticUserMessage(
    threadId: string,
    text: string,
    pendingFiles: PendingFile[],
    source = "ui",
    deliveryState = "sending",
  ): string {
    const message = createOptimisticUserMessage(text, pendingFiles, { source, deliveryState });
    this.messageCache.update((cache) => ({
      ...cache,
      [threadId]: [...(cache[threadId] || []), message],
    }));
    this.queueMessagePaneScrollToBottom();
    this.markThreadActive(threadId, 120_000);
    return message.id;
  }

  private clearSubmittedComposer(thread: ThreadSummary): void {
    this.draft = "";
    this.clearThreadTextField(thread, "draft");
    this.pendingFiles = [];
  }

  private updateOptimisticUserMessage(threadId: string, optimisticId: string, patch: Partial<ThreadMessage>): void {
    this.messageCache.update((cache) => ({
      ...cache,
      [threadId]: updateOptimisticThreadMessage(cache[threadId] || [], optimisticId, patch),
    }));
  }

  private replaceOptimisticUserMessage(threadId: string, optimisticId: string, serverMessage: ThreadMessage | null | undefined): void {
    this.messageCache.update((cache) => ({
      ...cache,
      [threadId]: replaceOptimisticThreadMessage(cache[threadId] || [], optimisticId, serverMessage),
    }));
  }

  private failOptimisticUserMessage(threadId: string, optimisticId: string, detail: string): void {
    this.messageCache.update((cache) => ({
      ...cache,
      [threadId]: failOptimisticThreadMessage(cache[threadId] || [], optimisticId, detail),
    }));
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

  threadOwnerUserId(thread: ThreadSummary | null): string {
    return String(thread?.ownerUserId || thread?.["userId"] || "").trim();
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

  threadBaseBranchLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    return String(
      thread.baseBranch ||
      this.objectValue(thread.runtime, "baseBranch") ||
      this.objectValue(metadata, "baseBranch") ||
      "",
    ).trim();
  }

  threadGitDeltaLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    const dirtyLabel = this.gitDirtyLabel(thread);
    if (thread.parentThreadId) {
      return [
        this.gitParentShortLabel(thread),
        this.gitRemoteShortLabel(thread),
        dirtyLabel,
      ].filter(Boolean).join(" · ");
    }
    return [this.gitRemoteShortLabel(thread), dirtyLabel].filter(Boolean).join(" · ");
  }

  gitParentShortLabel(thread: ThreadSummary | null): string {
    if (!thread?.parentThreadId) return "";
    return `Parent: ${this.gitAheadBehindPhrase(this.threadNumberValue(thread, "gitParentAhead"), this.threadNumberValue(thread, "gitParentBehind"), "up to date")}`;
  }

  gitRemoteShortLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    if (this.booleanThreadValue(thread, "gitRemoteMissing")) return `Remote: ${thread.parentThreadId ? "not published" : "not found"}`;
    const remoteAhead = this.threadNumberValue(thread, "gitRemoteAhead");
    const remoteBehind = this.threadNumberValue(thread, "gitRemoteBehind");
    const ahead = Number.isFinite(remoteAhead) ? remoteAhead : this.threadNumberValue(thread, "gitAhead");
    const behind = Number.isFinite(remoteBehind) ? remoteBehind : this.threadNumberValue(thread, "gitBehind");
    return `Remote: ${this.gitAheadBehindPhrase(ahead, behind, "clean")}`;
  }

  gitDirtyLabel(thread: ThreadSummary | null): string {
    const dirty = this.gitDirtyFiles(thread);
    return dirty > 0 ? `Dirty: ${dirty} ${dirty === 1 ? "file" : "files"}` : "Clean";
  }

  gitParentDetailLabel(thread: ThreadSummary | null): string {
    if (!thread?.parentThreadId) return "Parent comparison is not used for root threads.";
    const files = this.threadNumberValue(thread, "gitParentChangedFiles");
    return `${this.gitParentShortLabel(thread)} · ${this.gitFilesChangedLabel(files)}`;
  }

  gitRemoteDetailLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    if (this.booleanThreadValue(thread, "gitRemoteMissing")) {
      return `${this.gitRemoteShortLabel(thread)} · ${this.threadRemoteBranchLabel(thread) || "No remote branch set"}`;
    }
    const files = this.threadNumberValue(thread, "gitRemoteChangedFiles");
    return `${this.gitRemoteShortLabel(thread)} · ${this.gitFilesChangedLabel(files)}`;
  }

  gitRiskLabels(thread: ThreadSummary | null): string[] {
    if (!thread) return [];
    const risks: string[] = [];
    const dirty = this.gitDirtyFiles(thread);
    const parentAhead = this.gitCount(thread, "gitParentAhead");
    const parentBehind = this.gitCount(thread, "gitParentBehind");
    const remoteAhead = this.gitCount(thread, "gitRemoteAhead");
    const remoteBehind = this.gitCount(thread, "gitRemoteBehind");
    if (thread.parentThreadId && parentBehind > 0) risks.push(`Worker is missing ${parentBehind} parent ${parentBehind === 1 ? "commit" : "commits"}.`);
    if (thread.parentThreadId && parentAhead > 0) risks.push(`Worker has ${parentAhead} ${parentAhead === 1 ? "commit" : "commits"} not in parent.`);
    if (dirty > 0) risks.push(`${dirty} local ${dirty === 1 ? "file is" : "files are"} not committed.`);
    if (this.booleanThreadValue(thread, "gitRemoteMissing")) risks.push(thread.parentThreadId ? "Worker branch is local only." : "Configured remote branch was not found.");
    if (!this.booleanThreadValue(thread, "gitRemoteMissing") && remoteBehind > 0) risks.push(`Local branch is missing ${remoteBehind} remote ${remoteBehind === 1 ? "commit" : "commits"}.`);
    if (!this.booleanThreadValue(thread, "gitRemoteMissing") && remoteAhead > 0) risks.push(`${remoteAhead} local ${remoteAhead === 1 ? "commit is" : "commits are"} not pushed.`);
    return risks.length ? risks : ["No git drift detected."];
  }

  threadHasGitInfo(thread: ThreadSummary | null): boolean {
    return Boolean(thread && (this.threadBranchLabel(thread) || this.threadRemoteLabel(thread) || this.defaultRepoPath(thread)));
  }

  threadGitBadgeLabel(thread: ThreadSummary | null): string {
    if (this.canDirectSyncThread(thread)) return "↻";
    if (thread?.parentThreadId && this.gitCount(thread, "gitParentBehind") > 0) return "stale";
    if (thread?.parentThreadId && this.gitCount(thread, "gitParentAhead") > 0) return "merge";
    if (this.gitDirtyFiles(thread) > 0) return "dirty";
    return "git";
  }

  threadGitBadgeTitle(thread: ThreadSummary | null): string {
    if (this.canDirectSyncThread(thread)) return "Direct sync this worker with its parent.";
    return thread ? this.threadGitDeltaLabel(thread) : "Git details";
  }

  canDirectSyncThread(thread: ThreadSummary | null): boolean {
    return Boolean(
      thread?.parentThreadId &&
      this.gitCount(thread, "gitParentBehind") > 0 &&
      this.gitCount(thread, "gitParentAhead") === 0 &&
      this.gitDirtyFiles(thread) === 0 &&
      !this.isThreadProcessing(thread),
    );
  }

  canPrepareIntelligentSync(thread: ThreadSummary | null): boolean {
    return Boolean(thread?.parentThreadId && !this.syncingThreadId && this.threadDraftEmpty(thread));
  }

  intelligentSyncDisabledReason(thread: ThreadSummary | null): string {
    if (!thread?.parentThreadId) return "Only worker threads can be synced with a parent.";
    if (!this.threadDraftEmpty(thread)) return "Composer is not empty.";
    return "";
  }

  intelligentSyncPrompt(thread: ThreadSummary): string {
    return [
      "Sync this worker with its parent.",
      `Current state: ${this.threadGitDeltaLabel(thread)}.`,
      "Bring in parent updates, preserve worker-specific changes, inspect conflicts if needed, run focused checks, and report the result.",
      "Do not push unless explicitly asked.",
    ].join("\n");
  }

  private gitAheadBehindPhrase(ahead: number, behind: number, cleanLabel: string): string {
    const parts: string[] = [];
    const safeAhead = Number.isFinite(ahead) ? Math.max(0, Math.round(ahead)) : 0;
    const safeBehind = Number.isFinite(behind) ? Math.max(0, Math.round(behind)) : 0;
    if (safeAhead > 0) parts.push(`${safeAhead} ahead`);
    if (safeBehind > 0) parts.push(`${safeBehind} behind`);
    return parts.length ? parts.join(", ") : cleanLabel;
  }

  gitFilesChangedLabel(value: number): string {
    if (!Number.isFinite(value)) return "files unknown";
    const files = Math.max(0, Math.round(value));
    return `${files} ${files === 1 ? "file differs" : "files differ"}`;
  }

  gitDirtyFiles(thread: ThreadSummary | null): number {
    return this.gitCount(thread, "gitDirtyFiles");
  }

  gitCount(thread: ThreadSummary | null, key: string): number {
    const value = this.threadNumberValue(thread, key);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  private threadDraftEmpty(thread: ThreadSummary): boolean {
    const draft = this.selectedThread()?.id === thread.id ? this.draft : this.readThreadTextField(thread, "draft") || "";
    return !draft.trim();
  }

  threadMetaDirty(thread: ThreadSummary | null = this.selectedThread()): boolean {
    if (!thread || this.threadMetaThreadId !== thread.id) return false;
    return this.threadRepoDraft.trim() !== this.defaultRepoPath(thread) ||
      this.threadRemoteUrlDraft.trim() !== this.threadRemoteUrl(thread) ||
      this.threadBranchDraft.trim() !== this.threadBranchLabel(thread) ||
      this.threadRemoteBranchDraft.trim() !== this.threadRemoteBranchLabel(thread) ||
      this.threadBaseBranchDraft.trim() !== this.threadBaseBranchLabel(thread);
  }

  threadBindingDirty(thread: ThreadSummary | null = this.selectedThread()): boolean {
    if (!thread || this.whatsappBindingThreadId !== thread.id) return false;
    const binding = thread.binding || {};
    const chatId = this.whatsappChatId.trim();
    const accountDirty = Boolean(chatId || binding.chatId) && this.selectedWhatsAppReplyAccountId() !== String(binding.replyAccountId || binding.bridgeAccountId || binding.responderConnectorAccountId || binding.responderAccountId || binding.outboundAccountId || "").trim();
    const senderDirty = Boolean(chatId || binding.chatId) && this.selectedWhatsAppInboundAccountId() !== String(binding.receivingAccountId || binding.inboundAccountId || binding.senderAccountId || binding.outboundAccountId || "").trim();
    const savedParticipantIds = binding.additionalParticipantsEnabled === true
      ? this.normalizeWhatsAppParticipantIds(binding.additionalParticipantIds).filter((id) => !this.whatsappSystemParticipantIds(thread).has(id.toLowerCase()))
      : [];
    const draftParticipantIds = this.whatsappAllowOtherPeople ? this.whatsappSelectedAdditionalParticipantIds(thread) : [];
    return chatId !== String(binding.chatId || "") ||
      this.whatsappDisplayName.trim() !== String(binding.displayName || this.threadTitle(thread)) ||
      this.whatsappReplyPrefix.trim() !== String(binding.replyPrefix || this.defaultWhatsAppReplyPrefix()) ||
      accountDirty ||
      senderDirty ||
      this.whatsappBindingEnabled !== (binding.enabled !== false) ||
      this.whatsappAllowOtherPeople !== (binding.additionalParticipantsEnabled === true) ||
      !this.sameWhatsAppParticipantIds(draftParticipantIds, savedParticipantIds) ||
      this.whatsappMirrorToWhatsApp !== (binding.mirrorToWhatsApp !== false);
  }

  whatsappAccounts(): WhatsAppAccount[] {
    const status = (this.whatsappStatusDetails || {}) as WhatsAppStatusResponse;
    const health = status.health && typeof status.health === "object" ? status.health as Record<string, unknown> : {};
    const candidates = [
      ...(Array.isArray(status.accounts) ? status.accounts : []),
      ...(Array.isArray(health["accounts"]) ? health["accounts"] as WhatsAppAccount[] : []),
    ];
    const seen = new Set<string>();
    return candidates.filter((account) => {
      const id = this.whatsappAccountId(account);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  connectedWhatsAppAccounts(): WhatsAppAccount[] {
    return this.whatsappAccounts().filter((account) => this.whatsappAccountConnected(account));
  }

  hasConnectedWhatsAppAccounts(): boolean {
    return this.connectedWhatsAppAccounts().length > 0;
  }

  whatsappAccountId(account: WhatsAppAccount | Record<string, unknown> | null): string {
    if (!account) return "";
    return String(account["accountId"] || account["id"] || account["name"] || "").trim();
  }

  whatsappNumericIdentity(value: unknown): string {
    const text = String(value || "").trim();
    if (!text) return "";
    const compact = text
      .replace(/^whatsapp:/i, "")
      .replace(/@(c\.us|s\.whatsapp\.net|lid)$/i, "")
      .replace(/[()\s.-]+/g, "");
    const match = compact.match(/^\+?([0-9]{5,})$/);
    return match ? match[1] : "";
  }

  whatsappAccountLookupIds(account: WhatsAppAccount | Record<string, unknown> | null): string[] {
    if (!account) return [];
    return [
      account["accountId"],
      account["id"],
      account["runtimeAccountId"],
      account["relayTargetAccountId"],
      account["phoneIdentity"],
      account["phoneNumber"],
      account["contactId"],
      ...(Array.isArray(account["legacyRoleAliases"]) ? account["legacyRoleAliases"] as unknown[] : []),
    ]
      .flatMap((value) => {
        const text = String(value || "").trim();
        const numeric = this.whatsappNumericIdentity(text);
        return [text, numeric].filter(Boolean);
      })
      .filter((value, index, all) => all.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index);
  }

  whatsappAccountConnected(account: WhatsAppAccount | Record<string, unknown> | null): boolean {
    if (!account) return false;
    if (account["ready"] === true) return true;
    const state = this.whatsappAccountState(account).toLowerCase();
    return ["ready", "paired", "connected", "authenticated"].includes(state);
  }

  whatsappAccountLabel(account: WhatsAppAccount | Record<string, unknown> | null): string {
    if (!account) return "";
    const id = this.whatsappAccountId(account);
    const phone = String(account["phoneNumber"] || account["phoneIdentity"] || "").trim();
    const label = String(account["label"] || account["displayName"] || account["name"] || "").trim();
    if (phone && ["sender", "responder", "account-1", "account-2"].includes(id.toLowerCase())) return phone;
    return phone || label || id;
  }

  whatsappAccountState(account: WhatsAppAccount | Record<string, unknown> | null): string {
    if (!account) return "";
    if (account["ready"] === true) return "ready";
    return String(account["state"] || account["status"] || "").trim();
  }

  whatsappRelayTargetAccountId(account: WhatsAppAccount | Record<string, unknown> | null): string {
    if (!account) return "";
    return String(account["relayTargetAccountId"] || account["senderAccountId"] || account["inboundAccountId"] || "").trim();
  }

  whatsappAccountCapabilities(account: WhatsAppAccount | Record<string, unknown> | null): string[] {
    if (!account || !Array.isArray(account["capabilities"])) return [];
    return (account["capabilities"] as unknown[])
      .map((capability) => String(capability || "").trim().toLowerCase())
      .filter(Boolean);
  }

  whatsappAccountCanSend(account: WhatsAppAccount | Record<string, unknown> | null): boolean {
    const capabilities = this.whatsappAccountCapabilities(account);
    return capabilities.length === 0 || capabilities.includes("send");
  }

  whatsappAccountById(accountId: string): WhatsAppAccount | null {
    const id = String(accountId || "").trim();
    const numeric = this.whatsappNumericIdentity(id);
    return this.whatsappAccounts().find((account) => {
      const keys = this.whatsappAccountLookupIds(account);
      return keys.some((key) => key.toLowerCase() === id.toLowerCase() || (!!numeric && this.whatsappNumericIdentity(key) === numeric));
    }) || null;
  }

  defaultWhatsAppReplyAccountId(): string {
    const accounts = this.connectedWhatsAppAccounts();
    const responder = accounts.find((account) => this.whatsappRelayTargetAccountId(account) && this.whatsappAccountCanSend(account)) ||
      accounts.find((account) => this.whatsappAccountConnected(account) && this.whatsappAccountCanSend(account)) ||
      accounts[0] ||
      null;
    return this.whatsappAccountId(responder);
  }

  defaultWhatsAppResponderAccountId(): string {
    return this.defaultWhatsAppReplyAccountId();
  }

  selectedWhatsAppAccountId(): string {
    const accounts = this.connectedWhatsAppAccounts();
    const selected = this.whatsappOutboundAccountId.trim();
    const selectedAccount = selected ? this.whatsappAccountById(selected) : null;
    if (selectedAccount && accounts.includes(selectedAccount)) return this.whatsappAccountId(selectedAccount);
    return this.defaultWhatsAppReplyAccountId();
  }

  selectedWhatsAppSenderAccountId(): string {
    const accounts = this.connectedWhatsAppAccounts();
    const selected = this.whatsappSenderAccountId.trim();
    const selectedAccount = selected ? this.whatsappAccountById(selected) : null;
    if (selectedAccount && accounts.includes(selectedAccount)) return this.whatsappAccountId(selectedAccount);
    const responderId = this.selectedWhatsAppAccountId();
    const responder = this.whatsappAccountById(responderId);
    const relayTarget = this.whatsappRelayTargetAccountId(responder);
    const relayTargetAccount = relayTarget ? this.whatsappAccountById(relayTarget) : null;
    if (relayTargetAccount && accounts.includes(relayTargetAccount)) return this.whatsappAccountId(relayTargetAccount);
    const otherReady = accounts.find((account) => this.whatsappAccountId(account) !== responderId && this.whatsappAccountConnected(account));
    if (otherReady) return this.whatsappAccountId(otherReady);
    return responderId;
  }

  selectedWhatsAppReplyAccountId(): string {
    return this.selectedWhatsAppAccountId();
  }

  selectedWhatsAppInboundAccountId(): string {
    return this.selectedWhatsAppSenderAccountId();
  }

  selectedWhatsAppAccount(): WhatsAppAccount | null {
    const selected = this.selectedWhatsAppAccountId();
    const account = this.whatsappAccountById(selected);
    return account && this.connectedWhatsAppAccounts().includes(account) ? account : null;
  }

  selectedWhatsAppSenderAccount(): WhatsAppAccount | null {
    const selected = this.selectedWhatsAppSenderAccountId();
    const account = this.whatsappAccountById(selected);
    return account && this.connectedWhatsAppAccounts().includes(account) ? account : null;
  }

  selectedWhatsAppAccountLabel(): string {
    const account = this.selectedWhatsAppAccount();
    return account ? this.whatsappAccountLabel(account) || this.selectedWhatsAppAccountId() : "No connected account";
  }

  selectedWhatsAppSenderAccountLabel(): string {
    const account = this.selectedWhatsAppSenderAccount();
    return account ? this.whatsappAccountLabel(account) || this.selectedWhatsAppSenderAccountId() : "No connected account";
  }

  selectedWhatsAppReplyAccountLabel(): string {
    return this.selectedWhatsAppAccountLabel();
  }

  selectedWhatsAppInboundAccountLabel(): string {
    return this.selectedWhatsAppSenderAccountLabel();
  }

  selectedWhatsAppAccountStateLabel(): string {
    const account = this.selectedWhatsAppAccount();
    const state = account ? this.whatsappAccountState(account) : "";
    return state || "setup required";
  }

  selectedWhatsAppSenderAccountStateLabel(): string {
    const account = this.selectedWhatsAppSenderAccount();
    const state = account ? this.whatsappAccountState(account) : "";
    return state || "setup required";
  }

  selectedWhatsAppReplyAccountStateLabel(): string {
    return this.selectedWhatsAppAccountStateLabel();
  }

  selectedWhatsAppInboundAccountStateLabel(): string {
    return this.selectedWhatsAppSenderAccountStateLabel();
  }

  whatsappAccountQrUrl(): string {
    const selected = this.selectedWhatsAppAccountId();
    const account = this.whatsappAccountById(selected);
    return String(account?.qrUrl || this.whatsappStatusDetails?.qrUrl || "").trim();
  }

  whatsappChatLabelFor(chat: WhatsAppChat): string {
    const name = String(chat.name || chat.id || "").trim();
    return `${name}${chat.isGroup ? " · group" : ""}`;
  }

  whatsappParticipantLabel(participant: WhatsAppParticipant): string {
    const name = this.whatsappParticipantName(participant);
    const number = this.whatsappParticipantNumber(participant);
    const id = this.whatsappParticipantId(participant);
    return name ? `${name} · ${number || id}` : number || id;
  }

  whatsappParticipantId(participant: WhatsAppParticipant | string): string {
    return String(typeof participant === "string" ? participant : participant.id || "").trim();
  }

  whatsappParticipantName(participant: WhatsAppParticipant | string): string {
    const id = this.whatsappParticipantId(participant);
    const data = typeof participant === "string" ? null : participant;
    return String(
      data?.name ||
      data?.["savedName"] ||
      data?.["contactName"] ||
      data?.["displayName"] ||
      data?.["notifyName"] ||
      data?.["pushname"] ||
      data?.["shortName"] ||
      this.whatsappParticipantSavedLabel(id) ||
      "",
    ).trim();
  }

  whatsappParticipantNumber(participant: WhatsAppParticipant | string): string {
    const id = this.whatsappParticipantId(participant);
    const user = id.split("@")[0].replace(/[^\d+]/g, "");
    if (!user) return id;
    return user.startsWith("+") ? user : `+${user}`;
  }

  whatsappSelectableParticipants(thread: ThreadSummary | null = this.selectedThread()): WhatsAppParticipant[] {
    const systemIds = this.whatsappSystemParticipantIds(thread);
    return this.whatsappParticipants.filter((participant) => {
      const id = this.whatsappParticipantId(participant).toLowerCase();
      return id && !systemIds.has(id);
    });
  }

  whatsappParticipantChecked(participant: WhatsAppParticipant | string): boolean {
    const id = this.whatsappParticipantId(participant).toLowerCase();
    return Boolean(id && this.whatsappAdditionalParticipantIds.some((value) => value.toLowerCase() === id));
  }

  whatsappSavedAdditionalParticipants(thread: ThreadSummary | null = this.selectedThread()): string[] {
    const visible = new Set(this.whatsappSelectableParticipants(thread).map((participant) => this.whatsappParticipantId(participant).toLowerCase()).filter(Boolean));
    return this.whatsappSelectedAdditionalParticipantIds(thread).filter((id) => id && !visible.has(id.toLowerCase()));
  }

  whatsappAdditionalParticipantCount(thread: ThreadSummary | null = this.selectedThread()): number {
    return this.whatsappAllowOtherPeople ? this.whatsappSelectedAdditionalParticipantIds(thread).length : 0;
  }

  whatsappChatConnected(thread: ThreadSummary | null): boolean {
    return Boolean(String(thread?.binding?.chatId || "").trim());
  }

  private redirectThreadSettingsToWhatsAppSetupIfNeeded(thread: ThreadSummary | null): boolean {
    if (this.activePanel !== "settings" || this.onboardingActive || !thread || !this.whatsappStatusDetails) return false;
    if (this.whatsappChatConnected(thread) || this.hasConnectedWhatsAppAccounts()) return false;
    this.openSetup("whatsapp", true);
    return true;
  }

  canLoadLocalWhatsAppChats(accountId = this.selectedWhatsAppReplyAccountId()): boolean {
    const mode = String(this.whatsappStatusDetails?.mode || "local").toLowerCase();
    const bridgeUrl = String(this.whatsappStatusDetails?.bridgeUrl || "").trim();
    const account = this.whatsappAccountById(accountId);
    const runtimeAccountId = String(account?.runtimeAccountId || "").trim();
    return mode === "local" &&
      (!bridgeUrl || bridgeUrl.startsWith("/api/connectors/whatsapp/bridge")) &&
      Boolean(accountId) &&
      (/^account-\d+$/i.test(accountId) || /^account-\d+$/i.test(runtimeAccountId));
  }

  threadDeleteConfirmMatches(thread: ThreadSummary | null): boolean {
    if (!thread) return false;
    const confirm = this.deleteThreadConfirm.trim();
    return Boolean(confirm && (confirm === this.threadTitle(thread) || confirm === thread.id));
  }

  whatsappChatLabel(thread: ThreadSummary | null): string {
    const binding = thread?.binding;
    const chatId = String(binding?.chatId || "").trim();
    if (!chatId) return "No WhatsApp chat connected";
    return String(binding?.displayName || chatId).trim();
  }

  whatsappChatDetail(thread: ThreadSummary | null): string {
    const binding = thread?.binding;
    const isDraft = Boolean(thread && this.whatsappBindingThreadId === thread.id);
    const chatId = isDraft ? this.whatsappChatId.trim() : String(binding?.chatId || "").trim();
    if (!chatId) return "No WhatsApp chat selected";
    const state = (isDraft ? this.whatsappBindingEnabled : binding?.enabled !== false) ? "inbound on" : "inbound off";
    const mirror = (isDraft ? this.whatsappMirrorToWhatsApp : binding?.mirrorToWhatsApp !== false) ? "WA mirror on" : "WA mirror off";
    return `${chatId} · ${state} · ${mirror}`;
  }

  whatsappDeliveryLabel(thread: ThreadSummary | null): string {
    if (!thread) return "No thread";
    const binding = thread.binding || {};
    const isDraft = this.whatsappBindingThreadId === thread.id;
    const chatId = isDraft ? this.whatsappChatId.trim() : String(binding.chatId || "").trim();
    if (!chatId) return "No chat selected";
    const inbound = isDraft ? this.whatsappBindingEnabled : binding.enabled !== false;
    const mirror = isDraft ? this.whatsappMirrorToWhatsApp : binding.mirrorToWhatsApp !== false;
    if (inbound && mirror) return "Inbound and replies";
    if (inbound) return "Inbound only";
    if (mirror) return "Replies only";
    return "Off";
  }

  whatsappPeopleLabel(thread: ThreadSummary | null): string {
    if (!thread) return "No thread";
    const binding = thread.binding || {};
    const allowPeople = this.whatsappBindingThreadId === thread.id
      ? this.whatsappAllowOtherPeople
      : binding.additionalParticipantsEnabled === true;
    return allowPeople ? "Additional participants enabled" : "Only the saved owner contact";
  }

  whatsappOwnerContactLabel(thread: ThreadSummary | null): string {
    const binding = thread?.binding || {};
    const extra = binding as Record<string, unknown>;
    const contact = String(
      binding.senderContactId ||
      extra["ownerContactId"] ||
      extra["authorizedContactId"] ||
      "",
    ).trim();
    if (contact) return this.whatsappParticipantName(contact) || this.whatsappParticipantNumber(contact) || contact;
    return this.selectedWhatsAppInboundAccountLabel();
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

  threadAvatarUrl(thread: ThreadSummary | null): string {
    return this.whatsappAvatarUrl(thread);
  }

  whatsappAvatarLines(thread: ThreadSummary | null): string[] {
    const title = this.whatsappChatLabel(thread) || (thread ? this.threadTitle(thread) : "WhatsApp");
    return this.chatIconLines(title);
  }

  threadAvatarLines(thread: ThreadSummary | null): string[] {
    const title = thread && this.showWhatsAppChatIcon(thread)
      ? this.whatsappChatLabel(thread) || this.threadTitle(thread)
      : thread ? this.threadTitle(thread) : "Orkestr";
    return this.chatIconLines(title);
  }

  isWhatsAppAvatarPrimaryLine(line: string): boolean {
    return /^W\d+$/i.test(String(line || "").trim());
  }

  isThreadAvatarPrimaryLine(line: string): boolean {
    return this.isWhatsAppAvatarPrimaryLine(line);
  }

  whatsappChatIconTitle(thread: ThreadSummary | null): string {
    const label = this.whatsappChatLabel(thread);
    const binding = thread?.binding;
    const chatId = String(binding?.chatId || "").toLowerCase();
    const groupSuffix = binding?.additionalParticipantsEnabled === true || chatId.includes("@g.us") || chatId.includes("g.us") ? " · group" : "";
    return `${label} · WhatsApp chat${groupSuffix}`;
  }

  threadIconTitle(thread: ThreadSummary | null): string {
    if (this.showWhatsAppChatIcon(thread)) return this.whatsappChatIconTitle(thread);
    return `${thread ? this.threadTitle(thread) : "Thread"} · Orkestr thread`;
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

  statusLabel(thread: ThreadSummary, includeFamily = false): string {
    if (this.isThreadLatestMessageFailed(thread, includeFamily)) return "Error";
    if (this.threadProgressStateHint(thread) === "error") return "Error";
    if (this.isThreadProcessing(thread)) return this.threadProcessingLabel(thread);
    const state = String(thread.publicStatus || thread.status || thread.state || "unknown");
    if (state === "ready") return "Ready";
    if (state === "sleeping") return "Sleeping";
    if (state === "working") return thread.backgroundWork ? "Background" : "Working";
    return state.replace(/_/g, " ");
  }

  statusClass(thread: ThreadSummary, includeFamily = false): string {
    if (this.isThreadLatestMessageFailed(thread, includeFamily)) return "bad";
    if (this.threadProgressStateHint(thread) === "error") return "bad";
    if (this.isThreadProcessing(thread)) return "hot";
    const state = String(thread.publicStatusCode || thread.status || thread.state || "").toLowerCase();
    if (state.includes("broken") || state.includes("failed")) return "bad";
    if (state.includes("stuck") || state.includes("working") || state.includes("running") || state.includes("approval")) return "hot";
    if (state.includes("ready")) return "ready";
    if (state.includes("sleep")) return "sleep";
    return "idle";
  }

  isThreadProcessing(thread: ThreadSummary | null): boolean {
    if (!thread) return false;
    if (thread.turnLifecycle?.sidebarWorking === true) return true;
    if (thread.turnLifecycle?.terminal === true && !thread.working && !thread.typingActive) return false;
    const activeCount = Number(thread.pendingCount || 0) + Number(thread.runningCount || 0);
    const progressState = this.threadProgressStateHint(thread);
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
      progressState === "working" ||
      progressState === "planning" ||
      progressState === "awaiting_approval" ||
      progressState === "awaiting_input" ||
      /(?:working|running|processing|waking|pending|approval)/.test(state),
    );
  }

  threadProgressStateHint(thread: ThreadSummary | null): string {
    return String(thread?.progressStateHint || thread?.progress?.stateHint || "").trim().toLowerCase();
  }

  threadProgressSummary(thread: ThreadSummary | null): string {
    const summary = String(thread?.progressSummary || thread?.progress?.summary || "").trim();
    return summary && summary !== "Ready" ? summary : "";
  }

  threadProgressTailLines(thread: ThreadSummary | null): string[] {
    const lines = Array.isArray(thread?.progressTailLines)
      ? thread?.progressTailLines
      : Array.isArray(thread?.progress?.tailLines) ? thread?.progress?.tailLines : [];
    return lines.map((line) => String(line || "").trim()).filter(Boolean).slice(-12);
  }

  threadProcessingLabel(thread: ThreadSummary | null): string {
    if (!thread) return "Working";
    if (this.threadLoading(thread)) return "Loading";
    const lifecycleState = String(thread.turnLifecycle?.state || "").toLowerCase();
    if (thread.turnLifecycle?.awaitingApproval) return "Waiting for approval";
    if (lifecycleState === "queued") return "Queued";
    if (lifecycleState === "waking") return "Starting";
    if (lifecycleState === "planning") return "Planning";
    if (lifecycleState === "running") return "Working";
    const progressState = this.threadProgressStateHint(thread);
    const progressSummary = this.threadProgressSummary(thread);
    if (progressState === "error") return "Error";
    if (progressState === "awaiting_input") return progressSummary || "Waiting for input";
    if (progressState === "planning") return progressSummary || "Planning";
    if (progressState === "working") return progressSummary || "Working";
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
    if (label === "Waiting for approval") return "Approval";
    if (label === "Planning" || label === "Implement plan?") return "Plan";
    if (label === "Waiting for input") return "Input";
    if (label === "Error") return "Error";
    return "Working";
  }

  threadProcessingTitle(thread: ThreadSummary | null): string {
    const tailLines = this.threadProgressTailLines(thread);
    return tailLines.length ? tailLines.join("\n") : this.threadProcessingLabel(thread);
  }

  threadRuntimeMode(thread: ThreadSummary | null): string {
    const mode = String(thread?.runtimeMode || this.objectValue(thread?.runtime, "runtimeMode") || "").trim().toLowerCase();
    if (mode) return mode;
    const runtimeKind = String(thread?.runtimeKind || this.objectValue(thread?.runtime, "runtimeKind") || "").trim().toLowerCase();
    if (runtimeKind === "codex-app-server" || runtimeKind === "app-server") return "codex-api";
    if (runtimeKind === "raw-terminal") return "attached-terminal";
    if (runtimeKind === "api-agent") return "agent";
    if (runtimeKind === "codex-tmux" || runtimeKind === "migration_required") return "codex-tmux";
    if (thread?.paneId || thread?.tmuxTarget) return "codex-tmux";
    return "";
  }

  threadRuntimeModeLabel(thread: ThreadSummary | null): string {
    const explicit = String(thread?.runtimeModeLabel || this.objectValue(thread?.runtime, "runtimeModeLabel") || "").trim();
    if (explicit) return explicit;
    const mode = this.threadRuntimeMode(thread);
    if (mode === "codex-api") return "Codex API";
    if (mode === "codex-tmux") return "Codex tmux";
    if (mode === "attached-terminal") return "Attached terminal";
    if (mode === "agent") return "Agent";
    if (mode === "sleeping") return "Sleeping";
    return "";
  }

  threadRuntimeModeShortLabel(thread: ThreadSummary | null): string {
    const mode = this.threadRuntimeMode(thread);
    if (mode === "codex-api") return "API";
    if (mode === "codex-tmux") return "TMUX";
    if (mode === "attached-terminal") return "TERM";
    if (mode === "agent") return "AGENT";
    return "";
  }

  threadRuntimeModeTitle(thread: ThreadSummary | null): string {
    const label = this.threadRuntimeModeLabel(thread);
    if (!label) return "";
    const details = [
      `Mode: ${label}`,
      String(thread?.runtimeTransport || this.objectValue(thread?.runtime, "runtimeTransport") || "").trim() ? `Transport: ${thread?.runtimeTransport || this.objectValue(thread?.runtime, "runtimeTransport")}` : "",
      String(thread?.runtimeControlPath || this.objectValue(thread?.runtime, "runtimeControlPath") || "").trim() ? `Control: ${thread?.runtimeControlPath || this.objectValue(thread?.runtime, "runtimeControlPath")}` : "",
      String(thread?.sessionName || this.objectValue(thread?.runtime, "sessionName") || "").trim() ? `Session: ${thread?.sessionName || this.objectValue(thread?.runtime, "sessionName")}` : "",
      String(thread?.paneId || thread?.tmuxTarget || this.objectValue(thread?.runtime, "paneId") || "").trim() ? `Pane: ${thread?.paneId || thread?.tmuxTarget || this.objectValue(thread?.runtime, "paneId")}` : "",
    ].filter(Boolean);
    return details.join("\n");
  }

  deploymentVersionLabel(): string {
    const version = this.versionInfo;
    if (!version) return "";
    const semanticVersion = String(version.releaseVersion || version.version || "").trim();
    const label = String(version.releaseLabel || version.tag || (semanticVersion ? `v${semanticVersion}` : "") || version.releaseId || version.describe || "").trim();
    if (!label) return "";
    return label.length > 28 ? `${label.slice(0, 25)}...` : label;
  }

  deploymentTrackLabel(): string {
    const version = this.versionInfo;
    if (!version) return "";
    const distribution = version.distribution || {};
    return String(
      version.distributionKind ||
      distribution.kind ||
      version.repoRole ||
      distribution.repoRole ||
      version.deploymentTrack ||
      distribution.track ||
      version.channel ||
      "runtime"
    ).trim();
  }

  deploymentVersionTitle(): string {
    const version = this.versionInfo;
    if (!version) return "";
    const distribution = version.distribution || {};
    const details = [
      String(version.name || "").trim() ? `Name: ${version.name}` : "",
      this.deploymentVersionLabel() ? `Release: ${String(version.releaseLabel || version.tag || version.releaseVersion || version.version || "").trim()}` : "",
      String(version.releaseId || "").trim() ? `Build: ${version.buildId || version.releaseId}` : "",
      String(version.version || "").trim() ? `Version: ${version.version}` : "",
      String(version.commit || "").trim() ? `Commit: ${version.commit}` : "",
      String(version.branch || "").trim() ? `Branch: ${version.branch}` : "",
      String(version.channel || "").trim() ? `Channel: ${version.channel}` : "",
      String(version.distributionKind || distribution.kind || "").trim() ? `Kind: ${version.distributionKind || distribution.kind}` : "",
      String(version.deploymentTrack || distribution.track || "").trim() ? `Track: ${version.deploymentTrack || distribution.track}` : "",
      String(version.repoRole || distribution.repoRole || "").trim() ? `Repo: ${version.repoRole || distribution.repoRole}` : "",
      String(version.deployedAt || "").trim() ? `Deployed: ${version.deployedAt}` : "",
      String(version.generatedAt || "").trim() ? `Checked: ${version.generatedAt}` : "",
    ].filter(Boolean);
    return details.join("\n");
  }

  codexModeShortcutTitle(thread: ThreadSummary | null): string {
    const details = [
      "Live Codex mode for this Orkestr thread",
      "Shortcuts: /code, /plan",
      this.threadRuntimeModeLabel(thread) ? `Runtime: ${this.threadRuntimeModeLabel(thread)}` : "",
    ].filter(Boolean);
    return details.join("\n");
  }

  canWakeThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    return state.includes("sleep") || state.includes("hibernat");
  }

  canSleepThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    const leaseId = String(thread.activeRuntimeLeaseId || "");
    const reason = String(this.leaseValue("reason") || this.objectValue(thread["runtime"], "reason"));
    if (thread.isCodexAppServer || this.threadRuntimeMode(thread) === "codex-api") {
      return false;
    }
    if (!thread.activeRuntimeLeaseId && !thread.sessionName) return false;
    if (leaseId.startsWith("adopt-") || reason.includes("adopt_existing")) return false;
    return state.includes("ready");
  }

  canRecoverThread(thread: ThreadSummary): boolean {
    const state = this.threadState(thread);
    return state.includes("broken") || state.includes("failed") || Boolean(thread["lastError"]);
  }

  pendingApprovalRequest(thread: ThreadSummary | null = this.selectedThread()): Record<string, unknown> | null {
    const candidates = [
      this.pathValue(thread, "runtime.pendingRequest"),
      this.pathValue(thread, "pendingRequest"),
      this.pathValue(this.runtimeDetails, "runtime.pendingRequest"),
      this.pathValue(this.runtimeDetails, "pendingRequest"),
    ];
    return candidates.find((candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate === "object") || null;
  }

  hasActionablePendingApproval(thread: ThreadSummary | null = this.selectedThread()): boolean {
    if (!this.pendingApprovalRequest(thread)) return false;
    const runtimeState = [
      thread?.state,
      thread?.status,
      thread?.turnLifecycle?.state,
      this.objectValue(thread?.runtime, "state"),
      this.objectValue(thread?.runtime, "status"),
      this.objectValue(this.runtimeDetails?.["runtime"], "state"),
      this.objectValue(this.runtimeDetails?.["runtime"], "status"),
    ].map((value) => String(value || "").trim().toLowerCase());
    const codexStatus = (thread?.codexStatus || this.pathValue(thread, "runtime.codexStatus") || this.pathValue(this.runtimeDetails, "runtime.codexStatus")) as Record<string, unknown> | null;
    const flags = Array.isArray(codexStatus?.["activeFlags"]) ? codexStatus["activeFlags"].map((flag) => String(flag || "")) : [];
    return runtimeState.includes("awaiting_approval") ||
      thread?.turnLifecycle?.awaitingApproval === true ||
      flags.includes("waitingOnApproval");
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

  hasUnreadThreads(): boolean {
    return this.threads.some((thread) => this.isThreadUnread(thread));
  }

  markAllThreadsRead(): void {
    const storage = this.readStateStorage();
    if (!storage) return;
    for (const thread of this.threads) {
      storage.setItem(this.threadReadKey(thread.id), String(this.activityMs(thread)));
    }
    this.renderNow();
  }

  isThreadUnreadAssistantFinal(thread: ThreadSummary, includeFamily = false): boolean {
    const unreadThread = this.latestUnreadThread(thread, includeFamily);
    if (!unreadThread) return false;
    const messageMs = this.latestThreadMessageMs(unreadThread);
    if (!messageMs || messageMs <= this.threadReadMs(unreadThread)) return false;
    return this.latestThreadMessageIsFinalAssistant(unreadThread);
  }

  threadUnreadDotTitle(thread: ThreadSummary, includeFamily = false): string {
    return this.isThreadUnreadAssistantFinal(thread, includeFamily) ? "New assistant answer" : "New activity";
  }

  threadUnreadBadgeLabel(thread: ThreadSummary, includeFamily = false): string {
    return this.isThreadUnreadAssistantFinal(thread, includeFamily) ? "ANSWER" : "UPDATES";
  }

  isThreadLatestMessageFailed(thread: ThreadSummary | null, includeFamily = false): boolean {
    const latest = this.latestMessageThread(thread, includeFamily);
    return latest ? this.threadOwnLatestMessageFailed(latest) : false;
  }

  threadFailureTitle(thread: ThreadSummary | null, includeFamily = false): string {
    const latest = this.latestMessageThread(thread, includeFamily);
    if (!latest || !this.threadOwnLatestMessageFailed(latest)) return "";
    return this.threadLatestMessageError(latest) || "Last message was not delivered.";
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
    return this.pathForPanel(this.threadSlug(thread), "chat");
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

  messageDeliveryStateLabel(message: ThreadMessage): string {
    const state = String(message.deliveryState || message.state || "").trim();
    if (state === "failed") return "Delivery failed";
    return state.replace(/_/g, " ");
  }

  messageFailureDetail(message: ThreadMessage): string {
    if (String(message.state || "").toLowerCase() !== "failed") return "";
    return String(message.error || "Orkestr could not confirm this message reached Codex.").trim();
  }

  messagePhase(message: ThreadMessage | null): string {
    const role = String(message?.role || "").trim().toLowerCase();
    const phase = String(message?.phase || "").trim().toLowerCase();
    if (role === "assistant" && phase !== "plan" && hasProposedPlanEnvelope(message?.text)) return "plan";
    return phase;
  }

  private latestUnreadThread(thread: ThreadSummary, includeFamily: boolean): ThreadSummary | null {
    const candidates = includeFamily ? [thread, ...this.childWorkers(thread)] : [thread];
    return candidates
      .filter((candidate) => this.isThreadUnread(candidate))
      .sort((a, b) => this.activityMs(b) - this.activityMs(a))[0] || null;
  }

  private latestMessageThread(thread: ThreadSummary | null, includeFamily: boolean): ThreadSummary | null {
    if (!thread) return null;
    const candidates = includeFamily ? [thread, ...this.childWorkers(thread)] : [thread];
    return candidates
      .filter((candidate) => this.latestThreadMessageMs(candidate) > 0)
      .sort((a, b) => this.latestThreadMessageMs(b) - this.latestThreadMessageMs(a))[0] || thread;
  }

  private latestCachedThreadMessage(thread: ThreadSummary): ThreadMessage | null {
    return (this.messageCache()[thread.id] || []).at(-1) || null;
  }

  private latestCachedThreadMessageIsCurrent(thread: ThreadSummary, message: ThreadMessage | null): boolean {
    if (!message) return false;
    const cachedMs = Date.parse(String(message.timestamp || message.createdAt || ""));
    const summaryMs = Date.parse(String(thread.lastMessageAt || ""));
    if (!Number.isFinite(summaryMs)) return true;
    if (!Number.isFinite(cachedMs)) return false;
    return cachedMs >= summaryMs;
  }

  private latestThreadMessageMs(thread: ThreadSummary): number {
    const message = this.latestCachedThreadMessage(thread);
    const value = this.latestCachedThreadMessageIsCurrent(thread, message)
      ? message?.timestamp || message?.createdAt || thread.lastMessageAt || ""
      : thread.lastMessageAt || "";
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : 0;
  }

  private threadOwnLatestMessageFailed(thread: ThreadSummary): boolean {
    const message = this.latestCachedThreadMessage(thread);
    if (this.latestCachedThreadMessageIsCurrent(thread, message)) {
      return String(message?.state || "").toLowerCase() === "failed" ||
        (this.messagePhase(message) === "runtime_interrupted" && !thread.lastMessageRecovered);
    }
    return String(thread.lastMessageState || "").toLowerCase() === "failed" ||
      String(thread.lastMessageDeliveryState || "").toLowerCase() === "failed" ||
      (String(thread.lastMessagePhase || "").toLowerCase() === "runtime_interrupted" && !thread.lastMessageRecovered);
  }

  private threadLatestMessageError(thread: ThreadSummary): string {
    const message = this.latestCachedThreadMessage(thread);
    if (this.latestCachedThreadMessageIsCurrent(thread, message)) {
      return String(message?.error || "").trim() || (message && this.messagePhase(message) === "runtime_interrupted" && !thread.lastMessageRecovered ? this.messageText(message) : "");
    }
    return String(thread.lastMessageError || "").trim() ||
      (String(thread.lastMessagePhase || "").toLowerCase() === "runtime_interrupted" && !thread.lastMessageRecovered ? "Codex conversation was interrupted." : "");
  }

  private latestThreadMessageIsFinalAssistant(thread: ThreadSummary): boolean {
    const message = this.latestCachedThreadMessage(thread);
    const currentMessage = this.latestCachedThreadMessageIsCurrent(thread, message) ? message : null;
    const role = String(currentMessage?.role || thread.lastMessageRole || "").trim().toLowerCase();
    const phase = String(currentMessage?.phase || thread.lastMessagePhase || (role === "assistant" ? "final_answer" : "")).trim().toLowerCase();
    return this.isFinalAssistantRolePhase(role, phase);
  }

  private isFinalAssistantRolePhase(role: string, phase: string): boolean {
    const normalizedRole = String(role || "").trim().toLowerCase();
    const normalizedPhase = String(phase || "").trim().toLowerCase();
    return normalizedRole === "assistant" && (!normalizedPhase || normalizedPhase === "final_answer" || normalizedPhase === "final");
  }

  isFinalAssistantMessage(message: ThreadMessage | null): boolean {
    return this.isFinalAssistantRolePhase(String(message?.role || ""), this.messagePhase(message));
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

  debugModelLabel(thread: ThreadSummary | null): string {
    const model = this.codexModelName(thread).replace(/^Syncing model$/i, "unknown");
    const effort = this.shortReasoningEffort(thread);
    return effort ? `${model}/${effort}` : model;
  }

  debugMessageLabel(thread: ThreadSummary | null): string {
    const message = thread ? this.latestCachedThreadMessage(thread) : null;
    const role = String(message?.role || thread?.lastMessageRole || "").trim().toLowerCase();
    const phase = String(this.messagePhase(message) || thread?.lastMessagePhase || "").trim().toLowerCase();
    if (role === "user") return "user";
    if (!phase || phase === "final_answer" || phase === "final") return "final";
    if (phase === "commentary") return "info";
    return phase.replace(/_/g, "-");
  }

  debugQueueCount(thread: ThreadSummary | null): number {
    if (!thread) return 0;
    return Math.max(0, Number(thread.pendingCount || 0) + Number(thread.awaitingAckCount || 0));
  }

  debugCpuLabel(): string {
    const value = this.systemCpuPercent();
    return Number.isFinite(value) && value > 0 ? `${Math.round(value)}%` : "--";
  }

  private shortReasoningEffort(thread: ThreadSummary | null): string {
    const effort = this.codexReasoningEffortLabel(thread).toLowerCase();
    if (!effort || effort === "default") return "";
    if (effort === "xhigh") return "xh";
    if (effort === "high") return "h";
    if (effort === "medium") return "m";
    if (effort === "low") return "l";
    return effort;
  }

  attachmentLabel(attachment: Record<string, unknown>): string {
    return String(attachment["name"] || attachment["filename"] || attachment["path"] || attachment["saved_path"] || "attachment");
  }

  composerRows(): number {
    return Math.max(2, Math.min(10, this.draft.split("\n").length));
  }

  slashCommandAliasLabel(command: SlashCommandInfo): string {
    return command.aliases.length ? command.aliases.join(", ") : "";
  }

  slashCommandUsage(command: SlashCommandInfo): string {
    return command.acceptsText ? `${command.command} message` : command.command;
  }

  openSlashHelp(): void {
    this.modelDetailsOpen = false;
    this.gitDetailsThreadId = "";
    this.slashHelpOpen = true;
    this.renderNow();
  }

  closeSlashHelp(): void {
    if (!this.slashHelpOpen) return;
    this.slashHelpOpen = false;
    this.renderNow();
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
    return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
  }

  formatUsd(value: unknown): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "--";
    if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
    return `$${amount.toFixed(2)}`;
  }

  creditBudgetLabel(usage: CreditUsageSummary | null = this.creditUsage): string {
    if (!usage?.budget) return "No budget configured";
    const daily = usage.budget.dailyUsd === null || usage.budget.dailyUsd === undefined ? "" : `daily ${this.formatUsd(usage.budget.dailyUsd)}`;
    const monthly = usage.budget.monthlyUsd === null || usage.budget.monthlyUsd === undefined ? "" : `monthly ${this.formatUsd(usage.budget.monthlyUsd)}`;
    return [daily, monthly].filter(Boolean).join(" · ") || "No budget configured";
  }

  creditUsageModelRows(usage: CreditUsageSummary | null = this.creditUsage): Array<{ model: string; cost: number }> {
    return Object.entries(usage?.byModel || {})
      .map(([model, cost]) => ({ model, cost: Number(cost || 0) }))
      .sort((left, right) => right.cost - left.cost)
      .slice(0, 5);
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
    const modeValue = (value: unknown): string => {
      const mode = String(value || "").trim().toLowerCase();
      return mode === "plan" || mode === "code" ? mode : "";
    };
    return modeValue(thread?.codexModeLive) || modeValue(thread?.codexMode);
  }

  showPlanComposerBanner(thread: ThreadSummary | null): boolean {
    return Boolean(thread && this.codexModeValue(thread) === "plan");
  }

  planComposerHint(_thread: ThreadSummary | null): string {
    return "Use /code to switch to coding.";
  }

  composerPlaceholder(thread: ThreadSummary | null): string {
    if (thread && !this.threadInputReady()) return "Connect Codex Agent to send tasks";
    return thread ? `Message ${this.threadTitle(thread)}` : "Message";
  }

  codexModelName(thread: ThreadSummary | null): string {
    return String(
      thread?.codexModel ||
      this.objectValue(thread?.runtime, "codexModel") ||
      this.objectValue(thread?.["executor"], "codexModel") ||
      "Syncing model",
    );
  }

  codexReasoningEffortLabel(thread: ThreadSummary | null): string {
    if (!thread) return "";
    return String(thread.codexReasoningEffort || "default").trim();
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
      `Reasoning: ${this.codexReasoningEffortLabel(thread) || "default"}`,
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

  tracePhaseLabel(value: unknown): string {
    return String(value || "unknown").replace(/_/g, " ");
  }

  traceTitle(trace: RouterTraceRecord): string {
    return String(trace.sourceEventId || trace.routerTraceId || "trace").trim();
  }

  traceStatusLabel(trace: RouterTraceRecord): string {
    if (trace.diagnostics?.stuck) return "stuck";
    if (trace.terminal) return trace.terminalState || "completed";
    return trace.currentPhase || "open";
  }

  traceRecovery(trace: RouterTraceRecord): string {
    return String(trace.diagnostics?.recovery || "").trim();
  }

  outboxJobTitle(job: WhatsAppOutboxJob): string {
    return String(job.sourceMessageId || job.id || "outbox job").trim();
  }

  outboxStateLabel(job: WhatsAppOutboxJob): string {
    return String(job.state || "pending").replace(/_/g, " ");
  }

  outboxJobMeta(job: WhatsAppOutboxJob): string {
    return [
      String(job.deliveryType || "delivery").trim(),
      String(job.accountId || "").trim() ? `acct ${job.accountId}` : "",
      String(job.chatId || "").trim() ? `chat ${job.chatId}` : "",
    ].filter(Boolean).join(" · ");
  }

  outboxUpdatedAt(job: WhatsAppOutboxJob): string {
    return String(job.updatedAt || job.terminalAt || job.createdAt || "").trim();
  }

  outboxJobActions(job: WhatsAppOutboxJob): string[] {
    const state = String(job.state || "pending").toLowerCase();
    if (state === "delivered") return ["replay"];
    if (["suppressed", "dead_letter", "skipped", "skipped_policy", "cancelled"].includes(state)) return ["retry", "replay", "mark-delivered"];
    if (state === "failed_retryable") return ["retry", "suppress", "mark-delivered", "dead-letter"];
    if (["pending", "claimed", "sent_to_broker"].includes(state)) return ["suppress", "mark-delivered", "dead-letter"];
    return ["retry", "suppress", "mark-delivered"];
  }

  outboxActionLabel(action: string): string {
    if (action === "mark-delivered") return "Mark delivered";
    if (action === "dead-letter") return "Dead-letter";
    return action.charAt(0).toUpperCase() + action.slice(1);
  }

  async applyOutboxAction(job: WhatsAppOutboxJob, action: string): Promise<void> {
    const jobId = String(job.id || "").trim();
    if (!jobId || this.deliveryOutboxBusyJobId) return;
    this.deliveryOutboxBusyJobId = jobId;
    try {
      await firstValueFrom(this.api.whatsappOutboxAction(jobId, action, { reason: `operator_${action.replace(/-/g, "_")}` }));
      await this.loadDeliveryTraces();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.deliveryOutboxBusyJobId = "";
      this.renderNow();
    }
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

  private emptyMessagePageState(): ThreadMessagePageState {
    return { oldestCursor: null, hasMoreBefore: false, loadingOlder: false };
  }

  private normalizedCursor(value: unknown): number | null {
    const cursor = Number(value || 0);
    return Number.isFinite(cursor) && cursor > 0 ? cursor : null;
  }

  private oldestMessageCursor(messages: ThreadMessage[]): number | null {
    const cursors = messages
      .map((message) => this.normalizedCursor(message.cursor))
      .filter((cursor): cursor is number => cursor !== null);
    return cursors.length ? Math.min(...cursors) : null;
  }

  private minCursor(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.min(left, right);
  }

  private threadMessagePageState(threadId: string): ThreadMessagePageState {
    return this.messagePageState()[threadId] || this.emptyMessagePageState();
  }

  private setThreadMessagesLoadingOlder(threadId: string, loadingOlder: boolean): void {
    this.messagePageState.update((pages) => ({
      ...pages,
      [threadId]: { ...(pages[threadId] || this.emptyMessagePageState()), loadingOlder },
    }));
  }

  private updateLatestThreadMessagePageState(threadId: string, payload: ThreadMessagesResponse): void {
    const current = this.threadMessagePageState(threadId);
    const incomingOldest = this.normalizedCursor(payload.oldestCursor);
    const oldestCursor = this.minCursor(current.oldestCursor, incomingOldest);
    let hasMoreBefore = payload.hasMoreBefore === true;
    if (current.oldestCursor !== null && incomingOldest !== null && current.oldestCursor < incomingOldest) {
      hasMoreBefore = current.hasMoreBefore;
    } else if (incomingOldest === null && current.oldestCursor !== null) {
      hasMoreBefore = current.hasMoreBefore;
    }
    this.messagePageState.update((pages) => ({
      ...pages,
      [threadId]: { oldestCursor, hasMoreBefore, loadingOlder: current.loadingOlder },
    }));
  }

  private updateOlderThreadMessagePageState(threadId: string, payload: ThreadMessagesResponse): void {
    const current = this.threadMessagePageState(threadId);
    const incomingOldest = this.normalizedCursor(payload.oldestCursor);
    const oldestCursor = this.minCursor(current.oldestCursor, incomingOldest);
    const hasMoreBefore = incomingOldest !== null && payload.hasMoreBefore === true;
    this.messagePageState.update((pages) => ({
      ...pages,
      [threadId]: { oldestCursor, hasMoreBefore, loadingOlder: false },
    }));
  }

  private async loadSelectedThread(forceBottom: boolean): Promise<void> {
    if (this.isRouteLevelUserPanel(this.activePanel)) return;
    const thread = this.selectedThread();
    if (!thread) return;
    const threadId = thread.id;
    const loadToken = this.beginThreadLoad(threadId);
    const wasNearBottom = this.isMessagePaneNearBottom();
    try {
      const payload = await firstValueFrom(this.api.threadMessages(threadId, { limit: MESSAGE_PAGE_LIMIT }));
      if (this.threadLoadTokens.get(threadId) !== loadToken) return;
      const previousMessages = this.messageCache()[threadId] || [];
      const nextMessages = mergeServerMessagesWithOptimistic(payload.messages || [], previousMessages);
      const previousSignature = previousMessages.map((message) => this.messageKey(message)).join("|");
      const signature = nextMessages.map((message) => this.messageKey(message)).join("|");
      const changed = signature !== previousSignature;
      this.messageCache.update((cache) => ({ ...cache, [threadId]: nextMessages }));
      this.updateLatestThreadMessagePageState(threadId, payload);
      const currentThread = this.selectedThread();
      if (currentThread?.id === threadId) this.markThreadRead(currentThread);
      if (forceBottom || (!previousSignature && nextMessages.length > 0) || (changed && wasNearBottom)) {
        this.queueMessagePaneScrollToBottom();
      }
      if (previousSignature && changed && nextMessages.length > 0) this.markThreadActive(threadId, 45_000);
      if (this.activePanel === "history") await this.loadHistory();
      if (this.activePanel === "delivery") await this.loadDeliveryTraces();
      if (this.activePanel === "timers") await this.loadTimers();
      if (this.activePanel === "runtime") await this.loadRuntime();
      if (this.activePanel === "raw") await this.loadRaw();
    } finally {
      this.finishThreadLoad(threadId, loadToken);
    }
    this.renderNow();
  }

  async loadOlderMessages(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    const threadId = thread.id;
    const page = this.threadMessagePageState(threadId);
    if (page.loadingOlder || !page.hasMoreBefore) return;
    const cachedMessages = this.messageCache()[threadId] || [];
    const oldestCursor = page.oldestCursor || this.oldestMessageCursor(cachedMessages);
    if (!oldestCursor) {
      this.messagePageState.update((pages) => ({
        ...pages,
        [threadId]: { ...page, hasMoreBefore: false, loadingOlder: false },
      }));
      this.renderNow();
      return;
    }
    const pane = this.messagePane?.nativeElement;
    const previousScrollHeight = pane?.scrollHeight || 0;
    const previousScrollTop = pane?.scrollTop || 0;
    this.setThreadMessagesLoadingOlder(threadId, true);
    this.renderNow();
    try {
      const payload = await firstValueFrom(this.api.threadMessages(threadId, { limit: MESSAGE_PAGE_LIMIT, before: oldestCursor }));
      const previousMessages = this.messageCache()[threadId] || [];
      const nextMessages = mergeServerMessagesWithOptimistic(payload.messages || [], previousMessages);
      this.messageCache.update((cache) => ({ ...cache, [threadId]: nextMessages }));
      this.updateOlderThreadMessagePageState(threadId, payload);
      this.renderNow();
      if (this.selectedThread()?.id === threadId && (payload.messages || []).length > 0) {
        this.restoreMessagePaneOffset(previousScrollHeight, previousScrollTop);
      }
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.setThreadMessagesLoadingOlder(threadId, false);
      this.renderNow();
    }
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

  private syncSignalStores(): void {
    this.threadStore.setThreads(this.threads);
    this.threadStore.selectThread(this.selectedId);
    this.threadStore.setMessagesByThread(this.messageCache());
    this.threadStore.setLoadingByThread(this.loadingThreadIds());
    this.connectorStore.setConnectors(this.setupStatus?.connectors || []);
    this.connectorStore.setWhatsAppStatus(this.whatsappStatusDetails);
    const active: Record<string, boolean> = {};
    const now = Date.now();
    for (const [threadId, until] of Object.entries(this.activeThreadIds())) {
      if (Number(until || 0) > now) active[threadId] = true;
    }
    this.runtimeStore.setWorkingThreads(active);
    const selected = this.selectedThread();
    if (selected?.id && this.runtimeDetails) {
      this.runtimeStore.setRuntime(selected.id, this.runtimeDetails);
    }
  }

  private renderNow(): void {
    this.syncSignalStores();
    this.cdr.detectChanges();
  }

  private replaceThread(updated: ThreadSummary): void {
    this.threads = this.threads
      .map((thread) => thread.id === updated.id ? { ...thread, ...updated } : thread)
      .sort((a, b) => this.activityMs(b) - this.activityMs(a));
  }

  private whatsappSystemParticipantIds(thread: ThreadSummary | null): Set<string> {
    const binding = thread?.binding || {};
    const ids = [
      binding.senderContactId,
      binding.responderContactId,
      this.whatsappAccountContactId(this.selectedWhatsAppInboundAccountId()),
      this.whatsappAccountContactId(this.selectedWhatsAppReplyAccountId()),
    ];
    return new Set(ids.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean));
  }

  private whatsappAccountContactId(accountId: string): string {
    const account = this.whatsappAccounts().find((item) => this.whatsappAccountId(item) === accountId);
    const raw = String(account?.["phoneNumber"] || account?.["phone"] || account?.["number"] || "").trim();
    const digits = raw.replace(/\D/g, "");
    return digits ? `${digits}@c.us` : "";
  }

  private whatsappParticipantSavedLabel(participantId: string): string {
    const exact = String(this.whatsappAdditionalParticipantLabels[participantId] || "").trim();
    if (exact) return exact;
    const match = Object.entries(this.whatsappAdditionalParticipantLabels)
      .find(([id]) => id.toLowerCase() === participantId.toLowerCase());
    return String(match?.[1] || "").trim();
  }

  private whatsappSelectedParticipantLabels(thread: ThreadSummary | null = this.selectedThread()): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const id of this.whatsappSelectedAdditionalParticipantIds(thread)) {
      const participant = this.whatsappParticipants.find((item) => this.whatsappParticipantId(item).toLowerCase() === id.toLowerCase());
      const label = participant ? this.whatsappParticipantName(participant) : String(this.whatsappAdditionalParticipantLabels[id] || "").trim();
      if (label) labels[id] = label;
    }
    return labels;
  }

  private whatsappSelectedAdditionalParticipantIds(thread: ThreadSummary | null = this.selectedThread()): string[] {
    const systemIds = this.whatsappSystemParticipantIds(thread);
    return this.whatsappAdditionalParticipantIds.filter((id) => id && !systemIds.has(id.toLowerCase()));
  }

  private mergeWhatsAppParticipantLabels(): void {
    const labels = { ...this.whatsappAdditionalParticipantLabels };
    for (const participant of this.whatsappParticipants) {
      const id = this.whatsappParticipantId(participant);
      const name = this.whatsappParticipantName(participant);
      if (id && name) labels[id] = name;
    }
    this.whatsappAdditionalParticipantLabels = labels;
  }

  private normalizeWhatsAppParticipantIds(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const id = String(value || "").trim();
      const comparable = id.toLowerCase();
      if (!id || seen.has(comparable)) continue;
      seen.add(comparable);
      result.push(id);
    }
    return result;
  }

  private sameWhatsAppParticipantIds(left: string[], right: string[]): boolean {
    const normalizedLeft = left.map((value) => value.toLowerCase()).sort();
    const normalizedRight = right.map((value) => value.toLowerCase()).sort();
    return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
  }

  private syncThreadMetaDraft(thread: ThreadSummary | null, force = false): void {
    if (!thread) return;
    if (!force && this.threadMetaThreadId === thread.id && this.threadMetaDirty(thread)) return;
    this.threadMetaThreadId = thread.id;
    this.threadRepoDraft = this.defaultRepoPath(thread);
    this.threadRemoteUrlDraft = this.threadRemoteUrl(thread);
    this.threadBranchDraft = this.threadBranchLabel(thread);
    this.threadRemoteBranchDraft = this.threadRemoteBranchLabel(thread);
    this.threadBaseBranchDraft = this.threadBaseBranchLabel(thread);
  }

  private syncThreadBindingDraft(thread: ThreadSummary | null, force = false): void {
    if (!thread) return;
    if (!force && this.whatsappBindingThreadId === thread.id && this.threadBindingDirty(thread)) return;
    const binding = thread.binding || {};
    this.whatsappBindingThreadId = thread.id;
    this.whatsappChatId = String(binding.chatId || "");
    this.whatsappDisplayName = String(binding.displayName || this.threadTitle(thread));
    this.whatsappReplyPrefix = String(binding.replyPrefix || this.defaultWhatsAppReplyPrefix());
    this.whatsappSenderAccountId = String(binding.receivingAccountId || binding.inboundAccountId || binding.senderAccountId || "");
    this.whatsappOutboundAccountId = String(binding.replyAccountId || binding.bridgeAccountId || binding.responderConnectorAccountId || binding.responderAccountId || binding.outboundAccountId || "");
    this.whatsappBindingEnabled = binding.enabled !== false;
    this.whatsappAllowOtherPeople = binding.additionalParticipantsEnabled === true;
    this.whatsappAdditionalParticipantIds = this.whatsappAllowOtherPeople
      ? this.normalizeWhatsAppParticipantIds(binding.additionalParticipantIds).filter((id) => !this.whatsappSystemParticipantIds(thread).has(id.toLowerCase()))
      : [];
    this.whatsappAdditionalParticipantLabels = binding.additionalParticipantLabels && typeof binding.additionalParticipantLabels === "object" && !Array.isArray(binding.additionalParticipantLabels)
      ? { ...(binding.additionalParticipantLabels as Record<string, string>) }
      : {};
    this.whatsappMirrorToWhatsApp = binding.mirrorToWhatsApp !== false;
    this.deleteThreadConfirm = "";
    this.deleteThreadWorkers = false;
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
      thread.lastMessageAt || "",
      thread.lastMessageCursor ?? "",
      thread.lastMessageId || "",
      thread.lastMessageRole || "",
      thread.lastMessagePhase || "",
      thread.lastMessageState || "",
      thread.lastMessageDeliveryState || "",
      thread.lastMessageError || "",
      thread.pendingCount ?? "",
      thread.runningCount ?? "",
      thread.awaitingAckCount ?? "",
      thread.nextDeliveryAttemptAt || "",
      String(thread.awaitingInput || ""),
      String(thread.awaitingInputEventId || ""),
      String(thread.codexModeLive || ""),
      String(thread.planAvailable || ""),
      String(thread.planImplementationReady || ""),
      String(thread.planImplementationMenuVisible || ""),
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
    return parts[0] === "setup" || parts[0] === "onboarding" || (parts[0] === "ng" && parts[1] === "onboarding");
  }

  private setupPageModeFromPath(): SetupPageMode {
    return "setup";
  }

  private setupSectionFromPath(): SetupSection {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return parts[0] === "setup" ? this.normalizeSetupSection(parts[1]) : "system";
  }

  private panelFromPath(): Panel {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    if (parts[0] === "ops" || (parts[0] === "ng" && parts[1] === "ops")) return "ops";
    if (parts[0] === "files" || (parts[0] === "ng" && parts[1] === "files")) return "files";
    if (parts[0] === "timers" || (parts[0] === "ng" && parts[1] === "timers")) return "userTimers";
    if (parts[0] === "desk" || (parts[0] === "ng" && parts[1] === "desk")) return "userDesk";
    if (parts[0] === "connectors" || (parts[0] === "ng" && parts[1] === "connectors")) return "userConnectors";
    if (parts[0] === "skills" || (parts[0] === "ng" && parts[1] === "skills")) return "chat";
    const threadIndex = parts.indexOf("thread");
    const panel = String(parts[threadIndex + 2] || "");
    return ["history", "delivery", "timers", "attach", "settings", "workers", "runtime", "raw", "ops", "files"].includes(panel) ? panel as Panel : "chat";
  }

  private toolsViewFromPath(): ToolsView {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const candidate = parts[0] === "ops"
      ? String(parts[1] || "system")
      : parts[0] === "ng" && parts[1] === "ops" ? String(parts[2] || "system") : "system";
    return ["system", "timers", "desktops", "models", "settings", "connectors", "users", "waitlist", "audit"].includes(candidate) ? candidate as ToolsView : "system";
  }

  private normalizeLegacyRoutePath(): void {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const retiredSetupSections = new Set(["google-marketing", "openai", "gmail", "linkedin", "mail", "outlook"]);
    if (parts[0] === "setup" && retiredSetupSections.has(String(parts[1] || "").toLowerCase())) {
      globalThis.history?.replaceState({}, "", "/setup");
      return;
    }
    if (parts[0] === "onboarding") {
      globalThis.history?.replaceState({}, "", "/setup");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "onboarding") {
      globalThis.history?.replaceState({}, "", "/setup");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "ops") {
      const suffix = parts[2] ? `/${parts[2]}` : "";
      globalThis.history?.replaceState({}, "", `/ops${suffix}`);
      return;
    }
    if (parts[0] === "ng" && parts[1] === "files") {
      globalThis.history?.replaceState({}, "", "/files");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "timers") {
      globalThis.history?.replaceState({}, "", "/timers");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "desk") {
      globalThis.history?.replaceState({}, "", "/desk");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "connectors") {
      globalThis.history?.replaceState({}, "", "/connectors");
      return;
    }
    if (parts[0] === "ng" && parts[1] === "skills") {
      globalThis.history?.replaceState({}, "", "/");
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
    this.pushSetupPath(this.setupSection || "system");
  }

  private replaceOnboardingPath(): void {
    this.replaceSetupPath(this.setupSection || "system");
  }

  private pushSetupPath(section: SetupSection = this.setupSection): void {
    const next = `/setup/${section}`;
    if (globalThis.location?.pathname === next) return;
    globalThis.history?.pushState({}, "", next);
  }

  private replaceSetupPath(section: SetupSection = this.setupSection): void {
    const next = `/setup/${section}`;
    if (globalThis.location?.pathname === next) return;
    globalThis.history?.replaceState({}, "", next);
  }

  private replacePairingPath(): void {
    const returnTo = new URLSearchParams(globalThis.location?.search || "").get("return");
    const next = returnTo ? `/setup/pairing?return=${encodeURIComponent(returnTo)}` : "/setup/pairing";
    if (`${globalThis.location?.pathname || ""}${globalThis.location?.search || ""}` === next) return;
    globalThis.history?.replaceState({}, "", next);
  }

  private sameOriginPairingReturnUrl(): string {
    const raw = new URLSearchParams(globalThis.location?.search || "").get("return") || "";
    if (!raw) return "";
    try {
      const current = new URL(globalThis.location?.href || "http://localhost/");
      const target = new URL(raw, current);
      if (!["http:", "https:"].includes(target.protocol)) return "";
      return target.origin === current.origin ? target.toString() : "";
    } catch {
      return "";
    }
  }

  private normalizeSetupSection(value: unknown): SetupSection {
    const section = String(value || "").trim().toLowerCase();
    return ["system", "security", "secrets", "maintenance", "codex", "whatsapp", "browsers"].includes(section)
      ? section as SetupSection
      : "system";
  }

  private pathForPanel(id: string, panel: Panel): string {
    if (panel === "ops") return this.opsPath(this.toolsView);
    if (panel === "files") return "/files";
    if (panel === "userTimers") return "/timers";
    if (panel === "userDesk") return "/desk";
    if (panel === "userConnectors") return "/connectors";
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
    if (this.isUserMode()) return false;
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

  threadNumberValue(thread: ThreadSummary | null, key: string): number {
    if (!thread) return Number.NaN;
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    const raw = thread[key] ?? this.pathValue(thread.runtime, key) ?? this.pathValue(metadata, key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  booleanThreadValue(thread: ThreadSummary | null, key: string): boolean {
    if (!thread) return false;
    const executor = thread["executor"];
    const metadata = executor && typeof executor === "object" ? (executor as Record<string, unknown>)["metadata"] : null;
    const raw = thread[key] ?? this.pathValue(thread.runtime, key) ?? this.pathValue(metadata, key);
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  }

  private updateDocumentTitle(): void {
    if (this.pairingRequired) {
      globalThis.document.title = "Pairing Required · Orkestr";
      return;
    }
    if (this.onboardingActive) {
      globalThis.document.title = this.setupPageMode === "setup" ? "Setup · Orkestr" : "Onboarding · Orkestr";
      return;
    }
    if (this.activePanel === "ops") {
      globalThis.document.title = "Ops · Orkestr";
      return;
    }
    if (this.activePanel === "files") {
      globalThis.document.title = "Files · Orkestr";
      return;
    }
    if (this.activePanel === "userTimers") {
      globalThis.document.title = "Automations · Orkestr";
      return;
    }
    if (this.activePanel === "userDesk") {
      globalThis.document.title = "Desk · Orkestr";
      return;
    }
    if (this.activePanel === "userConnectors") {
      globalThis.document.title = "Connectors · Orkestr";
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
