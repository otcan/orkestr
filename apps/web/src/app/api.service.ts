import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";

export interface HealthResponse {
  ok: boolean;
  name: string;
  generatedAt: string;
}

export interface ConnectorStatus {
  id: string;
  label: string;
  state: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface SetupStatus {
  setupState: string;
  home: string;
  connectors: ConnectorStatus[];
  config?: Record<string, Record<string, string>>;
  overlay?: {
    configured?: boolean;
    valid?: boolean;
  };
}

export interface ConnectorConfigResponse {
  config: Record<string, string>;
}

export interface GmailOAuthStartResponse {
  authorizeUrl: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  tagline: string;
  connectors: string[];
  defaultTimer: {
    label: string;
    cadence: string;
    time: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  state: string;
  connectors: string[];
}

export interface AgentMessage {
  id: string;
  role: string;
  state: string;
  text: string;
  promptFile?: string;
}

export interface AgentWithMessages extends Agent {
  messages: AgentMessage[];
}

export interface TimerRecord {
  id: string;
  label: string;
  target: string;
  cadence: string;
  nextRunAt: string;
  time?: string;
  every?: string | null;
  prompt?: string;
  promptFile?: string;
  enabled?: boolean;
  createdAt?: string;
}

export interface EventRecord {
  ts?: string;
  type: string;
  [key: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  name?: string;
  title?: string;
  bindingName?: string;
  state?: string;
  status?: string;
  publicStatus?: string;
  publicStatusCode?: string;
  promptReady?: boolean;
  working?: boolean;
  typingActive?: boolean;
  backgroundWork?: boolean;
  pendingCount?: number;
  activeRuntimeLeaseId?: string | null;
  hibernated?: boolean;
  lastError?: string | null;
  parentThreadId?: string | null;
  rootThreadId?: string | null;
  workerIndex?: number | null;
  workerLabel?: string | null;
  workerStatus?: string | null;
  repoPath?: string | null;
  repoRemoteUrl?: string | null;
  remoteBranch?: string | null;
  baseBranch?: string | null;
  branchName?: string | null;
  baseCommit?: string | null;
  gitAhead?: number | null;
  gitBehind?: number | null;
  worktreePath?: string | null;
  sourceDirty?: boolean;
  forkedFromCodexThreadId?: string | null;
  lastActivityAt?: string;
  threadUpdatedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  sessionName?: string | null;
  paneId?: string | null;
  tmuxTarget?: string | null;
  threadId?: string;
  codexThreadId?: string | null;
  codexMode?: "code" | "plan" | string | null;
  codexModeLabel?: string | null;
  codexModeSource?: string | null;
  codexReasoningEffort?: string | null;
  codexModel?: string | null;
  codexModelProvider?: string | null;
  codexContextWindow?: number | null;
  codexTokenUsage?: Record<string, number> | null;
  codexRateLimits?: {
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
    plan_type?: string | null;
    rate_limit_reached_type?: string | null;
  } | null;
  desiredCodexMode?: "code" | "plan" | string | null;
  binding?: {
    connector?: string;
    chatId?: string;
    displayName?: string;
    enabled?: boolean;
  } | null;
  runtime?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ThreadMessage {
  id: string;
  role: string;
  source?: string;
  text?: string;
  promptFile?: string;
  createdAt?: string;
  timestamp?: string;
  state?: string;
  phase?: string;
  cursor?: number;
  attachments?: Array<Record<string, unknown>>;
  error?: string;
  [key: string]: unknown;
}

export interface ThreadMessagesResponse {
  thread?: ThreadSummary;
  messages: ThreadMessage[];
  cursor?: number;
  currentCursor?: number;
  count?: number;
  state?: string;
}

export interface ThreadHistoryResponse {
  thread?: ThreadSummary;
  messages: ThreadMessage[];
  count?: number;
  updatedAt?: string | null;
}

export interface ThreadRuntimeResponse {
  thread?: ThreadSummary;
  runtime?: Record<string, unknown>;
}

export interface ThreadAttachResponse {
  ok: boolean;
  state?: string;
  thread?: ThreadSummary;
  runtime?: Record<string, unknown>;
  attachCommand?: string;
  message?: string;
}

export interface ThreadUploadResponse {
  attachments: Array<Record<string, unknown>>;
}

export interface ThreadWorkerResponse {
  parent?: ThreadSummary;
  thread?: ThreadSummary;
  worker: ThreadSummary;
  message?: ThreadMessage;
  repoPath?: string;
  worktreePath?: string;
  branchName?: string;
  remoteBranch?: string;
  baseBranch?: string;
  baseCommit?: string;
  gitAhead?: number | null;
  gitBehind?: number | null;
  sourceDirty?: boolean;
}

export interface ThreadRepoResponse {
  thread: ThreadSummary;
  repo?: {
    repoPath?: string | null;
    repoRemoteUrl?: string | null;
    remoteBranch?: string | null;
    branchName?: string | null;
    baseBranch?: string | null;
    baseCommit?: string | null;
    gitAhead?: number | null;
    gitBehind?: number | null;
    sourceDirty?: boolean;
  };
  detected?: Record<string, unknown>;
}

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = this.resolveApiBase();

  private resolveApiBase(): string {
    const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
    const normalized = baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref;
    return `${normalized}/api`;
  }

  private api(path: string): string {
    return `${this.apiBase}${path}`;
  }

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(this.api("/health"));
  }

