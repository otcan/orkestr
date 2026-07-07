import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from "@angular/core";
import { DatePipe } from "@angular/common";
import { firstValueFrom } from "rxjs";
import { ApiService, SecurityChallenge, SharedAppPayload, SharedAppPerson } from "./api.service";

@Component({
  selector: "ork-shared-app-page",
  imports: [DatePipe],
  templateUrl: "./shared-app-page.component.html",
  styleUrls: ["./shared-app-page.component.css"],
})
export class SharedAppPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;

  payload: SharedAppPayload | null = null;
  people: SharedAppPerson[] = [];
  selectedId = "";
  busy = false;
  error = "";
  notice = "";
  savingPersonId = "";
  pairingRequired = false;
  pairingBusy = false;
  pairingNotice = "";
  pairingError = "";
  challenge: SecurityChallenge | null = null;

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPolling();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    this.renderNow();
    try {
      const route = this.route();
      this.payload = await firstValueFrom(this.api.sharedApp(route.instanceId, route.appSlug, route.shareToken));
      this.people = this.payload.data?.people || [];
      if (!this.selectedId && this.people.length) this.selectedId = this.people[0].id;
      this.pairingRequired = false;
      this.pairingError = "";
      this.pairingNotice = "";
      this.stopPolling();
    } catch (error) {
      if (this.isPairingRequiredError(error)) {
        this.payload = null;
        this.people = [];
        this.pairingRequired = true;
        this.error = "";
        await this.ensureChallenge();
      } else {
        this.error = this.errorText(error);
      }
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  title(): string {
    return this.payload?.app?.title || "Shared Review";
  }

  selectedPerson(): SharedAppPerson | null {
    return this.people.find((person) => person.id === this.selectedId) || this.people[0] || null;
  }

  select(person: SharedAppPerson): void {
    this.selectedId = person.id;
    this.notice = "";
  }

  labels(): string[] {
    return this.payload?.data?.labels || ["not_evaluated", "to_contact", "to_skip"];
  }

  labelText(label: string): string {
    return label.replace(/_/g, " ");
  }

  classifiedCount(): number {
    return this.people.filter((person) => person.currentClassification && person.currentClassification !== "not_evaluated").length;
  }

  canClassify(): boolean {
    return (this.payload?.data?.allowedActions || this.payload?.share?.allowedActionsJson || []).includes("setClassification");
  }

  approveCommand(): string {
    const code = this.challenge?.approveCode || this.challenge?.id || "<code>";
    return `orkestr connect approve ${code}`;
  }

  challengeStatusClass(): string {
    const status = String(this.challenge?.status || "idle");
    if (status === "approved" || status === "consumed") return "ready";
    if (status === "pending") return "partial";
    if (status === "rejected" || status === "expired") return "bad";
    return "idle";
  }

  challengeClosed(): boolean {
    return ["consumed", "expired", "rejected"].includes(String(this.challenge?.status || ""));
  }

  expiryLabel(): string {
    const timestamp = Date.parse(this.challenge?.expiresAt || "");
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown";
  }

  async copyCommand(): Promise<void> {
    try {
      await globalThis.navigator?.clipboard?.writeText(this.approveCommand());
      this.pairingNotice = "Copied.";
    } catch {
      this.pairingNotice = "Select and copy the command.";
    }
    this.renderNow();
  }

  async ensureChallenge(): Promise<void> {
    if (this.challenge?.status === "pending" || this.pairingBusy) {
      this.startPolling();
      return;
    }
    this.pairingBusy = true;
    this.pairingError = "";
    this.pairingNotice = "";
    this.renderNow();
    try {
      const route = this.route();
      const result = await firstValueFrom(this.api.createSharedAppChallenge(route.instanceId, route.appSlug, route.shareToken, {
        requestedPath: `${globalThis.location?.pathname || ""}${globalThis.location?.search || ""}`,
      }));
      this.challenge = result.challenge || {
        id: result.challengeId,
        approveCode: "",
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: result.expiresAt,
        instanceId: route.instanceId,
      };
      this.pairingNotice = "Approve this shared review from WhatsApp or a trusted terminal.";
      if (this.challenge.status === "approved") await this.consumeChallenge();
      else this.startPolling();
    } catch (error) {
      this.pairingError = this.errorText(error);
      this.stopPolling();
    } finally {
      this.pairingBusy = false;
      this.renderNow();
    }
  }

  async refreshChallenge(): Promise<void> {
    if (!this.challenge?.id) {
      await this.ensureChallenge();
      return;
    }
    const route = this.route();
    try {
      const result = await firstValueFrom(this.api.sharedAppChallenge(route.instanceId, route.appSlug, route.shareToken, this.challenge.id));
      this.challenge = result.challenge;
      this.pairingError = "";
      if (this.challenge.status === "approved") await this.consumeChallenge();
      if (["consumed", "expired", "rejected"].includes(this.challenge.status)) this.stopPolling();
    } catch (error) {
      this.pairingError = this.errorText(error);
      this.stopPolling();
    } finally {
      this.renderNow();
    }
  }

  async setClassification(label: string): Promise<void> {
    const person = this.selectedPerson();
    if (!person || !this.canClassify()) return;
    const route = this.route();
    this.savingPersonId = person.id;
    this.error = "";
    this.notice = "";
    try {
      const result = await firstValueFrom(this.api.sharedAppAction(route.instanceId, route.appSlug, route.shareToken, "setClassification", {
        personId: person.id,
        classification: label,
      }));
      this.payload = { ...this.payload, data: result.data || this.payload?.data };
      this.people = result.data?.people || this.people.map((item) => item.id === person.id ? { ...item, currentClassification: label } : item);
      this.notice = "Saved.";
      this.selectNext();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingPersonId = "";
    }
  }

  selectNext(): void {
    if (!this.people.length) return;
    const index = Math.max(0, this.people.findIndex((person) => person.id === this.selectedId));
    this.selectedId = this.people[Math.min(this.people.length - 1, index + 1)]?.id || this.people[0].id;
  }

  private async consumeChallenge(): Promise<void> {
    if (!this.challenge?.id) return;
    this.stopPolling();
    this.pairingBusy = true;
    this.pairingNotice = "Approved. Opening shared review.";
    this.pairingError = "";
    this.renderNow();
    try {
      const route = this.route();
      await firstValueFrom(this.api.pairSharedAppBrowser(route.instanceId, route.appSlug, route.shareToken, this.challenge.id));
      this.challenge = null;
      this.pairingRequired = false;
      await this.load();
    } catch (error) {
      this.pairingError = this.errorText(error);
    } finally {
      this.pairingBusy = false;
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

  private route(): { instanceId: string; appSlug: string; shareToken: string } {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return {
      instanceId: decodeURIComponent(parts[1] || ""),
      appSlug: decodeURIComponent(parts[3] || ""),
      shareToken: decodeURIComponent(parts[5] || ""),
    };
  }

  private renderNow(): void {
    if (this.destroyed) return;
    this.cdr.detectChanges();
  }

  private isPairingRequiredError(error: unknown): boolean {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown; code?: unknown }; message?: unknown } : null;
    const code = String(record?.error?.error || record?.error?.code || record?.message || error || "");
    return code.includes("browser_pairing_required") || code.includes("shared_app_session_required");
  }

  private errorText(error: unknown): string {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown }; message?: unknown } : null;
    return String(record?.error?.error || record?.message || error || "Unable to load shared app");
  }
}
