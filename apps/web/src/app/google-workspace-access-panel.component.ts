import { ChangeDetectorRef, Component, Input, inject } from "@angular/core";
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
export class GoogleWorkspaceAccessPanelComponent {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() accounts: GoogleWorkspaceConnection[] = [];
  @Input() availableCapabilities: GoogleWorkspaceCapability[] = [];
  @Input() threadId = "";

  selectedAccountId = "";
  busy = false;
  error = "";
  selectedCapabilities: string[] = [];

  selectAccount(connectionId: string): void {
    this.selectedAccountId = connectionId;
    const account = this.accounts.find((candidate) => candidate.connectionId === connectionId);
    this.selectedCapabilities = account?.capabilities?.filter((id) => this.capabilitiesForSelection().some((item) => item.id === id)) || [];
    this.error = "";
  }

  capabilitiesForSelection(): GoogleWorkspaceCapability[] {
    const account = this.accounts.find((candidate) => candidate.connectionId === this.selectedAccountId);
    return account?.availableCapabilities || this.availableCapabilities;
  }

  capabilitySelected(id: string): boolean {
    return this.selectedCapabilities.includes(id);
  }

  setCapability(id: string, selected: boolean): void {
    this.selectedCapabilities = selected
      ? [...new Set([...this.selectedCapabilities, id])]
      : this.selectedCapabilities.filter((value) => value !== id);
  }

  accountLabel(account: GoogleWorkspaceConnection): string {
    return String(account.alias || account.email || account.connectionId || "Google account");
  }

  canContinue(): boolean {
    return !this.busy && this.selectedCapabilities.length > 0;
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
        oauthApp: account?.oauthAppId,
        useMode: account ? account.useMode : (this.accounts.length ? "explicit_only" : "default"),
        setAsMain: !account && this.accounts.length === 0,
        threadId: this.threadId,
        capabilities: this.selectedCapabilities,
      }));
      if (!result.authorizeUrl) throw new Error("Google authorization URL was not returned.");
      globalThis.location.href = result.authorizeUrl;
    } catch (error) {
      this.error = this.errorText(error);
      this.busy = false;
      this.cdr.detectChanges();
    }
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