  version(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/version"));
  }

  setupStatus(): Observable<SetupStatus> {
    return this.http.get<SetupStatus>(this.api("/setup/status"));
  }

  saveConnectorConfig(id: string, body: Record<string, string>): Observable<ConnectorConfigResponse> {
    return this.http.post<ConnectorConfigResponse>(this.api(`/connectors/${encodeURIComponent(id)}/config`), body);
  }

  testConnector(id: string): Observable<ConnectorStatus> {
    return this.http.post<ConnectorStatus>(this.api(`/connectors/${encodeURIComponent(id)}/test`), {});
  }

  startGmailOAuth(): Observable<GmailOAuthStartResponse> {
    return this.http.get<GmailOAuthStartResponse>(this.api("/connectors/gmail/oauth/start"));
  }

  whatsappStatus(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/connectors/whatsapp/status"));
  }

  startWhatsAppAccount(accountId: string): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/start`),
      {},
    );
  }

  logoutWhatsAppAccount(accountId: string): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/logout`),
      {},
    );
  }

  agentTemplates(): Observable<{ templates: AgentTemplate[] }> {
    return this.http.get<{ templates: AgentTemplate[] }>(this.api("/agents/templates"));
  }

  createAgentFromTemplate(id: string): Observable<{ agent: Agent }> {
    return this.http.post<{ agent: Agent }>(this.api(`/agents/templates/${encodeURIComponent(id)}`), {});
  }

  agents(): Observable<{ agents: Agent[] }> {
    return this.http.get<{ agents: Agent[] }>(this.api("/agents"));
  }

  agentMessages(id: string): Observable<{ messages: AgentMessage[] }> {
    return this.http.get<{ messages: AgentMessage[] }>(this.api(`/agents/${encodeURIComponent(id)}/messages`));
  }

  queueAgentMessage(id: string, text: string): Observable<{ message: AgentMessage }> {
    return this.http.post<{ message: AgentMessage }>(this.api(`/agents/${encodeURIComponent(id)}/messages`), { text });
  }

  runNextAgentMessage(id: string): Observable<unknown> {
    return this.http.post(this.api(`/agents/${encodeURIComponent(id)}/run-next`), { executorId: "noop" });
  }

  executors(): Observable<{ executors: Array<Record<string, unknown>> }> {
    return this.http.get<{ executors: Array<Record<string, unknown>> }>(this.api("/executors"));
  }

  executions(): Observable<{ executions: Array<Record<string, unknown>> }> {
    return this.http.get<{ executions: Array<Record<string, unknown>> }>(this.api("/executions"));
  }

  timers(): Observable<{ timers: TimerRecord[] }> {
    return this.http.get<{ timers: TimerRecord[] }>(this.api("/timers"));
  }

  createTimer(body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api("/timers"), body);
  }

  runTimer(id: string): Observable<unknown> {
    return this.http.post(this.api(`/timers/${encodeURIComponent(id)}/run`), {});
  }

  deleteTimer(id: string): Observable<unknown> {
    return this.http.delete(this.api(`/timers/${encodeURIComponent(id)}`));
  }

  events(limit = 50): Observable<{ events: EventRecord[] }> {
    return this.http.get<{ events: EventRecord[] }>(this.api(`/events?limit=${limit}`));
  }

  browsers(): Observable<{ browsers: Array<Record<string, unknown>> }> {
    return this.http.get<{ browsers: Array<Record<string, unknown>> }>(this.api("/browsers"));
  }

  runtimeLeases(): Observable<{ leases: Array<Record<string, unknown>>; budget?: Record<string, unknown> }> {
    return this.http.get<{ leases: Array<Record<string, unknown>>; budget?: Record<string, unknown> }>(this.api("/runtime-leases"));
  }

  systemSummary(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/system/summary"));
  }

  systemProcesses(sort = "cpu"): Observable<{ count: number; processes: Array<Record<string, unknown>> }> {
    return this.http.get<{ count: number; processes: Array<Record<string, unknown>> }>(this.api(`/system/processes?sort=${encodeURIComponent(sort)}`));
  }

  modelStatus(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/models/status"));
  }

  threads(): Observable<{ threads: ThreadSummary[] }> {
    return this.http.get<{ threads: ThreadSummary[] }>(this.api("/threads"));
  }

  threadMessages(id: string, limit = 100): Observable<ThreadMessagesResponse> {
    return this.http.get<ThreadMessagesResponse>(this.api(`/threads/${encodeURIComponent(id)}/messages?limit=${limit}`));
  }

  threadRuntime(id: string): Observable<ThreadSummary> {
    return this.http.get<ThreadSummary>(this.api(`/threads/${encodeURIComponent(id)}/runtime-lite`));
  }

  threadWorkers(id: string): Observable<{ thread?: ThreadSummary; workers: ThreadSummary[] }> {
    return this.http.get<{ thread?: ThreadSummary; workers: ThreadSummary[] }>(this.api(`/threads/${encodeURIComponent(id)}/workers`));
  }

  createThreadWorker(id: string, body: Record<string, unknown>): Observable<ThreadWorkerResponse> {
    return this.http.post<ThreadWorkerResponse>(this.api(`/threads/${encodeURIComponent(id)}/workers`), body);
  }

  updateThreadRepo(id: string, body: Record<string, unknown>): Observable<ThreadRepoResponse> {
    return this.http.put<ThreadRepoResponse>(this.api(`/threads/${encodeURIComponent(id)}/repo`), body);
  }

  detectThreadRepo(id: string): Observable<ThreadRepoResponse> {
    return this.http.post<ThreadRepoResponse>(this.api(`/threads/${encodeURIComponent(id)}/repo/detect`), {});
  }

  sendThreadInput(id: string, text: string, attachments: Array<Record<string, unknown>> = []): Observable<unknown> {
    const body: Record<string, unknown> = { text };
    if (attachments.length) body["attachments"] = attachments;
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/input`), body);
  }

  wakeThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/wake`), { reason: "ui_wake" });
  }

  sleepThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/sleep`), { reason: "ui_sleep" });
  }

  resumeThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/resume`), { reason: "ui_resume" });
  }

  recoverThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/recover`), {});
  }

  interruptThread(id: string, text = ""): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/interrupt`), { text });
  }

  approveThread(id: string, text = "Approved. Proceed."): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/approve`), { text });
  }

  setCodexMode(id: string, mode: "code" | "plan"): Observable<{ thread?: ThreadSummary }> {
    return this.http.post<{ thread?: ThreadSummary }>(this.api(`/threads/${encodeURIComponent(id)}/codex-mode`), { mode });
  }

  threadRuntimeFull(id: string): Observable<ThreadRuntimeResponse> {
    return this.http.get<ThreadRuntimeResponse>(this.api(`/threads/${encodeURIComponent(id)}/runtime`));
  }

  attachThread(id: string): Observable<ThreadAttachResponse> {
    return this.http.post<ThreadAttachResponse>(this.api(`/threads/${encodeURIComponent(id)}/attach`), {});
  }

  threadHistory(id: string): Observable<ThreadHistoryResponse> {
    return this.http.get<ThreadHistoryResponse>(this.api(`/threads/${encodeURIComponent(id)}/history`));
  }

  threadTimers(id: string): Observable<{ timers: TimerRecord[] }> {
    return this.http.get<{ timers: TimerRecord[] }>(this.api(`/threads/${encodeURIComponent(id)}/timers`));
  }

  createThreadTimer(id: string, body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/threads/${encodeURIComponent(id)}/timers`), body);
  }

  deleteThreadTimer(id: string, timerId: string): Observable<unknown> {
    return this.http.delete(this.api(`/threads/${encodeURIComponent(id)}/timers/${encodeURIComponent(timerId)}`));
  }

  uploadThreadFiles(id: string, files: File[]): Observable<ThreadUploadResponse> {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file, file.name);
    }
    return this.http.post<ThreadUploadResponse>(this.api(`/threads/${encodeURIComponent(id)}/uploads`), body);
  }

  browserSessions(): Observable<{ sessions: Array<Record<string, unknown>> }> {
    return this.http.get<{ sessions: Array<Record<string, unknown>> }>(this.api("/browser-sessions"));
  }

  browserAction(slug: string, action: string): Observable<unknown> {
    return this.http.post(this.api(`/browser-sessions/${encodeURIComponent(slug)}/${encodeURIComponent(action)}`), {});
  }
}
