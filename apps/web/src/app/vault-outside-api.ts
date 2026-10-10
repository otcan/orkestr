import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";
import type { VaultShareEnvelope } from "./vault-outside-crypto";

// Sharing with and receiving from people outside Orkestr
// (docs/vault-sharing.md). Built on the secret-link API; request bodies carry
// only browser-built ciphertext, never a value or decryption key.

export interface OutsideLink {
  id: string;
  kind: string;
  status: string;
  name: string | null;
  label: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  maxViews?: number;
  views?: number;
  passphrase?: boolean;
  openedAt?: string | null;
  once?: boolean;
  itemId?: string | null;
}

export interface OutsideLinkCreated {
  link: OutsideLink;
  url: string;
}

@Injectable({ providedIn: "root" })
export class VaultOutsideApiService {
  private readonly http = inject(HttpClient);
  private readonly base = resolveSecretLinksBase();

  share(body: { envelope: VaultShareEnvelope; name: string; ttl: string; views: number; label?: string }): Observable<OutsideLinkCreated> {
    return this.http.post<OutsideLinkCreated>(`${this.base}/e2e`, body);
  }

  request(body: { name: string; once: boolean; ttl: string; label?: string }): Observable<OutsideLinkCreated> {
    return this.http.post<OutsideLinkCreated>(`${this.base}/e2e-request`, body);
  }

  links(): Observable<{ links: OutsideLink[] }> {
    return this.http.get<{ links: OutsideLink[] }>(this.base);
  }

  revoke(id: string): Observable<{ link: OutsideLink }> {
    return this.http.post<{ link: OutsideLink }>(`${this.base}/${encodeURIComponent(id)}/revoke`, {});
  }
}

function resolveSecretLinksBase(): string {
  const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
  const normalized = baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref;
  return `${normalized}/api/secret-links`;
}
