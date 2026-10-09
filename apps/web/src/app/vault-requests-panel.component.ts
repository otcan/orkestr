import { HttpClient } from "@angular/common/http";
import { Component, OnDestroy, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { vaultErrorMessage } from "./vault-secrets";

// Pending "request into vault" links (docs/vault.md). Metadata only: the
// password is typed on the one-time /s/<token> page, never here.

export interface VaultRequest {
  id: string;
  name: string;
  label?: string | null;
  threadId?: string | null;
  once: boolean;
  status: string;
  expiresAt?: string | null;
}

const pollMs = 15_000;

function apiBase(): string {
  const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
  return `${baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref}/api/vault`;
}

@Component({
  selector: "ork-vault-requests-panel",
  template: `
    @if (requests.length) {
      <h4>Requests from threads</h4>
    }
    @for (request of requests; track request.id) {
      <div class="vault-approval" role="status">
        <p>Thread <strong>{{ request.threadId }}</strong> requested <strong>{{ request.name }}</strong>
          ({{ request.once ? "single-use" : "saved" }}, link expires {{ request.expiresAt }}){{ request.label ? " · " + request.label : "" }}</p>
        <div class="vault-approval-actions">
          <button class="secondary" type="button" (click)="revoke(request)" [disabled]="busyId === request.id">Revoke</button>
        </div>
      </div>
    }
    @if (error) {
      <p class="vault-notice error" role="alert">{{ error }}</p>
    }
  `,
})
export class VaultRequestsPanelComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  requests: VaultRequest[] = [];
  busyId = "";
  error = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.load();
    this.timer = setInterval(() => void this.load(), pollMs);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async load(): Promise<void> {
    try {
      const result = await firstValueFrom(this.http.get<{ requests: VaultRequest[] }>(`${apiBase()}/requests`));
      this.requests = (result?.requests || []).filter((request) => request.status === "active");
    } catch {
      // Keep the last known list; the next poll retries.
    }
  }

  async revoke(request: VaultRequest): Promise<void> {
    this.busyId = request.id;
    this.error = "";
    try {
      await firstValueFrom(this.http.post(`${apiBase()}/requests/${encodeURIComponent(request.id)}/revoke`, {}));
      this.requests = this.requests.filter((entry) => entry.id !== request.id);
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not revoke the request.");
    } finally {
      this.busyId = "";
    }
  }
}
