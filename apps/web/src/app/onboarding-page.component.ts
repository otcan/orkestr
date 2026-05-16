import { Component, EventEmitter, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, SetupStatus } from "./api.service";

type OnboardingStep = "openai" | "codex" | "gmail" | "linkedin" | "whatsapp";

@Component({
  selector: "ork-onboarding-page",
  imports: [FormsModule],
  templateUrl: "./onboarding-page.component.html",
  styleUrls: ["./onboarding-page.component.css"],
})
export class OnboardingPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private poller?: ReturnType<typeof setInterval>;

  @Output() skip = new EventEmitter<void>();
  @Output() complete = new EventEmitter<void>();

  setup: SetupStatus | null = null;
  busy = false;
  error = "";
  notice = "";
  oauthUrl = "";
  activeStep: OnboardingStep = "openai";

  openaiApiKey = "";
  gmailClientId = "";
  gmailClientSecret = "";
  gmailRedirectUri = "http://127.0.0.1:19812/oauth/gmail/callback";
  whatsappBridgeUrl = "http://127.0.0.1:8787";
  whatsappApiToken = "";
  private formHydrated = false;
  private stepInitialized = false;

  readonly steps: Array<{ id: OnboardingStep; label: string; eyebrow: string }> = [
    { id: "openai", label: "OpenAI", eyebrow: "Model access" },
    { id: "codex", label: "Codex", eyebrow: "Local agent" },
    { id: "gmail", label: "Gmail", eyebrow: "Inbox" },
    { id: "linkedin", label: "LinkedIn", eyebrow: "Browser" },
    { id: "whatsapp", label: "WhatsApp", eyebrow: "Messages" },
  ];

  ngOnInit(): void {
    void this.load();
    this.poller = setInterval(() => void this.load(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  async load(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const setup = await firstValueFrom(this.api.setupStatus());
      this.setup = setup;
      this.hydrateForms(setup);
      if (!this.stepInitialized || this.stepDone(this.activeStep)) {
        this.activeStep = this.firstOpenStep();
        this.stepInitialized = true;
      }
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async saveOpenAI(): Promise<void> {
    const openaiApiKey = this.openaiApiKey.trim();
    if (!openaiApiKey) {
      this.error = "Paste an OpenAI API key before saving.";
      return;
    }
    await this.saveConnector("openai", { openaiApiKey }, "OpenAI settings saved.");
    this.openaiApiKey = "";
  }

  async saveGmail(): Promise<void> {
    const clientId = this.gmailClientId.trim();
    const clientSecret = this.gmailClientSecret.trim();
    const redirectUri = this.gmailRedirectUri.trim();
    if (!clientId || !redirectUri) {
      this.error = "Gmail needs a client ID and redirect URI.";
      return;
    }
    const body: Record<string, string> = { clientId, redirectUri };
    if (clientSecret) body["clientSecret"] = clientSecret;
    await this.saveConnector("gmail", body, "Gmail OAuth settings saved.");
    this.gmailClientSecret = "";
  }

  async startGmailOAuth(): Promise<void> {
    this.busy = true;
    try {
      const result = await firstValueFrom(this.api.startGmailOAuth());
      this.oauthUrl = result.authorizeUrl;
      globalThis.open?.(result.authorizeUrl, "_blank", "noopener,noreferrer");
      this.notice = "Google sign-in opened in a new tab.";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async prepareLinkedIn(): Promise<void> {
    await this.browserAction("prepare", "LinkedIn browser profile prepared.");
  }

  async openLinkedIn(): Promise<void> {
    await this.browserAction("start", "LinkedIn browser requested.");
  }

  async saveWhatsApp(): Promise<void> {
    const bridgeUrl = this.whatsappBridgeUrl.trim();
    if (!bridgeUrl) {
      this.error = "WhatsApp needs a bridge URL.";
      return;
    }
    const body: Record<string, string> = { bridgeUrl };
    const apiToken = this.whatsappApiToken.trim();
    if (apiToken) body["apiToken"] = apiToken;
    await this.saveConnector("whatsapp", body, "WhatsApp bridge settings saved.");
    this.whatsappApiToken = "";
  }

  connector(id: string): ConnectorStatus | null {
    return this.setup?.connectors?.find((connector) => connector.id === id) || null;
  }

  connectorDetail(id: string, key: string): string {
    const value = this.connector(id)?.details?.[key];
    return value === null || value === undefined ? "" : String(value);
  }

  stateLabel(id: string): string {
    return String(this.connector(id)?.state || "not_connected").replace(/_/g, " ");
  }

  stateClass(id: string): string {
    const state = String(this.connector(id)?.state || "").toLowerCase();
    if (state === "connected") return "ready";
    if (state === "partial") return "partial";
    if (state === "broken" || state === "failed") return "bad";
    return "idle";
  }

  stepDone(id: OnboardingStep): boolean {
    const state = this.connector(id)?.state;
    return state === "connected" || state === "partial";
  }

  setupReady(): boolean {
    return this.setup?.setupState === "ready";
  }

  qrUrl(): string {
    return String(this.connector("whatsapp")?.details?.["qrUrl"] || "");
  }

  qrAvailable(): boolean {
    return Boolean(this.qrUrl());
  }

  selectStep(id: OnboardingStep): void {
    this.activeStep = id;
    this.stepInitialized = true;
  }

  openApp(): void {
    if (this.setupReady()) this.complete.emit();
    else this.skip.emit();
  }

  private async saveConnector(id: string, body: Record<string, string>, message: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.saveConnectorConfig(id, body));
      this.notice = message;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private async browserAction(action: string, message: string): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.browserAction("linkedin", action));
      this.notice = message;
      this.error = "";
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private hydrateForms(setup: SetupStatus): void {
    if (this.formHydrated) return;
    const config = setup.config || {};
    const gmail = config["gmail"] || {};
    const whatsapp = config["whatsapp"] || {};
    if (!this.gmailClientId && gmail["clientId"]) this.gmailClientId = String(gmail["clientId"]);
    if (gmail["redirectUri"]) this.gmailRedirectUri = String(gmail["redirectUri"]);
    if (whatsapp["bridgeUrl"]) this.whatsappBridgeUrl = String(whatsapp["bridgeUrl"]);
    this.formHydrated = true;
  }

  private firstOpenStep(): OnboardingStep {
    return this.steps.find((step) => !this.stepDone(step.id))?.id || this.activeStep || "openai";
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }
}
