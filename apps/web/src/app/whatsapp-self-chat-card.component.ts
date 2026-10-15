import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadSummary, WhatsAppAccount } from "./api.service";

// Thread settings → WhatsApp, for a thread without a chat: the simple path
// is the owner's own "Message yourself" chat (one per number). If another
// thread already has it, explain how to reach this one from there.
@Component({
  selector: "ork-whatsapp-self-chat-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ownerAccount(); as account) {
      <div class="wa-self-chat notice">
        @if (homeThread(); as home) {
          @if (home.id === thread?.id) {
            <strong>Message yourself talks to this thread.</strong>
          } @else {
            <strong>Reach this thread from your Message yourself chat.</strong>
            <span>That chat talks to {{ home.name || home.id }}. Write <code>&#64;{{ thread?.name || thread?.id }} your message</code> there, or <code>/switch {{ thread?.name || thread?.id }}</code>.</span>
          }
        } @else {
          <strong>Talk to this thread in WhatsApp</strong>
          <span>Use your own "Message yourself" chat on {{ account.phoneNumber || "your linked number" }}. Nobody else is added.</span>
          <div class="button-row">
            <button type="button" (click)="connect(account)" [disabled]="busy">{{ busy ? "Connecting" : "Use my Message yourself chat" }}</button>
          </div>
        }
        @if (error) { <small role="alert">{{ error }}</small> }
      </div>
    }
  `,
})
export class WhatsAppSelfChatCardComponent implements OnChanges {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() thread: ThreadSummary | null = null;
  @Input() threads: ThreadSummary[] = [];
  @Output() connected = new EventEmitter<void>();

  accounts: WhatsAppAccount[] = [];
  busy = false;
  error = "";

  ngOnChanges(): void {
    void this.loadAccounts();
  }

  private async loadAccounts(): Promise<void> {
    try {
      this.accounts = (await firstValueFrom(this.api.whatsappStatus())).accounts || [];
    } catch {
      this.accounts = [];
    }
    this.cdr.markForCheck();
  }

  private binding(thread: ThreadSummary | null): Record<string, unknown> {
    const binding = (thread as unknown as { binding?: Record<string, unknown> } | null)?.binding;
    return binding && typeof binding === "object" ? binding : {};
  }

  homeThread(): ThreadSummary | null {
    return this.threads.find((thread) => this.binding(thread)["privateOwnerChat"] === true) || null;
  }

  ownerAccount(): WhatsAppAccount | null {
    return this.accounts.find((account) => (account.ready === true || account.state === "ready") && String(account.contactId || "").endsWith("@c.us")) || null;
  }

  async connect(account: WhatsAppAccount): Promise<void> {
    if (!this.thread) return;
    this.busy = true;
    this.error = "";
    this.cdr.markForCheck();
    try {
      await firstValueFrom(this.api.connectWhatsAppPrivateChat({
        threadId: this.thread.id,
        name: String(this.thread.name || this.thread.id),
        pairedAccountId: String(account.runtimeAccountId || account.accountId || account.id || ""),
        pairedContactId: String(account.contactId || ""),
      }));
      this.connected.emit();
    } catch (error) {
      const body = (error as { error?: { error?: string } })?.error;
      this.error = String(body?.error || (error as Error)?.message || "Could not connect the chat.");
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
