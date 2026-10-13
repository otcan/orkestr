import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, WhatsAppAccount } from "./api.service";

// Pairs the built-in WhatsApp bridge on this server by QR code (self-hosted
// mode). The session stays on this server; nothing here talks to an
// Orkestr-hosted service.
@Component({
  selector: "ork-whatsapp-pair-panel",
  styles: [`
    .whatsapp-pair-panel { display: grid; gap: 8px; justify-items: start; margin: 12px 0; }
    .whatsapp-pair-qr { width: 240px; height: 240px; background: #fff; padding: 8px; border-radius: 8px; }
    .whatsapp-pair-state, .hint, .error, .slow { margin: 0; }
    .slow { color: #765100; }
    .error { color: #a2301f; }
  `],
  template: `
    <div class="whatsapp-pair-panel" aria-live="polite">
      <p class="whatsapp-pair-state"><strong>WhatsApp:</strong> {{ stateLabel() }}</p>
      @if (qrUrl()) {
        <img class="whatsapp-pair-qr" [src]="qrUrl()" width="240" height="240" alt="QR code to link WhatsApp to this server">
        <p class="hint">On your phone open WhatsApp → Settings → Linked devices → Link a device, then scan this code. The code renews itself every few seconds.</p>
      }
      @if (state() === "ready") {
        <p class="hint">Linked. Your WhatsApp session is saved on this server only and reconnects by itself after a restart.</p>
      }
      @if (slowHint()) {
        <p class="slow">{{ slowHint() }}</p>
      }
      @if (error) {
        <p class="error">{{ error }}</p>
      }
      @if (state() !== "ready") {
        <button [class.secondary]="startedOnce" type="button" (click)="start()" [disabled]="starting">
          {{ starting ? "Starting…" : startedOnce ? "Start over with a new QR code" : "Show QR code" }}
        </button>
      }
    </div>
  `,
})
export class WhatsAppPairPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() accountId = "account-1";
  @Output() readyChange = new EventEmitter<boolean>();
  // Stable identity captured at pairing: the runtime slot id and the linked WhatsApp contact id.
  @Output() pairedAccount = new EventEmitter<{ accountId: string; contactId: string } | null>();

  account: WhatsAppAccount | null = null;
  error = "";
  starting = false;
  startedOnce = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReady = false;
  private lastState = "";
  private stateSince = Date.now();

  ngOnInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2500);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  state(): string {
    return String(this.account?.state || "idle").toLowerCase();
  }

  stateLabel(): string {
    const labels: Record<string, string> = {
      idle: "not linked yet",
      starting: "getting a QR code ready…",
      qr_needed: "scan the QR code with your phone",
      authenticated: "linked, loading your chats (usually under a minute)…",
      ready: "linked and ready",
      disconnected: "disconnected. Start over to link again",
      auth_failure: "linking did not work. Start over with a new QR code",
      dependency_missing: "this installation cannot link WhatsApp (the WhatsApp component is missing)",
      failed: "could not start. Start over, or check the server log",
    };
    return labels[this.state()] || this.state().replace(/_/g, " ");
  }

  // Shown when a waiting state lasts longer than it normally does.
  slowHint(): string {
    const seconds = (Date.now() - this.stateSince) / 1000;
    const state = this.state();
    if (state === "starting" && seconds > 45) return "This is taking longer than usual. Start over, or check the server log for WhatsApp errors.";
    if (state === "authenticated" && seconds > 90) return "Still loading. Keep WhatsApp open on your phone with internet. If nothing changes in a few minutes, start over.";
    if (state === "qr_needed" && seconds > 180) return "Not scanned yet? On the phone: Settings → Linked devices → Link a device. The QR code here stays current.";
    return "";
  }

  qrUrl(): string {
    if (this.state() !== "qr_needed") return "";
    const url = String(this.account?.qrUrl || "");
    const updatedAt = String(this.account?.["updatedAt"] || "");
    if (!url || !updatedAt) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(updatedAt)}`;
  }

  async start(): Promise<void> {
    this.starting = true;
    this.error = "";
    try {
      await firstValueFrom(this.api.saveSetupDemoPreferences({ whatsappAccessMode: "self_hosted" }));
      await firstValueFrom(this.api.startWhatsAppAccount(this.accountId));
      this.startedOnce = true;
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.starting = false;
      this.cdr.markForCheck();
    }
  }

  private async refresh(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.whatsappStatus());
      // Once linked, the status reports the phone identity as accountId; the slot id stays in runtimeAccountId.
      this.account = (status.accounts || []).find((item) => [item.runtimeAccountId, item.accountId, item.id].includes(this.accountId) ||
        (item.legacyRoleAliases || []).includes(this.accountId)) || null;
      if (this.state() !== this.lastState) {
        this.lastState = this.state();
        this.stateSince = Date.now();
      }
      const error = String(this.account?.["error"] || "");
      if (error && this.state() !== "ready") this.error = error;
    } catch (error) {
      this.error = errorText(error);
    }
    this.cdr.markForCheck();
    const ready = this.state() === "ready";
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.readyChange.emit(ready);
      const contactId = String(this.account?.contactId || "");
      this.pairedAccount.emit(ready && contactId ? { accountId: this.accountId, contactId } : null);
    }
  }
}

function errorText(error: unknown): string {
  const value = error as { error?: { message?: string; error?: string }; message?: string };
  return value?.error?.message || value?.error?.error || value?.message || String(error);
}
