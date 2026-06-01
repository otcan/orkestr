import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, SecurityChallenge, SetupStatus } from "./api.service";

@Component({
  selector: "ork-pairing-required-page",
  templateUrl: "./pairing-required-page.component.html",
  styleUrls: ["./pairing-required-page.component.css"],
})
export class PairingRequiredPageComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;

  @Input() setupStatus: SetupStatus | null = null;
  @Output() paired = new EventEmitter<void>();

  challenge: SecurityChallenge | null = null;
  busy = false;
  error = "";
  notice = "";

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPolling();
  }

  async createChallenge(): Promise<void> {
    this.busy = true;
    this.error = "";
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.createSecurityChallenge());
      this.challenge = result.challenge || {
        id: result.challengeId,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: result.expiresAt,
      };
      this.notice = "Challenge generated. Approve it from the server before this browser can continue.";
      this.startPolling();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async refreshChallenge(): Promise<void> {
    if (!this.challenge?.id) return;
    try {
      const result = await firstValueFrom(this.api.securityChallenge(this.challenge.id));
      this.challenge = result.challenge;
      this.error = "";
      if (this.challenge.status === "approved") await this.consumeChallenge();
      if (["consumed", "expired", "rejected"].includes(this.challenge.status)) this.stopPolling();
    } catch (error) {
      this.error = this.errorText(error);
      this.stopPolling();
    } finally {
      this.renderNow();
    }
  }

  sshCommand(): string {
    return `ssh root@${this.serverHost()}`;
  }

  approveCommand(): string {
    const id = this.challenge?.id || "<challenge-id>";
    return `orkestr security approve ${id}`;
  }

  sudoApproveCommand(): string {
    const id = this.challenge?.id || "<challenge-id>";
    return `sudo orkestr security approve ${id}`;
  }

  challengeStatusClass(): string {
    const status = String(this.challenge?.status || "idle");
    if (status === "approved" || status === "consumed") return "ready";
    if (status === "pending") return "partial";
    if (status === "rejected" || status === "expired") return "bad";
    return "idle";
  }

  expiryLabel(): string {
    const timestamp = Date.parse(this.challenge?.expiresAt || "");
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown";
  }

  private async consumeChallenge(): Promise<void> {
    if (!this.challenge?.id) return;
    this.stopPolling();
    try {
      await firstValueFrom(this.api.pairSecurityBrowser(this.challenge.id));
      this.notice = "Browser paired. Opening Orkestr.";
      this.renderNow();
      this.paired.emit();
    } catch (error) {
      this.error = this.errorText(error);
      this.renderNow();
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.poller = setInterval(() => void this.refreshChallenge(), 3000);
  }

  private stopPolling(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = undefined;
  }

  private renderNow(): void {
    if (this.destroyed) return;
    this.cdr.detectChanges();
  }

  private serverHost(): string {
    const configured =
      this.setupStatus?.urls?.authUrl ||
      this.setupStatus?.security?.https?.authUrl ||
      this.setupStatus?.security?.https?.url ||
      "";
    try {
      if (configured) return new URL(configured).hostname;
    } catch {
      // Fall through to the current browser host.
    }
    return globalThis.location?.hostname || "your-server";
  }

  private errorText(error: unknown): string {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown }; message?: unknown } : null;
    return String(record?.error?.error || record?.message || error || "Unknown error");
  }
}
