import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { copyText } from "./browser-compat";
import { firstValueFrom } from "rxjs";
import { ApiService, ConnectorStatus, SetupStatus } from "./api.service";
import { codexCommandAvailable, codexCommandUnavailableHint } from "./codex-runtime-status";

// Signs Codex in on this server with a ChatGPT device code, in place, so the
// first-run wizard does not have to send the user to the setup page.
@Component({
  selector: "ork-codex-sign-in-panel",
  styles: [`
    .codex-sign-in-panel { display: grid; gap: 8px; justify-items: start; margin: 8px 0; }
    .codex-sign-in-panel p { margin: 0; }
    .codex-device-code { font-family: ui-monospace, monospace; font-size: 1.4rem; font-weight: 800; letter-spacing: 0.12em; }
    .error { color: #ff9a9a; }
  `],
  template: `
    <div class="codex-sign-in-panel" aria-live="polite">
      @if (deviceCode) {
        <p>1. Open the ChatGPT sign-in page{{ authUrl ? "" : " (it should have opened in a new tab)" }}.</p>
        @if (authUrl) {
          <a class="button secondary" [href]="authUrl" target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a>
        }
        <p>2. Enter this code there:</p>
        <button class="codex-device-code secondary" type="button" (click)="copyCode()" [attr.aria-label]="'Copy Codex device code ' + deviceCode">{{ deviceCode }}</button>
        <p class="hint">{{ copied ? "Code copied." : "Click the code to copy it." }} This page continues by itself once you are signed in.</p>
      } @else {
        <p class="hint">Sign-in uses a one-time code. First allow device-code sign-in in ChatGPT → Settings → Security.</p>
        <button type="button" (click)="start()" [disabled]="busy || !commandAvailable()">{{ busy ? "Starting…" : "Open Codex sign-in" }}</button>
      }
      @if (error) {
        <p class="error">{{ error }}</p>
      }
    </div>
  `,
})
export class CodexSignInPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() setupStatus: SetupStatus | null = null;
  @Input() autoStart = false;
  @Input() openAuthPageOnStart = true;
  @Output() connected = new EventEmitter<SetupStatus>();

  deviceCode = "";
  authUrl = "";
  copied = false;
  busy = false;
  error = "";
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;

  ngOnInit(): void {
    if (this.autoStart && this.commandAvailable()) void this.start();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPolling();
  }

  connector(): ConnectorStatus | null {
    return this.setupStatus?.connectors?.find((item) => item.id === "codex") || null;
  }

  commandAvailable(): boolean {
    return codexCommandAvailable(this.connector());
  }

  async start(): Promise<void> {
    if (!this.commandAvailable()) {
      this.error = codexCommandUnavailableHint(this.connector());
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      const result = await firstValueFrom(this.api.startCodexDeviceAuth());
      // Closed while the request was in flight: do not start polling.
      if (this.destroyed) return;
      this.deviceCode = result.code || "";
      this.authUrl = result.authUrl || "";
      this.copied = false;
      if (this.openAuthPageOnStart && this.authUrl) globalThis.open?.(this.authUrl, "_blank", "noopener,noreferrer");
      this.startPolling(result.expiresAt || "");
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async copyCode(): Promise<void> {
    this.copied = await copyText(this.deviceCode);
    if (!this.copied) this.error = "Copying is blocked in this browser. Select the code and copy it by hand.";
    this.render();
  }

  private startPolling(expiresAt: string): void {
    this.stopPolling();
    if (this.destroyed) return;
    const expiresAtMs = Date.parse(expiresAt) || Date.now() + 15 * 60_000;
    const poll = async (): Promise<void> => {
      if (Date.now() > expiresAtMs) {
        this.stopPolling();
        this.deviceCode = "";
        this.authUrl = "";
        this.error = "The sign-in code expired. Open Codex sign-in again.";
        this.render();
        return;
      }
      try {
        const setup = await firstValueFrom(this.api.setupStatus());
        if (setup.connectors?.find((item) => item.id === "codex")?.state !== "connected") return;
        this.stopPolling();
        this.deviceCode = "";
        this.authUrl = "";
        this.connected.emit(setup);
      } catch {
        // Keep polling; the server may be busy.
      }
      this.render();
    };
    this.poller = setInterval(() => void poll(), 5_000);
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  private render(): void {
    if (!this.destroyed) this.cdr.markForCheck();
  }
}

function errorText(error: unknown): string {
  const value = error as { error?: { message?: string; error?: string }; message?: string };
  return value?.error?.message || value?.error?.error || value?.message || String(error);
}
