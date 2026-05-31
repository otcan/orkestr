import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, GmailOAuthStartResponse, OrkestrUser, OutlookOAuthStartResponse, SetupStatus } from "./api.service";

@Component({
  selector: "ork-user-connectors-page",
  imports: [FormsModule],
  templateUrl: "./user-connectors-page.component.html",
})
export class UserConnectorsPageComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly connectorOrder = ["whatsapp", "gmail", "outlook", "jira", "shopify", "linkedin", "browsers"];

  busy = false;
  actionBusy = "";
  error = "";
  notice = "";
  gmailAccount = "";
  outlookAccount = "";
  setupStatus: SetupStatus | null = null;
  currentUser: OrkestrUser | null = null;
  gmailAuth: GmailOAuthStartResponse | null = null;
  outlookAuth: OutlookOAuthStartResponse | null = null;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [setup, user] = await Promise.all([
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.currentUser()),
      ]);
      this.setupStatus = setup;
      this.currentUser = user.user;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  userConnectors(): ConnectorStatus[] {
    return this.connectorOrder.map((id) => this.connectorStatus(id));
  }

  connectorStatus(id: string): ConnectorStatus {
    const found = this.setupStatus?.connectors?.find((connector) => connector.id === id);
    if (found) return found;
    return {
      id,
      label: this.connectorLabel(id),
      state: "not_connected",
      summary: this.connectorSummary(id),
      details: {},
    };
  }

  connectorLabel(id: string): string {
    const labels: Record<string, string> = {
      whatsapp: "WhatsApp Chat",
      gmail: "Gmail",
      outlook: "Outlook",
      jira: "Jira",
      shopify: "Shopify",
      linkedin: "Managed Desktop",
      browsers: "Desktops",
    };
    return labels[id] || id;
  }

  connectorSummary(id: string): string {
    const summaries: Record<string, string> = {
      whatsapp: "Messages arrive through your assigned chat.",
      gmail: "Connect the Gmail account assigned to this user.",
      outlook: "Connect the Outlook account assigned to this user.",
      jira: "Connect Jira from chat when the parent Atlassian app is configured.",
      shopify: "Connect a Shopify store from chat when the parent app is configured.",
      linkedin: "Use the private browser desk for web logins and managed browsing.",
      browsers: "Managed browser desktops for this account.",
    };
    return summaries[id] || "User connector";
  }

  connectorState(connector: ConnectorStatus): string {
    return String(connector.state || "not_connected").replace(/_/g, " ");
  }

  connectorTone(connector: ConnectorStatus): string {
    const state = String(connector.state || "").toLowerCase();
    if (state === "connected") return "live";
    if (state === "broken" || state === "error") return "bad";
    if (state === "partial") return "ready";
    return "";
  }

  async startGmail(): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = "gmail";
    try {
      this.gmailAuth = await firstValueFrom(this.api.startGmailOAuth(this.gmailAccount));
      this.notice = this.gmailAuth.authorizeUrl ? "Gmail sign-in ready." : "Gmail sign-in started.";
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  async startOutlook(): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = "outlook";
    try {
      this.outlookAuth = await firstValueFrom(this.api.startOutlookOAuth(this.outlookAccount));
      this.notice = this.outlookAuth.userCode ? "Outlook sign-in ready." : "Outlook sign-in started.";
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  actionDisabled(id: string): boolean {
    return this.busy || Boolean(this.actionBusy && this.actionBusy !== id);
  }

  currentUserLabel(): string {
    return String(this.currentUser?.displayName || this.currentUser?.id || "User");
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown; status?: unknown; statusText?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
      if (record.status) return `HTTP ${record.status}${record.statusText ? ` ${record.statusText}` : ""}`;
    }
    return String(error || "Unknown error");
  }
}
