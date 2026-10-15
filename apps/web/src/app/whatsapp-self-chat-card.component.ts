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
    @if (readyAccounts().length) {
      <div class="wa-self-chat notice">
        @if (isHomeThread()) {
          <strong>Message yourself talks to this thread.</strong>
        } @else if (freeAccount(); as account) {
          <strong>Talk to this thread in WhatsApp</strong>
          <span>Use your own "Message yourself" chat on {{ account.phoneNumber || "your linked number" }}. Nobody else is added.</span>
          <div class="button-row">
            <button type="button" (click)="connect(account)" [disabled]="busy">{{ busy ? "Connecting" : "Use my Message yourself chat" }}</button>
          </div>
        } @else if (homeThread(); as home) {
          <strong>Reach this thread from your Message yourself chat.</strong>
          <span>That chat talks to {{ home.name || home.id }}. Write <code>&#64;{{ address() }} your message</code> there, or <code>/switch {{ address() }}</code>.</span>
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

  readyAccounts(): WhatsAppAccount[] {
    return this.accounts.filter((account) => (account.ready === true || account.state === "ready") && String(account.contactId || "").endsWith("@c.us"));
  }

  // The home thread of one linked number: bound to that number's own chat.
  private homeFor(account: WhatsAppAccount): ThreadSummary | null {
    return this.threads.find((thread) => this.binding(thread)["privateOwnerChat"] === true && this.binding(thread)["chatId"] === account.contactId) || null;
  }

  isHomeThread(): boolean {
    return this.binding(this.thread)["privateOwnerChat"] === true;
  }

  // A linked number whose Message yourself chat is still free.
  freeAccount(): WhatsAppAccount | null {
    return this.readyAccounts().find((account) => !this.homeFor(account)) || null;
  }

  homeThread(): ThreadSummary | null {
    for (const account of this.readyAccounts()) {
      const home = this.homeFor(account);
      if (home) return home;
    }
    return null;
  }

  // What to type after @ or /switch: the router takes one word (name or id).
  address(): string {
    const name = String(this.thread?.name || "").trim();
    return /^[A-Za-z0-9][\w.-]*$/.test(name) ? name : String(this.thread?.id || "");
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
