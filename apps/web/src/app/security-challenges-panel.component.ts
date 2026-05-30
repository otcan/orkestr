import { DatePipe } from "@angular/common";
import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, SecurityChallenge, SecuritySession, SecurityStatus } from "./api.service";

@Component({
  selector: "ork-security-challenges-panel",
  imports: [DatePipe],
  templateUrl: "./security-challenges-panel.component.html",
  styleUrls: ["./security-challenges-panel.component.css"],
})
export class SecurityChallengesPanelComponent implements OnInit, OnChanges {
  private readonly api = inject(ApiService);

  @Input() security: SecurityStatus | null | undefined = null;
  @Output() changed = new EventEmitter<void>();

  challenges: SecurityChallenge[] = [];
  sessions: SecuritySession[] = [];
  busy = false;
  error = "";
  notice = "";

  ngOnInit(): void {
    void this.load(false);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["security"] && this.hasPairedAccess()) void this.load(false);
  }

  hasPairedAccess(): boolean {
    return Boolean(this.security?.paired);
  }

  pendingChallenges(): SecurityChallenge[] {
    return this.challenges.filter((challenge) => challenge.status === "pending");
  }

  completedChallenges(): SecurityChallenge[] {
    return this.challenges.filter((challenge) => challenge.status !== "pending");
  }

  async load(showBusy = true): Promise<void> {
    if (!this.hasPairedAccess()) return;
    if (showBusy) this.busy = true;
    try {
      const [challengeResult, sessionResult] = await Promise.all([
        firstValueFrom(this.api.securityChallenges()),
        firstValueFrom(this.api.securitySessions()),
      ]);
      this.challenges = challengeResult.challenges || [];
      this.sessions = sessionResult.sessions || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = false;
    }
  }

  async approve(challenge: SecurityChallenge): Promise<void> {
    await this.withAction(`Approved challenge ${challenge.id}.`, async () => {
      await firstValueFrom(this.api.approveSecurityChallenge(challenge.id));
    });
  }

  async reject(challenge: SecurityChallenge): Promise<void> {
    await this.withAction(`Rejected challenge ${challenge.id}.`, async () => {
      await firstValueFrom(this.api.rejectSecurityChallenge(challenge.id));
    });
  }

  async deleteChallenge(challenge: SecurityChallenge): Promise<void> {
    await this.withAction(`Deleted challenge ${challenge.id}.`, async () => {
      await firstValueFrom(this.api.deleteSecurityChallenge(challenge.id));
    });
  }

  async revokeSession(session: SecuritySession): Promise<void> {
    await this.withAction(`Revoked browser session ${session.id}.`, async () => {
      await firstValueFrom(this.api.revokeSecuritySession(session.id));
    });
  }

  async revokeAllSessions(): Promise<void> {
    await this.withAction("Revoked all browser sessions.", async () => {
      await firstValueFrom(this.api.revokeAllSecuritySessions());
    });
  }

  async disablePairing(): Promise<void> {
    await this.withAction("Browser pairing is turned off and stored sessions were revoked.", async () => {
      await firstValueFrom(this.api.setSecurityPairingEnabled(false));
    });
  }

  requester(challenge: SecurityChallenge): string {
    return [challenge.requestedIp, challenge.requestedUserAgent].filter(Boolean).join(" - ") || "unknown browser";
  }

  challengeTarget(challenge: SecurityChallenge): string {
    return challenge.userId ? `${challenge.userId} · ${challenge.role || "user"}` : "admin browser";
  }

  challengeTimestamp(challenge: SecurityChallenge): string {
    return challenge.consumedAt || challenge.approvedAt || challenge.rejectedAt || challenge.expiresAt || challenge.createdAt || "";
  }

  sessionLabel(session: SecuritySession): string {
    return session.userAgent || session.id || "paired browser";
  }

  sessionTarget(session: SecuritySession): string {
    return session.userId ? `${session.userId} · ${session.role || "user"}` : "admin";
  }

  private async withAction(message: string, action: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await action();
      this.notice = message;
      this.error = "";
      await this.load(false);
      this.changed.emit();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private errorText(error: unknown): string {
    const record = error as { error?: { message?: string; error?: string }; message?: string };
    return record?.error?.message || record?.error?.error || record?.message || String(error || "Request failed");
  }
}
