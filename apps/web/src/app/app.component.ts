import { DatePipe } from "@angular/common";
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadMessage, ThreadSummary, ThreadUploadInput, TimerRecord } from "./api.service";

type Panel = "chat" | "history" | "timers" | "attach" | "runtime";

interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
}

@Component({
  selector: "ork-root",
  imports: [DatePipe, FormsModule],
  template: `
    <main class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div>
            <p class="eyebrow">Orkestr</p>
            <h1>Threads</h1>
          </div>
          <span class="health" [class.ok]="apiOnline">{{ apiOnline ? "online" : "loading" }}</span>
        </div>

        <label class="search">
          <span>Search</span>
          <input name="thread-search" [(ngModel)]="filterText" placeholder="agent, project, thread..." />
        </label>

        <nav class="thread-list" aria-label="Orkestr threads">
          @for (thread of filteredThreads(); track thread.id) {
            <a
              class="thread-item"
              [href]="threadUrl(thread)"
              [class.active]="isSelected(thread)"
              (click)="selectThread(thread, $event)"
            >
              <span class="status-dot" [class]="statusClass(thread)"></span>
              <span class="thread-text">
                <strong>{{ threadTitle(thread) }}</strong>
                <small>{{ statusLabel(thread) }} · {{ activityTime(thread) | date: "MMM d, HH:mm" }}</small>
              </span>
              @if ((thread.pendingCount || 0) > 0) {
                <span class="pending">{{ thread.pendingCount }}</span>
              }
            </a>
          } @empty {
            <p class="empty">No matching threads.</p>
          }
        </nav>
      </aside>

      <section class="chat">
        @if (selectedThread(); as thread) {
          <header class="chat-head">
            <div class="title-block">
              <p class="eyebrow">Conversation</p>
              <h2>{{ threadTitle(thread) }}</h2>
              <p class="subline">
                <span class="status-pill" [class]="statusClass(thread)">{{ statusLabel(thread) }}</span>
                <span>{{ thread.codexThreadId || thread.threadId || thread.id }}</span>
              </p>
            </div>
            <div class="head-actions">
              <a class="button secondary" [href]="rawUrl(thread)" target="_blank" rel="noopener">Raw</a>
              <button class="secondary" type="button" (click)="wakeSelected()" [disabled]="busy">Wake</button>
              <button class="secondary" type="button" (click)="sleepSelected()" [disabled]="busy">Sleep</button>
              <button class="secondary danger-soft" type="button" (click)="recoverSelected()" [disabled]="busy">Recover</button>
            </div>
          </header>

          <nav class="panel-tabs" aria-label="Thread panels">
            <button type="button" [class.active]="activePanel === 'chat'" (click)="openPanel('chat')">Chat</button>
            <button type="button" [class.active]="activePanel === 'history'" (click)="openPanel('history')">History</button>
            <button type="button" [class.active]="activePanel === 'timers'" (click)="openPanel('timers')">Timers</button>
            <button type="button" [class.active]="activePanel === 'attach'" (click)="openPanel('attach')">Attach</button>
            <button type="button" [class.active]="activePanel === 'runtime'" (click)="openPanel('runtime')">Runtime</button>
          </nav>

          @if (error) {
            <div class="notice error">{{ error }}</div>
          }

          @if (activePanel === "chat") {
            <section #messagePane class="messages" (scroll)="rememberScrollPosition()">
              @for (message of messages; track messageKey(message)) {
                <article class="message" [class.user]="message.role === 'user'" [class.failed]="message.state === 'failed'">
                  <div class="message-meta">
                    <strong>{{ message.role || "assistant" }}</strong>
                    <span>{{ messageTime(message) | date: "MMM d, HH:mm:ss" }}</span>
                    @if (message.state && message.state !== "completed") {
                      <em>{{ message.state }}</em>
                    }
                  </div>
                  <p>{{ messageText(message) }}</p>
                  @if ((message.attachments || []).length > 0) {
                    <div class="attachments">
                      @for (attachment of message.attachments || []; track attachmentLabel(attachment)) {
                        <span>{{ attachmentLabel(attachment) }}</span>
                      }
                    </div>
                  }
                </article>
              } @empty {
                <div class="empty-state">
                  <h3>No messages yet</h3>
                  <p>This thread exists, but no normalized Orkestr messages are stored yet.</p>
                </div>
              }
            </section>
          }

          @if (activePanel === "history") {
            <section class="panel-body">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Normalized History</p>
                  <h3>{{ historyMessages.length }} messages</h3>
                </div>
                <button class="secondary" type="button" (click)="loadHistory()" [disabled]="busy">Reload</button>
              </div>
              <div class="compact-list">
                @for (message of historyMessages; track messageKey(message)) {
                  <article class="compact-row">
                    <strong>{{ message.role }}</strong>
                    <span>{{ messageTime(message) | date: "MMM d, HH:mm:ss" }}</span>
                    <p>{{ messageText(message) }}</p>
                  </article>
                } @empty {
                  <p class="empty">No history rows are available.</p>
                }
              </div>
            </section>
          }

          @if (activePanel === "timers") {
            <section class="panel-body">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Timers</p>
                  <h3>{{ timers.length }} scheduled</h3>
                </div>
                <button class="secondary" type="button" (click)="loadTimers()" [disabled]="busy">Reload</button>
              </div>
              <form class="timer-editor" (submit)="createTimer(); $event.preventDefault()">
                <input name="timer-label" [(ngModel)]="timerLabel" placeholder="Label" />
                <select name="timer-cadence" [(ngModel)]="timerCadence">
                  <option value="once">Once</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="interval">Interval</option>
                </select>
                <input name="timer-time" [(ngModel)]="timerTime" placeholder="09:00 or every 2h" />
                <textarea name="timer-prompt" rows="3" [(ngModel)]="timerPrompt" placeholder="Timer instruction or prompt-file note"></textarea>
                <button type="submit" [disabled]="busy || !timerPrompt.trim()">Add timer</button>
              </form>
              <div class="compact-list">
                @for (timer of timers; track timer.id) {
                  <article class="timer-row">
                    <div>
                      <strong>{{ timer.label }}</strong>
                      <p>{{ timer.cadence }} · next {{ timer.nextRunAt | date: "MMM d, HH:mm" }}</p>
                      @if (timer.promptFile) {
                        <small>{{ timer.promptFile }}</small>
                      }
                    </div>
                    <button class="secondary danger-soft" type="button" (click)="deleteTimer(timer)" [disabled]="busy">Delete</button>
                  </article>
                } @empty {
                  <p class="empty">No timers for this thread.</p>
                }
              </div>
            </section>
          }

          @if (activePanel === "attach") {
            <section
              class="panel-body drop-zone"
              [class.dragging]="draggingUpload"
              (dragover)="handleDragOver($event)"
              (dragenter)="handleDragEnter($event)"
              (dragleave)="handleDragLeave($event)"
              (drop)="handleDrop($event)"
            >
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Attachments</p>
                  <h3>Attach files to the next message</h3>
                </div>
                <button class="secondary" type="button" (click)="filePicker.click()">Choose files</button>
              </div>
              <input #filePicker class="visually-hidden" type="file" multiple (change)="queueFiles(filePicker.files); filePicker.value = ''" />
              <p class="helper">Dropped or selected files are saved into Orkestr and sent to Codex as local file paths with the message.</p>
              <div class="file-list">
                @for (file of pendingFiles; track file.id) {
                  <span class="file-chip">
                    {{ file.name }} <small>{{ formatBytes(file.size) }}</small>
                    <button type="button" (click)="removePendingFile(file.id)">×</button>
                  </span>
                } @empty {
                  <p class="empty">No files selected.</p>
                }
              </div>
            </section>
          }

          @if (activePanel === "runtime") {
            <section class="panel-body">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Runtime</p>
                  <h3>Thread controls</h3>
                </div>
                <button class="secondary" type="button" (click)="loadRuntime()" [disabled]="busy">Reload</button>
              </div>
              <div class="runtime-actions">
                <input name="approve-text" [(ngModel)]="approveText" placeholder="Approval text" />
                <button type="button" (click)="approveSelected()" [disabled]="busy">Approve</button>
                <input name="interrupt-text" [(ngModel)]="interruptText" placeholder="Interrupt message" />
                <button class="danger-soft" type="button" (click)="interruptSelected()" [disabled]="busy">Interrupt</button>
              </div>
              <pre class="runtime-json">{{ runtimeJson() }}</pre>
            </section>
          }

          <form
            class="composer"
            [class.dragging]="draggingUpload"
            (submit)="sendMessage(); $event.preventDefault()"
            (dragover)="handleDragOver($event)"
            (dragenter)="handleDragEnter($event)"
            (dragleave)="handleDragLeave($event)"
            (drop)="handleDrop($event)"
          >
            <input
              #composerFilePicker
              class="visually-hidden"
              type="file"
              multiple
              (change)="queueFiles(composerFilePicker.files); composerFilePicker.value = ''"
            />
            @if (pendingFiles.length > 0) {
              <div class="queued-files">
                @for (file of pendingFiles; track file.id) {
                  <span class="file-chip">
                    {{ file.name }} <small>{{ formatBytes(file.size) }}</small>
                    <button type="button" (click)="removePendingFile(file.id)">×</button>
                  </span>
                }
              </div>
            }
            <div class="composer-row">
              <button class="secondary square" type="button" (click)="composerFilePicker.click()" title="Upload files">+</button>
              <textarea
                name="thread-input"
                [rows]="composerRows()"
                [(ngModel)]="draft"
                (keydown)="handleComposerKeydown($event)"
                placeholder="Message {{ threadTitle(thread) }}"
              ></textarea>
              <button type="submit" [disabled]="sending || (!draft.trim() && pendingFiles.length === 0)">{{ sending ? "Sending" : "Send" }}</button>
            </div>
          </form>
        } @else {
          <section class="empty-state full">
            <h2>No thread selected</h2>
            <p>Select a thread from the left sidebar.</p>
          </section>
        }
      </section>
    </main>
  `,
})
export class AppComponent implements OnInit, OnDestroy, AfterViewChecked {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly popStateHandler = () => {
    this.selectedId = this.idFromPath();
    void this.loadSelectedThread(true);
  };

