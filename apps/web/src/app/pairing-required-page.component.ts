import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, SecurityChallenge, SetupStatus } from "./api.service";

@Component({
  selector: "ork-pairing-required-page",
  templateUrl: "./pairing-required-page.component.html",
  styleUrls: ["./pairing-required-page.component.css"],
})
export class PairingRequiredPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;

  @Input() setupStatus: SetupStatus | null = null;
  @Output() paired = new EventEmitter<string>();

  challenge: SecurityChallenge | null = null;
  busy = false;
  error = "";
  notice = "";

  ngOnInit(): void {
    const challengeId = this.challengeId();
    if (challengeId) void this.loadExistingChallenge(challengeId);
    else void this.createChallenge();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPolling();
  }

  async createChallenge(): Promise<void> {
    this.busy = true;
    this.error = "";
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.createSecurityChallenge(this.instanceId(), {
        requestedPath: this.requestedPath(),
      }));
      const returnedChallenge = result.challenge;
      this.challenge = returnedChallenge || {
        id: result.challengeId,
        approveCode: "",
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: result.expiresAt,
        instanceId: this.instanceId(),
      };
      this.notice = this.defaultApprovalNotice();
      this.startPolling();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  async loadExistingChallenge(challengeId: string): Promise<void> {
    this.busy = true;
    this.error = "";
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.securityChallenge(challengeId));
      this.challenge = result.challenge;
      this.notice = this.defaultApprovalNotice();
      if (this.challenge.status === "approved") await this.consumeChallenge();
      else this.startPolling();
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

  approveCommand(): string {
    const code = this.challenge?.approveCode || this.challenge?.id || "<code>";
    return `orkestr connect approve ${code}`;
  }

  approvalEyebrow(): string {
    const intent = this.challenge?.authIntent || {};
    const service = String(intent.service || "").trim();
    return service === "gmail" ? "Gmail approval" : "Orkestr";
  }

  approvalTitle(): string {
    const intent = this.challenge?.authIntent || {};
    return String(intent.title || "").trim() || "Approve this browser";
  }

  approvalDescription(): string {
    const intent = this.challenge?.authIntent || {};
    return String(intent.description || "").trim();
  }

  approvalContextRows(): Array<{ label: string; value: string }> {
    const intent = this.challenge?.authIntent || {};
    return [
      { label: "Tool", value: intent.tool || "" },
      { label: "Service", value: intent.service || "" },
      { label: "Provider", value: intent.provider || "" },
      { label: "Action", value: intent.action || "" },
      { label: "Instance", value: intent.instanceId || "" },
      { label: "User", value: intent.userId || "" },
      { label: "Thread", value: intent.thread || intent.threadId || "" },
    ].map((row) => ({ ...row, value: String(row.value || "").trim() })).filter((row) => row.value);
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

  async copyCommand(): Promise<void> {
    try {
      await globalThis.navigator?.clipboard?.writeText(this.approveCommand());
      this.notice = "Copied.";
    } catch {
      this.notice = "Select and copy the command.";
    }
    this.renderNow();
  }

  instanceId(): string {
    const params = new URLSearchParams(globalThis.location?.search || "");
    return String(params.get("instanceId") || params.get("instance") || params.get("orkestrInstanceId") || "").trim();
  }

  challengeId(): string {
    const params = new URLSearchParams(globalThis.location?.search || "");
    return String(params.get("challengeId") || params.get("challenge") || "").trim();
  }

  requestedPath(): string {
    const raw = new URLSearchParams(globalThis.location?.search || "").get("return") || "";
    if (!raw) return "";
    try {
      const current = new URL(globalThis.location?.href || "http://localhost/");
      const target = new URL(raw, current);
      if (target.origin !== current.origin) return "";
      return `${target.pathname}${target.search}${target.hash}`;
    } catch {
      return "";
    }
  }

  private async consumeChallenge(): Promise<void> {
    if (!this.challenge?.id) return;
    this.stopPolling();
    try {
      const result = await firstValueFrom(this.api.pairSecurityBrowser(this.challenge.id));
      this.notice = this.challenge.authIntent ? "Approved. Continuing to Google." : "Approved. Opening Orkestr.";
      this.renderNow();
      this.paired.emit(result.redirectPath || "");
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

  private defaultApprovalNotice(): string {
    return this.challenge?.authIntent
      ? "Paste the command below to approve this exact connection."
      : "Paste the command below into WhatsApp or a trusted terminal.";
  }

  private errorText(error: unknown): string {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown }; message?: unknown } : null;
    return String(record?.error?.error || record?.message || error || "Unknown error");
  }
}
