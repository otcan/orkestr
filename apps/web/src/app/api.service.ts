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
}
