import { ChangeDetectorRef, Component, Input, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import {
  ApiService,
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
  @Input() threadId = "";

  selectedAccountId = "";
  busy = false;
  error = "";

  selectAccount(connectionId: string): void {
    this.selectedAccountId = connectionId;
    this.error = "";
  }

  accountLabel(account: GoogleWorkspaceConnection): string {
    return String(account.alias || account.email || account.connectionId || "Google account");
  }

  canContinue(): boolean {
    return !this.busy;
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
