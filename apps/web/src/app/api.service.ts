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
  promptFile?: string;
}

export interface EventRecord {
  ts?: string;
  type: string;
  [key: string]: unknown;
}

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>("/api/health");
  }

  setupStatus(): Observable<SetupStatus> {
    return this.http.get<SetupStatus>("/api/setup/status");
  }

  saveConnectorConfig(id: string, body: Record<string, string>): Observable<ConnectorConfigResponse> {
    return this.http.post<ConnectorConfigResponse>(`/api/connectors/${encodeURIComponent(id)}/config`, body);
  }

  testConnector(id: string): Observable<ConnectorStatus> {
    return this.http.post<ConnectorStatus>(`/api/connectors/${encodeURIComponent(id)}/test`, {});
  }

  startGmailOAuth(): Observable<GmailOAuthStartResponse> {
    return this.http.get<GmailOAuthStartResponse>("/api/connectors/gmail/oauth/start");
  }

  agentTemplates(): Observable<{ templates: AgentTemplate[] }> {
    return this.http.get<{ templates: AgentTemplate[] }>("/api/agents/templates");
  }

  createAgentFromTemplate(id: string): Observable<{ agent: Agent }> {
    return this.http.post<{ agent: Agent }>(`/api/agents/templates/${encodeURIComponent(id)}`, {});
  }

  agents(): Observable<{ agents: Agent[] }> {
    return this.http.get<{ agents: Agent[] }>("/api/agents");
  }

  agentMessages(id: string): Observable<{ messages: AgentMessage[] }> {
    return this.http.get<{ messages: AgentMessage[] }>(`/api/agents/${encodeURIComponent(id)}/messages`);
  }

  queueAgentMessage(id: string, text: string): Observable<{ message: AgentMessage }> {
    return this.http.post<{ message: AgentMessage }>(`/api/agents/${encodeURIComponent(id)}/messages`, { text });
  }

  runNextAgentMessage(id: string): Observable<unknown> {
    return this.http.post(`/api/agents/${encodeURIComponent(id)}/run-next`, { executorId: "noop" });
  }

  timers(): Observable<{ timers: TimerRecord[] }> {
    return this.http.get<{ timers: TimerRecord[] }>("/api/timers");
  }

  createTimer(body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>("/api/timers", body);
  }

  runTimer(id: string): Observable<unknown> {
    return this.http.post(`/api/timers/${encodeURIComponent(id)}/run`, {});
  }

  deleteTimer(id: string): Observable<unknown> {
    return this.http.delete(`/api/timers/${encodeURIComponent(id)}`);
  }

  events(limit = 50): Observable<{ events: EventRecord[] }> {
    return this.http.get<{ events: EventRecord[] }>(`/api/events?limit=${limit}`);
  }
}
