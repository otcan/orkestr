import { DatePipe } from "@angular/common";
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import {
  Agent,
  AgentTemplate,
  ApiService,
  ConnectorStatus,
  EventRecord,
  SetupStatus,
  ThreadAttachResponse,
  ThreadMessage,
  ThreadSummary,
  ThreadUploadInput,
  TimerRecord,
} from "./api.service";

type Panel = "chat" | "history" | "timers" | "attach" | "runtime" | "raw" | "ops";
type ToolsView = "system" | "desktops" | "models" | "settings" | "connectors";

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
            <div class="head-actions cockpit-actions">
              <button class="system-mini-card" type="button" [class.active]="activePanel === 'ops'" (click)="openTools('system')" title="Open system resources">
                <span>
                  <strong>CPU {{ formatPercent(systemCpuPercent()) }}</strong>
                  <em>RAM {{ formatPercent(systemMemoryPercent()) }}</em>
                </span>
                <b>Load {{ systemLoadLabel() }}</b>
              </button>
              <div class="codex-capacity-card" [title]="codexCapacityTooltip(thread)">
                <div class="codex-model-row">
                  <strong>{{ codexModelName(thread) }}</strong>
                  <span>{{ codexReasoningEffortLabel(thread) || "effort ?" }}</span>
                </div>
                <div class="codex-meter-row">
                  <span class="codex-meter">
                    <b>5h</b>
                    <i><em [style.width.%]="codexRateRemaining(thread, 'primary') || 0"></em></i>
                    <small>{{ codexRateRemainingLabel(thread, 'primary') }}</small>
                  </span>
                  <span class="codex-meter">
                    <b>Week</b>
                    <i><em [style.width.%]="codexRateRemaining(thread, 'secondary') || 0"></em></i>
                    <small>{{ codexRateRemainingLabel(thread, 'secondary') }}</small>
                  </span>
                  <span class="codex-meter">
                    <b>Ctx</b>
                    <i><em [style.width.%]="codexContextPercent(thread) || 0"></em></i>
                    <small>{{ codexContextLabel(thread) }}</small>
                  </span>
                </div>
              </div>
              <div class="codex-mode-toggle" title="Requested Codex mode for this Orkestr thread">
                <button type="button" [class.active]="codexModeValue(thread) === 'code'" (click)="switchCodexMode('code')" [disabled]="busy">Code</button>
                <button type="button" [class.active]="codexModeValue(thread) === 'plan'" (click)="switchCodexMode('plan')" [disabled]="busy">Plan</button>
              </div>
              <button class="secondary" type="button" [class.active]="activePanel === 'raw'" (click)="openPanel('raw')">Raw</button>
              @if (canWakeThread(thread)) {
                <button class="secondary" type="button" (click)="wakeSelected()" [disabled]="busy">Wake</button>
              }
              @if (canSleepThread(thread)) {
                <button class="secondary" type="button" (click)="sleepSelected()" [disabled]="busy">Sleep</button>
              }
              @if (canRecoverThread(thread)) {
                <button class="secondary danger-soft" type="button" (click)="recoverSelected()" [disabled]="busy">Recover</button>
              }
            </div>
          </header>

          <nav class="panel-tabs" aria-label="Thread panels">
            <button type="button" [class.active]="activePanel === 'chat'" (click)="openPanel('chat')">Chat</button>
            <button type="button" [class.active]="activePanel === 'history'" (click)="openPanel('history')">History</button>
            <button type="button" [class.active]="activePanel === 'timers'" (click)="openPanel('timers')">Timers</button>
            <button type="button" [class.active]="activePanel === 'attach'" (click)="openPanel('attach')">Attach</button>
            <button type="button" [class.active]="activePanel === 'runtime'" (click)="openPanel('runtime')">Runtime</button>
            <button type="button" [class.active]="activePanel === 'raw'" (click)="openPanel('raw')">Raw</button>
            <button type="button" [class.active]="activePanel === 'ops'" (click)="openPanel('ops')">Tools</button>
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

          @if (activePanel === "raw") {
            <section class="panel-body raw-panel">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Raw Terminal</p>
                  <h3>{{ attachDetails?.ok ? "Attach target" : "No attachable runtime" }}</h3>
                </div>
                <button class="secondary" type="button" (click)="loadRaw()" [disabled]="busy">Reload</button>
              </div>
              @if (attachDetails?.ok) {
                <div class="terminal-card">
                  <span class="term-prompt">$</span>
                  <code>{{ attachDetails?.attachCommand }}</code>
                </div>
                <div
                  #rawScreen
                  class="raw-terminal"
                  tabindex="0"
                  (click)="focusRawTerminal()"
                  (keydown)="handleRawKeydown($event)"
                  (paste)="handleRawPaste($event)"
                  aria-label="Raw terminal"
                >
                  <pre>{{ rawScreenText || "Connecting to terminal..." }}</pre>
                </div>
                <div class="raw-status">
                  <span>{{ rawConnectionState }}{{ rawConnectionDetail ? " · " + rawConnectionDetail : "" }}</span>
                  <button class="secondary" type="button" (click)="focusRawTerminal()">Focus Keyboard</button>
                </div>
                <dl class="kv-grid">
                  <div>
                    <dt>State</dt>
                    <dd>{{ attachDetails?.state || runtimeValue("state") || "unknown" }}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{{ runtimeValue("sessionName") || thread.sessionName || "n/a" }}</dd>
                  </div>
                  <div>
                    <dt>Pane</dt>
                    <dd>{{ runtimeValue("paneId") || thread.paneId || "n/a" }}</dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{{ leaseValue("workspace") || "n/a" }}</dd>
                  </div>
                </dl>
                <p class="helper">Click the terminal before typing. The attach command remains available for a local tmux fallback.</p>
              } @else {
                <div class="empty-state">
                  <h3>{{ attachDetails?.message || "This thread has no live terminal lease." }}</h3>
                  @if (canWakeThread(thread)) {
                    <p>Wake the thread first, then reopen Raw.</p>
                  } @else {
                    <p>This thread is not currently eligible for raw terminal attach.</p>
                  }
                </div>
              }
            </section>
          }

          @if (activePanel === "ops") {
            <section class="panel-body ops-panel">
              <div class="panel-title">
                <div>
                  <p class="eyebrow">Orkestr Cockpit</p>
                  <h3>System, resources, models, settings, virtual desktops</h3>
                </div>
                <button class="secondary" type="button" (click)="loadOps()" [disabled]="busy">Reload</button>
              </div>
              <nav class="tool-tabs" aria-label="Orkestr tools">
                <button type="button" [class.active]="toolsView === 'system'" (click)="toolsView = 'system'">System</button>
                <button type="button" [class.active]="toolsView === 'desktops'" (click)="toolsView = 'desktops'">Virtual Desktops</button>
                <button type="button" [class.active]="toolsView === 'models'" (click)="toolsView = 'models'">Models</button>
                <button type="button" [class.active]="toolsView === 'settings'" (click)="toolsView = 'settings'">Settings</button>
                <button type="button" [class.active]="toolsView === 'connectors'" (click)="toolsView = 'connectors'">Connectors</button>
              </nav>

              @if (toolsView === "system") {
                <div class="ops-grid resource-grid">
                  <article class="ops-card critical">
                    <h4>CPU</h4>
                    <p>{{ formatPercent(systemCpuPercent()) }}</p>
                    <small>{{ objectPath(opsSystem, 'cpu.count') || '--' }} cores · load {{ systemLoadLabel() }}</small>
                    <i><em [style.width.%]="systemCpuPercent()"></em></i>
                  </article>
                  <article class="ops-card">
                    <h4>Memory</h4>
                    <p>{{ formatPercent(systemMemoryPercent()) }}</p>
                    <small>{{ formatBytes(numberPath(opsSystem, 'memory.used')) }} / {{ formatBytes(numberPath(opsSystem, 'memory.total')) }}</small>
                    <i><em [style.width.%]="systemMemoryPercent()"></em></i>
                  </article>
                  <article class="ops-card">
                    <h4>Disk</h4>
                    <p>{{ formatPercent(numberPath(opsSystem, 'disk.percent')) }}</p>
                    <small>{{ formatBytes(numberPath(opsSystem, 'disk.used')) }} / {{ formatBytes(numberPath(opsSystem, 'disk.total')) }}</small>
                    <i><em [style.width.%]="numberPath(opsSystem, 'disk.percent')"></em></i>
                  </article>
                  <article class="ops-card">
                    <h4>Orkestr</h4>
                    <p>{{ formatBytes(numberPath(opsSystem, 'orkestr.rss')) }}</p>
                    <small>PID {{ objectPath(opsSystem, 'orkestr.pid') || '--' }} · {{ opsRuntimeLeases.length }} leases</small>
                    <i><em [style.width.%]="runtimeLeasePercent()"></em></i>
                  </article>
                </div>
                <div class="process-table">
                  <div class="process-row head"><span>PID</span><span>User</span><span>CPU</span><span>Mem</span><span>Command</span></div>
                  @for (process of opsProcesses; track objectValue(process, 'pid') || jsonLine(process)) {
                    <div class="process-row">
                      <span>{{ objectValue(process, 'pid') }}</span>
                      <span>{{ objectValue(process, 'user') }}</span>
                      <span>{{ formatPercent(numberValue(process, 'cpu')) }}</span>
                      <span>{{ formatBytes(numberValue(process, 'rss')) }}</span>
                      <span>{{ objectValue(process, 'command') }} {{ objectValue(process, 'args') }}</span>
                    </div>
                  } @empty {
                    <p class="empty">No process sample loaded.</p>
                  }
                </div>
              }

              @if (toolsView === "desktops") {
                <div class="desktop-grid">
                  @for (browser of opsBrowsers; track objectValue(browser, "slug") || objectValue(browser, "id") || jsonLine(browser)) {
                    <article class="desktop-card">
                      <div>
                        <h4>{{ objectValue(browser, "label") || objectValue(browser, "slug") || objectValue(browser, "id") }}</h4>
                        <p>{{ objectValue(browser, "purpose") || objectValue(browser, "url") || "Virtual browser session" }}</p>
                        <small>{{ objectValue(browser, "status") || objectValue(browser, "state") || "unknown" }} · {{ objectValue(browser, "profileDir") || objectValue(browser, "profile") }}</small>
                      </div>
                      <div class="desktop-actions">
                        <button type="button" (click)="browserAction(browser, 'prepare')" [disabled]="busy">Prepare</button>
                        <button type="button" (click)="browserAction(browser, 'start')" [disabled]="busy">Open</button>
                      </div>
                    </article>
                  } @empty {
                    <p class="empty">No virtual desktops registered.</p>
                  }
                </div>
              }

              @if (toolsView === "models") {
                <div class="ops-grid">
                  <article class="ops-card">
                    <h4>Selected Thread Model</h4>
                    <p>{{ codexModelName(thread) }}</p>
                    <small>{{ codexReasoningEffortLabel(thread) || 'reasoning unknown' }} · {{ codexContextLabel(thread) }} context</small>
                  </article>
                  <article class="ops-card">
                    <h4>Local Models</h4>
                    <p>{{ objectPath(opsModels, 'ollama.ok') === 'true' ? 'ready' : 'overlay needed' }}</p>
                    <small>{{ objectPath(opsModels, 'ollama.baseUrl') || 'http://127.0.0.1:11434' }}</small>
                  </article>
                  <article class="ops-card">
                    <h4>External</h4>
                    <p>{{ objectPath(opsModels, 'external.configured') === 'true' ? 'configured' : 'not configured' }}</p>
                    <small>{{ objectPath(opsModels, 'external.baseUrl') || 'no base URL' }}</small>
                  </article>
                  <article class="ops-card">
                    <h4>Executor Adapters</h4>
                    <p>{{ opsExecutors.length }} adapters</p>
                    <small>{{ opsExecutions.length }} recent executions</small>
                  </article>
                </div>
              }

              @if (toolsView === "settings") {
                <div class="ops-grid">
                  <article class="ops-card">
                    <h4>Build</h4>
                    <p>{{ opsVersion?.name || "orkestr" }} {{ opsVersion?.version || "" }}</p>
                    <small>Data: {{ opsSetup?.home || "n/a" }}</small>
                  </article>
                  <article class="ops-card">
                    <h4>Setup</h4>
                    <p>{{ opsSetup?.setupState || "unknown" }}</p>
                    <small>Overlay {{ objectPath(opsSetup, 'overlay.valid') || 'unknown' }}</small>
                  </article>
                  <article class="ops-card">
                    <h4>Runtime Budget</h4>
                    <p>{{ objectValue(opsRuntimeBudget, "maxLiveThreads") || "n/a" }} live threads</p>
                    <small>{{ opsRuntimeLeases.length }} leases currently recorded</small>
                  </article>
                  <article class="ops-card">
                    <h4>WhatsApp</h4>
                    <p>{{ objectValue(opsWhatsApp, "state") || objectValue(opsWhatsApp, "status") || "unknown" }}</p>
                    <small>{{ objectValue(opsWhatsApp, "summary") || objectValue(opsWhatsApp, "accountId") || "bridge status" }}</small>
                  </article>
                </div>
              }

              @if (toolsView === "connectors") {
                <div class="ops-columns">
                  <section>
                    <h4>Connectors</h4>
                    <div class="compact-list">
                      @for (connector of opsConnectors; track connector.id) {
                        <article class="compact-row">
                          <strong>{{ connector.label || connector.id }}</strong>
                          <span>{{ connector.state }}</span>
                          <p>{{ connector.summary }}</p>
                        </article>
                      } @empty {
                        <p class="empty">No connector status loaded.</p>
                      }
                    </div>
                  </section>
                  <section>
                    <h4>Agents</h4>
                    <div class="compact-list">
                      @for (agent of opsAgents; track agent.id) {
                        <article class="compact-row">
                          <strong>{{ agent.name || agent.id }}</strong>
                          <span>{{ agent.state }}</span>
                          <p>{{ (agent.connectors || []).join(", ") }}</p>
                        </article>
                      } @empty {
                        <p class="empty">No agents yet.</p>
                      }
                    </div>
                  </section>
                  <section>
                    <h4>Global Timers</h4>
                    <div class="compact-list">
                      @for (timer of opsTimers; track timer.id) {
                        <article class="compact-row">
                          <strong>{{ timer.label || timer.id }}</strong>
                          <span>{{ timer.cadence }} · {{ timer.nextRunAt | date: "MMM d, HH:mm" }}</span>
                          <p>{{ timer.target }}</p>
                        </article>
                      } @empty {
                        <p class="empty">No global timers loaded.</p>
                      }
                    </div>
                  </section>
                  <section>
                    <h4>Events</h4>
                    <div class="compact-list">
                      @for (event of opsEvents; track eventKey(event)) {
                        <article class="compact-row">
                          <strong>{{ event.type }}</strong>
                          <span>{{ event.ts | date: "MMM d, HH:mm:ss" }}</span>
                          <p>{{ jsonLine(event) }}</p>
                        </article>
                      } @empty {
                        <p class="empty">No events loaded.</p>
                      }
                    </div>
                  </section>
                </div>
              }
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
    this.activePanel = this.panelFromPath();
    void this.loadSelectedThread(true);
  };

  @ViewChild("messagePane") private readonly messagePane?: ElementRef<HTMLElement>;
  @ViewChild("rawScreen") private readonly rawScreen?: ElementRef<HTMLElement>;

  threads: ThreadSummary[] = [];
  messages: ThreadMessage[] = [];
  historyMessages: ThreadMessage[] = [];
  timers: TimerRecord[] = [];
  runtimeDetails: Record<string, unknown> | null = null;
  attachDetails: ThreadAttachResponse | null = null;
  opsSetup: SetupStatus | null = null;
  opsVersion: Record<string, unknown> | null = null;
  opsWhatsApp: Record<string, unknown> | null = null;
  opsRuntimeBudget: Record<string, unknown> | null = null;
  opsConnectors: ConnectorStatus[] = [];
  opsAgents: Agent[] = [];
  opsAgentTemplates: AgentTemplate[] = [];
  opsTimers: TimerRecord[] = [];
  opsEvents: EventRecord[] = [];
  opsBrowsers: Array<Record<string, unknown>> = [];
  opsRuntimeLeases: Array<Record<string, unknown>> = [];
  opsExecutors: Array<Record<string, unknown>> = [];
  opsExecutions: Array<Record<string, unknown>> = [];
  opsSystem: Record<string, unknown> | null = null;
  opsProcesses: Array<Record<string, unknown>> = [];
  opsModels: Record<string, unknown> | null = null;
  selectedId = "";
  filterText = "";
  draft = "";
  error = "";
  apiOnline = false;
  busy = false;
  sending = false;
  activePanel: Panel = "chat";
  toolsView: ToolsView = "system";
  approveText = "Approved. Proceed.";
  interruptText = "";
  timerLabel = "Thread timer";
  timerCadence = "daily";
  timerTime = "09:00";
  timerPrompt = "";
  pendingFiles: PendingFile[] = [];
  draggingUpload = false;
  rawConnectionState = "idle";
  rawConnectionDetail = "";
  rawScreenText = "";

  private poller?: ReturnType<typeof setInterval>;
  private rawSocket?: WebSocket;
  private rawSocketThreadId = "";
  private rawReconnectTimer?: ReturnType<typeof setTimeout>;
  private shouldStickToBottom = true;
  private scrollAfterRender = true;
  private lastMessageSignature = "";

  ngOnInit(): void {
    this.selectedId = this.idFromPath();
    this.activePanel = this.panelFromPath();
    globalThis.addEventListener?.("popstate", this.popStateHandler);
    void this.refresh(true);
    this.poller = setInterval(() => void this.refresh(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
    this.closeRawStream();
    globalThis.removeEventListener?.("popstate", this.popStateHandler);
  }

  ngAfterViewChecked(): void {
    if (!this.scrollAfterRender || !this.messagePane?.nativeElement || this.activePanel !== "chat") return;
    const pane = this.messagePane.nativeElement;
    pane.scrollTop = pane.scrollHeight;
    this.scrollAfterRender = false;
    this.shouldStickToBottom = true;
  }

  async refresh(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [threadsResult, systemResult] = await Promise.allSettled([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.systemSummary()),
      ]);
      if (threadsResult.status === "rejected") throw threadsResult.reason;
      const payload = threadsResult.value;
      if (systemResult.status === "fulfilled") this.opsSystem = systemResult.value;
      this.apiOnline = true;
      this.threads = [...payload.threads].sort((a, b) => this.activityMs(b) - this.activityMs(a));
      if (!this.selectedId && this.threads.length) {
        this.selectedId = this.threadSlug(this.threads[0]);
        this.replacePath(this.selectedId, this.activePanel);
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
    this.activePanel = "chat";
    this.pushPath(this.selectedId, this.activePanel);
    this.messages = [];
    this.historyMessages = [];
    this.timers = [];
    this.runtimeDetails = null;
    this.attachDetails = null;
    this.closeRawStream();
    this.lastMessageSignature = "";
    this.shouldStickToBottom = true;
    this.scrollAfterRender = true;
    this.updateDocumentTitle();
    await this.loadSelectedThread(true);
    this.renderNow();
  }

  async openPanel(panel: Panel): Promise<void> {
    if (this.activePanel === "raw" && panel !== "raw") this.closeRawStream();
    this.activePanel = panel;
    const thread = this.selectedThread();
    if (thread) this.pushPath(this.threadSlug(thread), panel);
    if (panel === "history") await this.loadHistory();
    if (panel === "timers") await this.loadTimers();
    if (panel === "runtime") await this.loadRuntime();
    if (panel === "raw") await this.loadRaw();
    if (panel === "ops") await this.loadOps();
    if (panel === "chat") {
      this.shouldStickToBottom = true;
      this.scrollAfterRender = true;
    }
    this.renderNow();
  }

  async openTools(view: ToolsView = this.toolsView): Promise<void> {
    this.toolsView = view;
    await this.openPanel("ops");
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
      this.scrollAfterRender = true;
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

  async browserAction(browser: Record<string, unknown>, action: string): Promise<void> {
    const slug = this.objectValue(browser, "slug") || this.objectValue(browser, "id");
    if (!slug) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.browserAction(slug, action));
      await this.loadOps();
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

  async loadOps(): Promise<void> {
    this.busy = true;
    try {
      const [version, setup, whatsapp, agents, templates, timers, events, browsers, runtimeLeases, executors, executions, system, processes, models] = await Promise.allSettled([
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.agents()),
        firstValueFrom(this.api.agentTemplates()),
        firstValueFrom(this.api.timers()),
        firstValueFrom(this.api.events(40)),
        firstValueFrom(this.api.browserSessions()),
        firstValueFrom(this.api.runtimeLeases()),
        firstValueFrom(this.api.executors()),
        firstValueFrom(this.api.executions()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.systemProcesses("cpu")),
        firstValueFrom(this.api.modelStatus()),
      ]);
      if (version.status === "fulfilled") this.opsVersion = version.value;
      if (setup.status === "fulfilled") {
        this.opsSetup = setup.value;
        this.opsConnectors = setup.value.connectors || [];
      }
      if (whatsapp.status === "fulfilled") this.opsWhatsApp = whatsapp.value;
      if (agents.status === "fulfilled") this.opsAgents = agents.value.agents || [];
      if (templates.status === "fulfilled") this.opsAgentTemplates = templates.value.templates || [];
      if (timers.status === "fulfilled") this.opsTimers = timers.value.timers || [];
      if (events.status === "fulfilled") this.opsEvents = events.value.events || [];
      if (browsers.status === "fulfilled") this.opsBrowsers = browsers.value.sessions || [];
      if (runtimeLeases.status === "fulfilled") {
        this.opsRuntimeLeases = runtimeLeases.value.leases || [];
        this.opsRuntimeBudget = runtimeLeases.value.budget || null;
      }
      if (executors.status === "fulfilled") this.opsExecutors = executors.value.executors || [];
      if (executions.status === "fulfilled") this.opsExecutions = executions.value.executions || [];
      if (system.status === "fulfilled") this.opsSystem = system.value;
      if (processes.status === "fulfilled") this.opsProcesses = processes.value.processes || [];
      if (models.status === "fulfilled") this.opsModels = models.value;
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
    this.rawScreen?.nativeElement?.focus();
  }

  handleRawKeydown(event: KeyboardEvent): void {
    if (this.activePanel !== "raw") return;
    const data = this.rawKeyData(event);
    if (!data) return;
    event.preventDefault();
    this.sendRawInput(data);
  }

  handleRawPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text) return;
    event.preventDefault();
    this.sendRawInput(text);
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

  numberValue(value: unknown, key: string): number {
    if (!value || typeof value !== "object") return 0;
    const parsed = Number((value as Record<string, unknown>)[key]);
    return Number.isFinite(parsed) ? parsed : 0;
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

  runtimeLeasePercent(): number {
    const max = Number(this.objectValue(this.opsRuntimeBudget, "maxLiveThreads")) || 20;
    return Math.max(0, Math.min(100, (this.opsRuntimeLeases.length / max) * 100));
  }

  codexModeValue(thread: ThreadSummary | null): string {
    const mode = String(thread?.codexMode || thread?.desiredCodexMode || "").toLowerCase();
    return mode === "plan" ? "plan" : "code";
  }

  codexModelName(thread: ThreadSummary | null): string {
    return String(thread?.codexModel || this.objectPath(this.opsModels, "codex.model") || "Model unknown");
  }

  codexReasoningEffortLabel(thread: ThreadSummary | null): string {
    return String(thread?.codexReasoningEffort || this.objectPath(this.opsModels, "codex.reasoningEffort") || "").trim();
  }

  codexRateRemaining(thread: ThreadSummary | null, key: "primary" | "secondary"): number | null {
    const used = Number(thread?.codexRateLimits?.[key]?.used_percent);
    if (!Number.isFinite(used)) return null;
    return Math.max(0, Math.min(100, 100 - used));
  }

  codexRateRemainingLabel(thread: ThreadSummary | null, key: "primary" | "secondary"): string {
    const remaining = this.codexRateRemaining(thread, key);
    return remaining === null ? "--" : `${Math.round(remaining)}%`;
  }

  codexContextPercent(thread: ThreadSummary | null): number | null {
    const total = Number(thread?.codexContextWindow || 0);
    const used = Number(thread?.codexTokenUsage?.["total_tokens"] || thread?.codexTokenUsage?.["input_tokens"] || 0);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null;
    return Math.max(0, Math.min(100, (used / total) * 100));
  }

  codexContextLabel(thread: ThreadSummary | null): string {
    const percent = this.codexContextPercent(thread);
    return percent === null ? "--" : `${Math.round(percent)}%`;
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

  jsonLine(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value || "");
    }
  }

  eventKey(event: EventRecord): string {
    return `${event.ts || ""}:${event.type}:${this.jsonLine(event).slice(0, 120)}`;
  }

  private async loadSelectedThread(forceBottom: boolean): Promise<void> {
    const thread = this.selectedThread();
    if (!thread) return;
    const wasNearBottom = this.isMessagePaneNearBottom();
    const payload = await firstValueFrom(this.api.threadMessages(thread.id, 150));
    this.messages = payload.messages || [];
    const signature = this.messages.map((message) => this.messageKey(message)).join("|");
    const changed = signature !== this.lastMessageSignature;
    if (forceBottom || (!this.lastMessageSignature && this.messages.length > 0) || (changed && wasNearBottom)) {
      this.shouldStickToBottom = true;
      this.scrollAfterRender = true;
    }
    this.lastMessageSignature = signature;
    if (this.activePanel === "history") await this.loadHistory();
    if (this.activePanel === "timers") await this.loadTimers();
    if (this.activePanel === "runtime") await this.loadRuntime();
    if (this.activePanel === "raw") await this.loadRaw();
    if (this.activePanel === "ops") await this.loadOps();
    this.renderNow();
  }

  private isMessagePaneNearBottom(): boolean {
    const pane = this.messagePane?.nativeElement;
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  }

  private openRawStream(thread: ThreadSummary, attempt = 0): void {
    if (this.activePanel !== "raw") return;
    if (!this.rawScreen?.nativeElement) {
      if (attempt < 20) globalThis.setTimeout(() => this.openRawStream(thread, attempt + 1), 50);
      return;
    }
    const threadId = thread.id;
    if (this.rawSocket && this.rawSocketThreadId === threadId && this.rawSocket.readyState <= WebSocket.OPEN) {
      this.focusRawTerminal();
      return;
    }
    this.closeRawStream(false);
    this.rawSocketThreadId = threadId;
    this.rawConnectionState = "connecting";
    this.rawConnectionDetail = "";
    this.rawScreenText = this.rawScreenText || "Connecting to terminal...";
    const protocol = globalThis.location?.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${globalThis.location.host}/api/threads/${encodeURIComponent(threadId)}/stream`);
    this.rawSocket = socket;
    socket.addEventListener("open", () => {
      this.rawConnectionState = "connected";
      this.rawConnectionDetail = "waiting for terminal";
      this.renderNow();
      this.focusRawTerminal();
    });
    socket.addEventListener("message", (event) => {
      this.handleRawSocketPayload(JSON.parse(String(event.data || "{}")));
    });
    socket.addEventListener("close", () => {
      if (this.rawSocket !== socket) return;
      this.rawConnectionState = "disconnected";
      this.rawConnectionDetail = "socket closed";
      this.rawSocket = undefined;
      this.renderNow();
      this.scheduleRawReconnect(threadId);
    });
    socket.addEventListener("error", () => {
      if (this.rawSocket !== socket) return;
      this.rawConnectionState = "disconnected";
      this.rawConnectionDetail = "socket error";
      this.renderNow();
    });
  }

  private closeRawStream(clearScreen = true): void {
    if (this.rawReconnectTimer) {
      clearTimeout(this.rawReconnectTimer);
      this.rawReconnectTimer = undefined;
    }
    if (this.rawSocket) {
      this.rawSocket.close();
      this.rawSocket = undefined;
    }
    this.rawSocketThreadId = "";
    this.rawConnectionState = "idle";
    this.rawConnectionDetail = "";
    if (clearScreen) this.rawScreenText = "";
  }

  private scheduleRawReconnect(threadId: string): void {
    if (this.rawReconnectTimer || this.activePanel !== "raw") return;
    this.rawReconnectTimer = setTimeout(() => {
      this.rawReconnectTimer = undefined;
      const thread = this.selectedThread();
      if (thread?.id === threadId && this.activePanel === "raw") this.openRawStream(thread);
    }, 1500);
  }

  private handleRawSocketPayload(payload: Record<string, unknown>): void {
    const type = String(payload["type"] || "");
    if (type === "visible_screen") {
      this.rawScreenText = String(payload["data"] || "");
      this.rawConnectionState = "connected";
      this.rawConnectionDetail = "live";
      this.renderNow();
      return;
    }
    if (type === "transport_ready") {
      this.rawConnectionState = "connected";
      this.rawConnectionDetail = String(payload["transport"] || payload["state"] || "terminal");
      this.renderNow();
      return;
    }
    if (type === "error") {
      this.rawConnectionState = "error";
      this.rawConnectionDetail = String(payload["data"] || "terminal error");
      this.renderNow();
    }
  }

  private sendRawInput(data: string): void {
    if (!data || this.rawSocket?.readyState !== WebSocket.OPEN) return;
    this.rawSocket.send(JSON.stringify({ type: "input", data }));
  }

  private rawKeyData(event: KeyboardEvent): string {
    if (event.metaKey || event.altKey) return "";
    if (event.ctrlKey && /^[a-z]$/i.test(event.key)) {
      return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
    }
    switch (event.key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return "\x7f";
      case "Tab":
        return "\t";
      case "Escape":
        return "\x1b";
      case "ArrowUp":
        return "\x1b[A";
      case "ArrowDown":
        return "\x1b[B";
      case "ArrowRight":
        return "\x1b[C";
      case "ArrowLeft":
        return "\x1b[D";
      default:
        return event.key.length === 1 ? event.key : "";
    }
  }

  private threadState(thread: ThreadSummary): string {
    return String(thread.publicStatusCode || thread.status || thread.state || "").toLowerCase();
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

  private panelFromPath(): Panel {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    const threadIndex = parts.indexOf("thread");
    const panel = String(parts[threadIndex + 2] || "");
    return ["history", "timers", "attach", "runtime", "raw", "ops"].includes(panel) ? panel as Panel : "chat";
  }

  private pushPath(id: string, panel: Panel = "chat"): void {
    const next = this.pathForPanel(id, panel);
    if (globalThis.location?.pathname === next) return;
    globalThis.history?.pushState({}, "", next);
  }

  private replacePath(id: string, panel: Panel = "chat"): void {
    globalThis.history?.replaceState({}, "", this.pathForPanel(id, panel));
  }

  private pathForPanel(id: string, panel: Panel): string {
    const suffix = panel === "chat" ? "" : `/${panel}`;
    return `/ng/thread/${encodeURIComponent(id)}${suffix}`;
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