  @ViewChild("messagePane") private readonly messagePane?: ElementRef<HTMLElement>;

  threads: ThreadSummary[] = [];
  messages: ThreadMessage[] = [];
  historyMessages: ThreadMessage[] = [];
  timers: TimerRecord[] = [];
  runtimeDetails: Record<string, unknown> | null = null;
  selectedId = "";
  filterText = "";
  draft = "";
  error = "";
  apiOnline = false;
  busy = false;
  sending = false;
  activePanel: Panel = "chat";
  approveText = "Approved. Proceed.";
  interruptText = "";
  timerLabel = "Thread timer";
  timerCadence = "daily";
  timerTime = "09:00";
  timerPrompt = "";
  pendingFiles: PendingFile[] = [];
  draggingUpload = false;

  private poller?: ReturnType<typeof setInterval>;
  private shouldStickToBottom = true;
  private lastMessageSignature = "";

  ngOnInit(): void {
    this.selectedId = this.idFromPath();
    globalThis.addEventListener?.("popstate", this.popStateHandler);
    void this.refresh(true);
    this.poller = setInterval(() => void this.refresh(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
    globalThis.removeEventListener?.("popstate", this.popStateHandler);
  }

  ngAfterViewChecked(): void {
    if (!this.shouldStickToBottom || !this.messagePane?.nativeElement || this.activePanel !== "chat") return;
    const pane = this.messagePane.nativeElement;
    pane.scrollTop = pane.scrollHeight;
  }

  async refresh(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const payload = await firstValueFrom(this.api.threads());
      this.apiOnline = true;
      this.threads = [...payload.threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      if (!this.selectedId && this.threads.length) {
        this.selectedId = this.threadSlug(this.threads[0]);
        this.replacePath(this.selectedId);
      }
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

  async selectThread(thread: ThreadSummary, event: MouseEvent): Promise<void> {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    this.selectedId = this.threadSlug(thread);
    this.pushPath(this.selectedId);
    this.messages = [];
    this.historyMessages = [];
    this.timers = [];
    this.runtimeDetails = null;
    this.lastMessageSignature = "";
    this.shouldStickToBottom = true;
    this.updateDocumentTitle();
    await this.loadSelectedThread(true);
    this.renderNow();
  }

  async openPanel(panel: Panel): Promise<void> {
    this.activePanel = panel;
    if (panel === "history") await this.loadHistory();
    if (panel === "timers") await this.loadTimers();
    if (panel === "runtime") await this.loadRuntime();
    if (panel === "chat") this.shouldStickToBottom = true;
    this.renderNow();
  }

  async sendMessage(): Promise<void> {
    const thread = this.selectedThread();
    if (!thread || this.sending) return;
    const originalText = this.draft.trim();
    if (!originalText && this.pendingFiles.length === 0) return;
    this.sending = true;
    try {
      const attachments = await this.uploadPendingFiles(thread);
      const text = this.messageWithAttachmentPaths(originalText, attachments);
      await firstValueFrom(this.api.sendThreadInput(thread.id, text, attachments));
      this.draft = "";
      this.pendingFiles = [];
      this.shouldStickToBottom = true;
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
      await this.refresh(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
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
      await firstValueFrom(this.api.createThreadTimer(thread.id, body));
      this.timerPrompt = "";
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
      await this.loadTimers();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
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
    this.shouldStickToBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
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

  queueFiles(files: FileList | null): void {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      this.pendingFiles.push({
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type,
      });
    }
  }

  removePendingFile(id: string): void {
    this.pendingFiles = this.pendingFiles.filter((file) => file.id !== id);
  }

  filteredThreads(): ThreadSummary[] {
    const needle = this.filterText.trim().toLowerCase();
    if (!needle) return this.threads;
    return this.threads.filter((thread) =>
      [thread.id, thread.name, thread.bindingName, thread.title, thread.codexThreadId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  selectedThread(): ThreadSummary | null {
    if (!this.selectedId) return this.threads[0] || null;
    return this.resolveThread(this.selectedId) || null;
  }

  isSelected(thread: ThreadSummary): boolean {
    return this.selectedThread()?.id === thread.id;
  }

  threadTitle(thread: ThreadSummary): string {
    return String(thread.bindingName || thread.name || thread.title || thread.id);
  }

  statusLabel(thread: ThreadSummary): string {
    const state = String(thread.publicStatus || thread.status || thread.state || "unknown");
    if (state === "ready") return "Ready";
    if (state === "sleeping") return "Sleeping";
    if (state === "working") return thread.backgroundWork ? "Background" : "Working";
    return state.replace(/_/g, " ");
  }

  statusClass(thread: ThreadSummary): string {
    const state = String(thread.publicStatusCode || thread.status || thread.state || "").toLowerCase();
    if (state.includes("broken") || state.includes("failed")) return "bad";
    if (state.includes("stuck") || state.includes("working") || state.includes("running")) return "hot";
    if (state.includes("ready")) return "ready";
    if (state.includes("sleep")) return "sleep";
    return "idle";
  }

  activityTime(thread: ThreadSummary): Date {
    return new Date(this.activityMs(thread));
  }

  threadUrl(thread: ThreadSummary): string {
    return `/ng/thread/${encodeURIComponent(this.threadSlug(thread))}`;
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

  messageTime(message: ThreadMessage): Date {
    return new Date(String(message.timestamp || message.createdAt || new Date().toISOString()));
  }

  attachmentLabel(attachment: Record<string, unknown>): string {
    return String(attachment["name"] || attachment["filename"] || attachment["path"] || attachment["saved_path"] || "attachment");
  }

  composerRows(): number {
    return Math.max(2, Math.min(10, this.draft.split("\n").length));
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
    return `${Math.round(value / 1024 / 102.4) / 10} MB`;
  }

  runtimeJson(): string {
    return JSON.stringify(this.runtimeDetails || {}, null, 2);
  }

  private async loadSelectedThread(forceBottom: boolean): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    const payload = await firstValueFrom(this.api.threadMessages(thread.id, 150));
    this.messages = payload.messages || [];
    const signature = this.messages.map((message) => this.messageKey(message)).join("|");
    if (forceBottom || signature !== this.lastMessageSignature) {
      this.shouldStickToBottom = true;
      this.lastMessageSignature = signature;
    }
    if (this.activePanel === "history") await this.loadHistory();
    if (this.activePanel === "timers") await this.loadTimers();
    if (this.activePanel === "runtime") await this.loadRuntime();
    this.renderNow();
  }

  private renderNow(): void {
    this.cdr.detectChanges();
  }

  private async uploadPendingFiles(thread: ThreadSummary): Promise<Array<Record<string, unknown>>> {
    if (!this.pendingFiles.length) return [];
    const files: ThreadUploadInput[] = [];
    for (const pending of this.pendingFiles) {
      if (pending.size > 10 * 1024 * 1024) {
        throw new Error(`${pending.name} is larger than 10 MB`);
      }
      files.push({
        name: pending.name,
        mimetype: pending.type,
        size: pending.size,
        contentBase64: await this.readFileBase64(pending.file),
      });
    }
    const payload = await firstValueFrom(this.api.uploadThreadFiles(thread.id, files));
    return payload.attachments || [];
  }

  private readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(file);
    });
  }

  private messageWithAttachmentPaths(text: string, attachments: Array<Record<string, unknown>>): string {
    if (!attachments.length) return text;
    const paths = attachments
      .map((attachment) => String(attachment["path"] || attachment["saved_path"] || ""))
      .filter(Boolean)
      .map((savedPath) => `- ${savedPath}`)
      .join("\n");
    return [text, "Attached files saved for this Orkestr thread:", paths].filter(Boolean).join("\n\n");
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

  private idFromPath(): string {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const threadIndex = parts.indexOf("thread");
    if (threadIndex >= 0 && parts[threadIndex + 1]) return decodeURIComponent(parts[threadIndex + 1]);
    return "";
  }

  private pushPath(id: string): void {
    globalThis.history?.pushState({}, "", `/ng/thread/${encodeURIComponent(id)}`);
  }

  private replacePath(id: string): void {
    globalThis.history?.replaceState({}, "", `/ng/thread/${encodeURIComponent(id)}`);
  }

  private activityMs(thread: ThreadSummary): number {
    const value = thread.lastActivityAt || thread.threadUpdatedAt || thread.updatedAt || thread.createdAt || "";
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : 0;
  }

  private updateDocumentTitle(): void {
    const thread = this.selectedThread();
    globalThis.document.title = thread ? `${this.threadTitle(thread)} · Orkestr` : "Orkestr";
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }
}
