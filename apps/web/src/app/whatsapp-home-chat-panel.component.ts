import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadSummary, WhatsAppAccount } from "./api.service";

function errorText(error: unknown): string {
  const body = (error as { error?: { error?: string; message?: string } })?.error;
  return String(body?.error || body?.message || (error as Error)?.message || error || "Request failed");
}

// Setup → WhatsApp: connect "Message yourself" to a thread after the first
// run, explain how to reach other threads from it, and (with a second linked
// number) give a thread its own WhatsApp chat.
@Component({
  selector: "ork-whatsapp-home-chat-panel",
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="whatsapp-home-chat" aria-label="Message yourself">
      @if (mode === "home") {
      @if (!ownerAccount()) {
        <p>Link your phone in step 1 first. Then your own "Message yourself" chat becomes the chat with your agent.</p>
      } @else if (homeThread(); as home) {
        <p><strong>Message yourself → {{ label(home) }}.</strong> Open WhatsApp, tap the new-chat button and pick <em>Message yourself</em> (your own name, marked "You"). What you write there goes to {{ label(home) }}.</p>
        <ul class="whatsapp-home-chat-help">
          <li><code>&#64;name message</code> sends one message to another thread.</li>
          <li><code>/switch name</code> keeps talking to that thread; <code>/switch</code> comes back.</li>
          <li><code>/threads</code> lists your threads. Replies from other threads start with <code>[name]</code>; reply to one to answer that thread.</li>
        </ul>
      } @else {
        <p>Pick the thread that answers in your "Message yourself" chat. Nobody else is added.</p>
        <div class="button-row">
          <select name="home-chat-thread" [(ngModel)]="selectedThreadId" [disabled]="busy" aria-label="Thread for Message yourself">
            @for (thread of bindableThreads(); track thread.id) { <option [value]="thread.id">{{ label(thread) }}</option> }
          </select>
          <button type="button" (click)="connectHomeChat()" [disabled]="busy || !selectedThreadId">Use Message yourself</button>
        </div>
      }
      }
      @if (mode === "advanced" && homeThread() && secondAccount()) {
        <div class="whatsapp-own-chat">
          <p>Give a busy thread its own WhatsApp chat: a group with you and your second number ({{ secondAccount()?.phoneNumber || "WhatsApp 2" }}). That thread then talks only in its own chat.</p>
          <div class="button-row">
            <select name="own-chat-thread" [(ngModel)]="ownChatThreadId" [disabled]="busy" aria-label="Thread for its own chat">
              @for (thread of ownChatCandidates(); track thread.id) { <option [value]="thread.id">{{ label(thread) }}</option> }
            </select>
            <button class="secondary" type="button" (click)="createOwnChat()" [disabled]="busy || !ownChatThreadId">Give it its own chat</button>
          </div>
        </div>
      }
      @if (notice) { <p class="notice" role="status">{{ notice }}</p> }
      @if (error) { <p class="notice error" role="alert">{{ error }}</p> }
    </section>
  `,
})
export class WhatsAppHomeChatPanelComponent implements OnInit, OnDestroy {
  // "home": Message yourself status and how-to. "advanced": separate chats.
  @Input() mode: "home" | "advanced" = "home";
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  threads: ThreadSummary[] = [];
  accounts: WhatsAppAccount[] = [];
  selectedThreadId = "";
  ownChatThreadId = "";
  busy = false;
  notice = "";
  error = "";

  private poller?: ReturnType<typeof setInterval>;

  // Linking happens on the same page (QR above), so keep the view current.
  ngOnInit(): void {
    void this.load();
    this.poller = setInterval(() => {
      if (!this.busy && globalThis.document?.visibilityState !== "hidden") void this.load();
    }, 4000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  label(thread: ThreadSummary): string {
    return String(thread.name || thread.id);
  }

  private binding(thread: ThreadSummary): Record<string, unknown> {
    const binding = (thread as unknown as { binding?: Record<string, unknown> }).binding;
    return binding && typeof binding === "object" ? binding : {};
  }

  private readyAccounts(): WhatsAppAccount[] {
    return this.accounts.filter((account) => (account.ready === true || account.state === "ready") && String(account.contactId || "").endsWith("@c.us"));
  }

  homeThread(): ThreadSummary | null {
    return this.threads.find((thread) => this.binding(thread)["privateOwnerChat"] === true) || null;
  }

  // The owner's own number: the account behind the home chat, else the first linked one.
  ownerAccount(): WhatsAppAccount | null {
    const ready = this.readyAccounts();
    const homeAccount = String(this.binding(this.homeThread() || ({} as ThreadSummary))["senderAccountId"] || "");
    return ready.find((account) => [account.runtimeAccountId, account.accountId, account.id].includes(homeAccount)) || ready[0] || null;
  }

  secondAccount(): WhatsAppAccount | null {
    const owner = this.ownerAccount();
    return this.readyAccounts().find((account) => account !== owner) || null;
  }

  bindableThreads(): ThreadSummary[] {
    return this.threads.filter((thread) => !String(this.binding(thread)["chatId"] || ""));
  }

  ownChatCandidates(): ThreadSummary[] {
    return this.bindableThreads();
  }

  private async load(): Promise<void> {
    try {
      const [threads, status] = await Promise.all([firstValueFrom(this.api.threads()), firstValueFrom(this.api.whatsappStatus())]);
      this.threads = threads.threads || [];
      this.accounts = status.accounts || [];
      const bindable = this.bindableThreads();
      const preferred = bindable.find((thread) => thread.id === "orkestr") || bindable[0];
      if (!this.selectedThreadId) this.selectedThreadId = preferred?.id || "";
      if (!this.ownChatThreadId) this.ownChatThreadId = bindable.find((thread) => thread.id !== this.homeThread()?.id)?.id || "";
    } catch (error) {
      this.error = errorText(error);
    }
    this.cdr.markForCheck();
  }

  async connectHomeChat(): Promise<void> {
    const account = this.ownerAccount();
    const thread = this.threads.find((item) => item.id === this.selectedThreadId);
    if (!account || !thread) return;
    await this.run(async () => {
      await firstValueFrom(this.api.connectWhatsAppPrivateChat({
        threadId: thread.id,
        name: this.label(thread),
        pairedAccountId: String(account.runtimeAccountId || account.accountId || account.id || ""),
        pairedContactId: String(account.contactId || ""),
      }));
      this.notice = `Message yourself now talks to ${this.label(thread)}.`;
    });
  }

  async createOwnChat(): Promise<void> {
    const owner = this.ownerAccount();
    const second = this.secondAccount();
    const thread = this.threads.find((item) => item.id === this.ownChatThreadId);
    if (!owner || !second || !thread) return;
    await this.run(async () => {
      // Only the owner's own number joins; the second number creates the group and answers in it.
      await firstValueFrom(this.api.createWhatsAppThreadGroup({
        threadId: thread.id,
        name: `orkestr · ${this.label(thread)}`,
        participantIds: [String(owner.contactId || "")],
        receivingAccountId: String(owner.runtimeAccountId || owner.accountId || ""),
        replyAccountId: String(second.runtimeAccountId || second.accountId || ""),
      }));
      this.notice = `${this.label(thread)} has its own WhatsApp chat now.`;
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.cdr.markForCheck();
    try {
      await action();
      await this.load();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
