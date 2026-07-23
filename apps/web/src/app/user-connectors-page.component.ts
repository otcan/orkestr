import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, GoogleWorkspaceCapability, GoogleWorkspaceConnection, OrkestrUser, OutlookOAuthStartResponse, SetupStatus } from "./api.service";
import { GoogleWorkspaceAccessPanelComponent } from "./google-workspace-access-panel.component";
import { GmailNotificationsPanelComponent } from "./gmail-notifications-panel.component";

@Component({
  selector: "ork-user-connectors-page",
  imports: [FormsModule, GmailNotificationsPanelComponent, GoogleWorkspaceAccessPanelComponent],
  templateUrl: "./user-connectors-page.component.html",
})
export class UserConnectorsPageComponent implements OnDestroy, OnInit {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly connectorOrder = ["whatsapp", "gmail", "outlook", "jira", "shopify", "linkedin", "browsers"];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private destroyed = false;
  private renderQueued = false;

  busy = false;
  actionBusy = "";
  error = "";
  notice = "";
  outlookAccount = "";
  setupStatus: SetupStatus | null = null;
  currentUser: OrkestrUser | null = null;
  outlookAuth: OutlookOAuthStartResponse | null = null;
  googleAccounts: GoogleWorkspaceConnection[] = [];
  googleCapabilities: GoogleWorkspaceCapability[] = [];
  googlePrivacyPolicyVersion = "";

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearRetry();
  }

  async load(showBusy = true): Promise<void> {
    this.clearRetry();
    if (showBusy) {
      this.busy = true;
      this.renderNow();
    }
    try {
      const [setup, user, googleAccounts] = await Promise.allSettled([
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.currentUser()),
        firstValueFrom(this.api.googleWorkspaceAccounts(this.connectorIntentThreadId())),
      ]);
      if (setup.status === "fulfilled") this.setupStatus = setup.value;
      if (user.status === "fulfilled") this.currentUser = user.value.user;
      if (googleAccounts.status === "fulfilled") {
        this.googleAccounts = googleAccounts.value.connections || [];
        this.googleCapabilities = googleAccounts.value.availableCapabilities || [];
        this.googlePrivacyPolicyVersion = googleAccounts.value.privacyPolicyVersion || "";
      }
      if (setup.status === "rejected") {
        this.error = this.errorText(setup.reason);
      } else if (user.status === "rejected" && !this.currentUser) {
        this.error = this.errorText(user.reason);
      } else {
        this.error = "";
      }
      this.scheduleRetryIfNeeded();
    } catch (error) {
      this.error = this.errorText(error);
      this.scheduleRetryIfNeeded();
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  userConnectors(): ConnectorStatus[] {
    if (!this.setupStatus) return [];
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
      gmail: "Connect a Gmail account for this user.",
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
    if (state === "broken" || state === "error" || state === "reauth_required") return "bad";
    if (state === "partial" || state === "degraded") return "ready";
    return "";
  }

  connectorConnected(connector: ConnectorStatus): boolean {
    return String(connector.state || "").toLowerCase() === "connected";
  }

  connectedAccount(connector: ConnectorStatus): string {
    return this.detailString(connector, "account") || this.detailString(connector, "email") || this.detailString(connector, "loginHint");
  }

  connectedCapabilityLabels(connector: ConnectorStatus): string[] {
    return this.detailStringArray(connector, "capabilityLabels");
  }

  connectedGoogleAccounts(connector: ConnectorStatus): Array<Record<string, unknown>> {
    if (connector.id === "gmail" && this.googleAccounts.length) return this.googleAccounts;
    const value = connector.details?.["connections"];
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  }

  googleAccountLabel(connection: Record<string, unknown>): string {
    return String(connection["alias"] || connection["email"] || connection["connectionId"] || "Google account");
  }

  googleAccountEmail(connection: Record<string, unknown>): string { return String(connection["email"] || ""); }

  googleAccountMode(connection: Record<string, unknown>): string {
    if (connection["isMain"] === true) return "main";
    if (connection["isThreadDefault"] === true) return "thread default";
    return String(connection["useMode"] || "available").replace(/_/g, " ");
  }

  googleAccountId(connection: Record<string, unknown>): string { return String(connection["connectionId"] || connection["accountId"] || ""); }

  googleAccountIsMain(connection: Record<string, unknown>): boolean { return connection["isMain"] === true; }

  googleAccountIsThreadDefault(connection: Record<string, unknown>): boolean { return connection["isThreadDefault"] === true; }

  googleAccountUseMode(connection: Record<string, unknown>): string { return String(connection["useMode"] || "available"); }

  async makeGoogleAccountMain(connectionId: string): Promise<void> {
    await this.performConnectorAction(`gmail-main-${connectionId}`, () => firstValueFrom(
      this.api.updateGoogleWorkspaceAccount(connectionId, { setAsMain: true }),
    ), "Main Google account updated.");
  }

  async makeGoogleAccountThreadDefault(connectionId: string): Promise<void> {
    const threadId = this.connectorIntentThreadId();
    if (!threadId) return;
    await this.performConnectorAction(`gmail-thread-${connectionId}`, () => firstValueFrom(
      this.api.updateGoogleWorkspaceAccount(connectionId, { setAsThreadDefault: true, threadId }),
    ), "Thread Google account updated.");
  }

  async updateGoogleAccountMode(connectionId: string, useMode: string): Promise<void> {
    if (!["available", "explicit_only"].includes(useMode)) return;
    await this.performConnectorAction(`gmail-mode-${connectionId}`, () => firstValueFrom(
      this.api.updateGoogleWorkspaceAccount(connectionId, { useMode }),
    ), "Google account usage updated.");
  }

  async deleteGoogleAccount(connectionId: string): Promise<void> {
    await this.performConnectorAction(`gmail-delete-${connectionId}`, () => firstValueFrom(
      this.api.deleteGoogleWorkspaceAccount(connectionId),
    ), "Google account removed.");
  }

  async startOutlook(): Promise<void> {
    await this.performConnectorAction("outlook", () => firstValueFrom(
      this.api.startOutlookOAuth(this.outlookAccount),
    ), "", true, (result) => {
      this.outlookAuth = result;
      this.notice = this.outlookAuth.userCode ? "Outlook sign-in ready." : "Outlook sign-in started.";
    });
  }

  private async performConnectorAction<T>(
    action: string,
    request: () => Promise<T>,
    notice: string,
    reload = true,
    onSuccess: (result: T) => void = () => {},
  ): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = action;
    this.renderNow();
    try {
      onSuccess(await request());
      if (notice) this.notice = notice;
      this.error = "";
      if (reload) await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
      this.renderNow();
    }
  }

  actionDisabled(id: string): boolean {
    return this.busy || Boolean(this.actionBusy && this.actionBusy !== id);
  }

  currentUserLabel(): string {
    return String(
      this.currentUser?.displayName ||
        this.currentUser?.id ||
        this.routeQueryParam("user_id") ||
        this.routeQueryParam("user") ||
        (this.busy ? "Loading user" : "User"),
    );
  }

  loginOnly(): boolean {
    return Boolean(this.routeConnectorId());
  }

  loginTitle(): string {
    const active = this.routeConnectorId();
    return active === "gmail" ? "Connect Gmail" : active ? `Connect ${this.connectorLabel(active)}` : "Connect Account";
  }

  connectorIntentActive(): boolean {
    return this.loginOnly() && this.routeConnectorId() === "gmail";
  }

  connectorIntentMethod(): string {
    return this.routeQueryParam("mcp") || "tools/call";
  }

  connectorIntentTool(): string {
    return this.routeQueryParam("tool") || "orkestr_auth";
  }

  connectorIntentProvider(): string {
    return this.routeQueryParam("provider") || "google_workspace";
  }

  connectorIntentAction(): string {
    return this.routeQueryParam("action") || "connect";
  }

  connectorIntentServiceLabel(): string {
    return this.connectorLabel(this.connectorIntentService());
  }

  connectorIntentTargetInstanceId(): string {
    return this.routeQueryParam("instance_id") || this.routeInstanceId() || "current";
  }

  connectorIntentAccountLabel(): string {
    return this.routeQueryParam("account") || this.connectedAccount(this.connectorStatus("gmail")) || "Choose during Google sign-in";
  }

  connectorIntentUserLabel(): string {
    return this.routeQueryParam("user_id") || this.routeQueryParam("user") || this.currentUserLabel();
  }

  connectorIntentThreadLabel(): string {
    return this.routeQueryParam("thread") || this.routeQueryParam("thread_id") || "";
  }

  connectorIntentThreadId(): string {
    return this.routeQueryParam("thread_id") || this.routeQueryParam("thread") || "";
  }

  routeConnectorId(): string {
    const parts = this.locationPathParts();
    const candidate = parts[0] === "connectors" ? String(parts[1] || "").toLowerCase() : "";
    return this.connectorOrder.includes(candidate) ? candidate : "";
  }

  deskPath(): string {
    return this.appPath("/desk");
  }

  private connectorIntentService(): string {
    return this.routeQueryParam("service") || this.routeConnectorId() || "gmail";
  }

  private routeQueryParam(name: string): string {
    return new URLSearchParams(globalThis.location?.search || "").get(name) || "";
  }

  private routeInstanceId(): string {
    const baseParts = this.appBasePath().split("/").filter(Boolean);
    const baseCandidate = baseParts[0] === "i" && baseParts[2] === "app" ? baseParts[1] : "";
    if (baseCandidate) return this.decodePathSegment(baseCandidate);
    const pathParts = (globalThis.location?.pathname || "").split("/").filter(Boolean);
    const pathCandidate = pathParts[0] === "i" && pathParts[2] === "app" ? pathParts[1] : "";
    return pathCandidate ? this.decodePathSegment(pathCandidate) : "";
  }

  private decodePathSegment(value = ""): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
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

  private detailString(connector: ConnectorStatus, key: string): string {
    const details = connector.details || {};
    const value = details[key];
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  }

  private detailStringArray(connector: ConnectorStatus, key: string): string[] {
    const details = connector.details || {};
    const value = details[key];
    return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
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

  private renderNow(): void {
    if (this.destroyed || this.renderQueued) return;
    this.renderQueued = true;
    const run = () => {
      this.renderQueued = false;
      if (this.destroyed) return;
      this.cdr.detectChanges();
    };
    if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(run);
    else void Promise.resolve().then(run);
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
