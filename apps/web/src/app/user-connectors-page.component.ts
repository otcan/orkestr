import { Component, OnDestroy, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, GmailOAuthStartResponse, OrkestrUser, OutlookOAuthStartResponse, SetupStatus } from "./api.service";

@Component({
  selector: "ork-user-connectors-page",
  imports: [FormsModule],
  templateUrl: "./user-connectors-page.component.html",
})
export class UserConnectorsPageComponent implements OnDestroy, OnInit {
  private readonly api = inject(ApiService);
  private readonly connectorOrder = ["whatsapp", "gmail", "outlook", "jira", "shopify", "linkedin", "browsers"];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private autoStartedRoute = "";

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

  ngOnDestroy(): void {
    this.clearRetry();
  }

  async load(showBusy = true): Promise<void> {
    this.clearRetry();
    if (showBusy) this.busy = true;
    try {
      const [setup, user] = await Promise.allSettled([
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.currentUser()),
      ]);
      if (setup.status === "fulfilled") this.setupStatus = setup.value;
      if (user.status === "fulfilled") this.currentUser = user.value.user;
      if (setup.status === "rejected" && user.status === "rejected") {
        this.error = this.errorText(user.reason || setup.reason);
      } else {
        this.error = "";
      }
      this.scheduleRetryIfNeeded();
      this.maybeAutoStartRouteLogin();
    } catch (error) {
      this.error = this.errorText(error);
      this.scheduleRetryIfNeeded();
    } finally {
      this.busy = false;
    }
  }

  userConnectors(): ConnectorStatus[] {
    const active = this.routeConnectorId();
    const connectors = this.connectorOrder.map((id) => this.connectorStatus(id));
    if (active) return connectors.filter((connector) => connector.id === active);
    return connectors;
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

  async startGmail(options: { autoRedirect?: boolean } = {}): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = "gmail";
    try {
      this.gmailAuth = await firstValueFrom(this.api.startGmailOAuth(this.gmailAccount));
      this.notice = this.gmailAuth.authorizeUrl ? "Gmail sign-in ready." : "Gmail sign-in started.";
      this.error = "";
      if (options.autoRedirect && this.gmailAuth.authorizeUrl) {
        this.notice = "Opening Gmail sign-in...";
        globalThis.location.href = this.gmailAuth.authorizeUrl;
        return;
      }
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

  loginOnly(): boolean {
    return Boolean(this.routeConnectorId());
  }

  loginTitle(): string {
    const active = this.routeConnectorId();
    return active === "gmail" ? "Connect Gmail" : active ? `Connect ${this.connectorLabel(active)}` : "Connect Account";
  }

  routeConnectorId(): string {
    const parts = this.locationPathParts();
    const candidate = parts[0] === "connectors" ? String(parts[1] || "").toLowerCase() : "";
    return this.connectorOrder.includes(candidate) ? candidate : "";
  }

  deskPath(): string {
    return this.appPath("/desk");
  }

  private maybeAutoStartRouteLogin(): void {
    const active = this.routeConnectorId();
    if (active !== "gmail") return;
    if (this.autoStartedRoute === active) return;
    if (this.actionBusy || this.autoLoginDisabled()) return;
    this.autoStartedRoute = active;
    void this.startGmail({ autoRedirect: true });
  }

  private autoLoginDisabled(): boolean {
    const params = new URLSearchParams(globalThis.location?.search || "");
    return params.get("manual") === "1" || params.get("auto") === "0";
  }

  private appBasePath(): string {
    const raw = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
    try {
      const parsed = new URL(raw, globalThis.location?.origin || "http://localhost");
      const path = parsed.pathname.replace(/\/+$/, "");
      return path === "/" ? "" : path;
    } catch {
      const path = String(raw || "/").split("?")[0].split("#")[0].replace(/\/+$/, "");
      return path === "/" ? "" : path;
    }
  }

  private locationPathParts(): string[] {
    const pathname = globalThis.location?.pathname || "/";
    const base = this.appBasePath();
    const path = base && (pathname === base || pathname.startsWith(`${base}/`))
      ? pathname.slice(base.length) || "/"
      : pathname;
    return path.split("/").filter(Boolean);
  }

  private appPath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const base = this.appBasePath();
    return base ? `${base}${normalized}` : normalized;
  }

  private scheduleRetryIfNeeded(): void {
    if (this.setupStatus && this.currentUser) {
      this.retryAttempts = 0;
      return;
    }
    if (this.retryTimer || this.retryAttempts >= 45) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAttempts += 1;
      void this.load(false);
    }, 2000);
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
