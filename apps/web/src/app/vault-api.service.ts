import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";

export interface VaultThreadGrant {
  threadId: string;
}

export interface VaultItem {
  id: string;
  name: string;
  url?: string;
  domain?: string;
  tags?: string[];
  username?: string;
  hasPassword: boolean;
  hasTotp: boolean;
  totpType?: "totp" | "hotp" | null;
  threadGrants: VaultThreadGrant[];
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string | null;
  singleUse?: boolean;
  singleUseStatus?: "active" | "used" | "expired";
  singleUseExpiresAt?: string | null;
}

export interface VaultItemInput {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  notes?: string;
  tags?: string[];
  totpUri?: string;
  totpSecret?: string;
}

export interface VaultReveal {
  password: string;
  notes: string;
}

export interface VaultTotpCode {
  code: string;
  expiresInSeconds: number;
  period: number;
  digits: number;
}

export type VaultImportFormat = "auto" | "bitwarden" | "1password" | "chrome" | "otpauth";

export interface VaultImportResult {
  imported: number;
  skipped: number;
  withTotp: number;
  reasons?: unknown;
}

export interface VaultApproval {
  id: string;
  itemId: string;
  itemName: string;
  threadId: string;
  threadName: string;
  createdAt?: string;
  expiresAt?: string;
  status: string;
}

export interface VaultStatus {
  itemCount: number;
  totpCount: number;
  keySource?: string;
  keyFilePresent?: boolean;
  pendingApprovals: number;
}

@Injectable({ providedIn: "root" })
export class VaultApiService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = resolveApiBase();

  private api(path: string): string {
    return `${this.apiBase}/vault${path}`;
  }

  private item(id: string, suffix = ""): string {
    return this.api(`/items/${encodeURIComponent(id)}${suffix}`);
  }

  items(): Observable<{ items: VaultItem[] }> {
    return this.http.get<{ items: VaultItem[] }>(this.api("/items"));
  }

  createItem(input: VaultItemInput): Observable<{ item: VaultItem }> {
    return this.http.post<{ item: VaultItem }>(this.api("/items"), input);
  }

  updateItem(id: string, input: VaultItemInput): Observable<{ item: VaultItem }> {
    return this.http.patch<{ item: VaultItem }>(this.item(id), input);
  }

  deleteItem(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(this.item(id));
  }

  reveal(id: string): Observable<VaultReveal> {
    return this.http.post<VaultReveal>(this.item(id, "/reveal"), {});
  }

  totp(id: string): Observable<VaultTotpCode> {
    return this.http.post<VaultTotpCode>(this.item(id, "/totp"), {});
  }

  // Counter-based (HOTP) codes are used up when issued: explicit POST only.
  nextHotp(id: string): Observable<VaultTotpCode> {
    return this.http.post<VaultTotpCode>(this.item(id, "/totp"), { advance: true });
  }

  totpSecret(id: string): Observable<{ otpauthUri: string }> {
    return this.http.post<{ otpauthUri: string }>(this.item(id, "/totp-secret"), {});
  }

  importItems(format: VaultImportFormat, content: string): Observable<VaultImportResult> {
    return this.http.post<VaultImportResult>(this.api("/import"), { format, content });
  }

  setGrants(id: string, threadIds: string[]): Observable<{ item: VaultItem }> {
    return this.http.put<{ item: VaultItem }>(this.item(id, "/grants"), { threadIds });
  }

  approvals(): Observable<{ approvals: VaultApproval[] }> {
    return this.http.get<{ approvals: VaultApproval[] }>(this.api("/approvals"));
  }

  decideApproval(id: string, decision: "approve" | "deny"): Observable<{ approval: VaultApproval }> {
    return this.http.post<{ approval: VaultApproval }>(this.api(`/approvals/${encodeURIComponent(id)}/${decision}`), {});
  }

  status(): Observable<VaultStatus> {
    return this.http.get<VaultStatus>(this.api("/status"));
  }
}

function resolveApiBase(): string {
  const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
  const normalized = baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref;
  return `${normalized}/api`;
}
