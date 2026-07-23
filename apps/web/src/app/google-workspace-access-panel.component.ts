import { ChangeDetectorRef, Component, Input, OnChanges, SimpleChanges, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import {
  ApiService,
  GoogleWorkspaceCapability,
  GoogleWorkspaceConnection,
} from "./api.service";

@Component({
  selector: "ork-google-workspace-access-panel",
  imports: [FormsModule],
  templateUrl: "./google-workspace-access-panel.component.html",
  styleUrls: ["./google-workspace-access-panel.component.css"],
})
export class GoogleWorkspaceAccessPanelComponent implements OnChanges {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private initialized = false;

  @Input() accounts: GoogleWorkspaceConnection[] = [];
  @Input() availableCapabilities: GoogleWorkspaceCapability[] = [];
  @Input() privacyPolicyVersion = "";
  @Input() threadId = "";

  selectedAccountId = "";
  selectedCapabilities: string[] = [];
  consent = false;
  busy = false;
  error = "";

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized || changes["availableCapabilities"]) {
      this.ensureSelection();
      this.initialized = true;
    }
  }

  capabilityRisk(id: string): string {
    if (["gmail_read", "gmail_actions", "gmail_drafts"].includes(id)) return "Restricted";
    if (["gmail_send", "calendar_read", "calendar_actions"].includes(id)) return "Sensitive";
    return "Limited";
  }

  capabilityChecked(id: string): boolean {
    return this.selectedCapabilities.includes(id);
  }

  setCapability(id: string, enabled: boolean): void {
    const allowed = new Set(this.availableCapabilities.map((capability) => capability.id));
    if (!allowed.has(id)) return;
    this.selectedCapabilities = enabled
      ? [...new Set([...this.selectedCapabilities, id])]
      : this.selectedCapabilities.filter((capability) => capability !== id);
    this.consent = false;
  }

  selectAccount(connectionId: string): void {
    this.selectedAccountId = connectionId;
    const account = this.accounts.find((candidate) => candidate.connectionId === connectionId);
    const allowed = new Set(this.availableCapabilities.map((capability) => capability.id));
    const granted = (account?.capabilities || []).filter((capability) => allowed.has(capability));
    this.selectedCapabilities = granted.length ? granted : this.defaultCapabilities();
    this.consent = false;
    this.error = "";
  }

  accountLabel(account: GoogleWorkspaceConnection): string {
    return String(account.alias || account.email || account.connectionId || "Google account");
  }

  unavailableCapabilities(): string[] {
    const account = this.accounts.find((candidate) => candidate.connectionId === this.selectedAccountId);
    const allowed = new Set(this.availableCapabilities.map((capability) => capability.id));
    return (account?.capabilities || []).filter((capability) => !allowed.has(capability));
  }

  canContinue(): boolean {
    return !this.busy &&
      Boolean(this.selectedCapabilities.length) &&
      this.consent &&
      Boolean(this.privacyPolicyVersion);
  }

  async connect(): Promise<void> {
    if (!this.canContinue()) return;
    const account = this.accounts.find((candidate) => candidate.connectionId === this.selectedAccountId);
    this.busy = true;
    this.error = "";
    this.cdr.detectChanges();
    try {
      const result = await firstValueFrom(this.api.startGmailOAuth({
        accountId: account?.connectionId,
        account: account?.email,
        useMode: account ? account.useMode : (this.accounts.length ? "explicit_only" : "default"),
        setAsMain: !account && this.accounts.length === 0,
        threadId: this.threadId,
        capabilities: this.selectedCapabilities,
        privacyConsent: true,
        privacyPolicyVersion: this.privacyPolicyVersion,
      }));
      if (!result.authorizeUrl) throw new Error("Google authorization URL was not returned.");
      globalThis.location.href = result.authorizeUrl;
    } catch (error) {
      this.error = this.errorText(error);
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  private ensureSelection(): void {
    const ids = new Set(this.availableCapabilities.map((capability) => capability.id));
    this.selectedCapabilities = this.selectedCapabilities.filter((capability) => ids.has(capability));
    if (!this.selectedCapabilities.length) this.selectedCapabilities = this.defaultCapabilities();
  }

  private defaultCapabilities(): string[] {
    const ids = this.availableCapabilities.map((capability) => capability.id);
    if (ids.includes("gmail_send")) return ["gmail_send"];
    return ids.length ? [ids[0]] : [];
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
    }
    return String(error || "Google authorization could not start.");
  }
}
