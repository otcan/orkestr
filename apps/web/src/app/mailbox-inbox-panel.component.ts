import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, MailboxInboxMessage, MailboxRecord, ThreadSummary } from "./api.service";

@Component({
  selector: "ork-mailbox-inbox-panel",
  imports: [DatePipe, FormsModule],
  templateUrl: "./mailbox-inbox-panel.component.html",
})
export class MailboxInboxPanelComponent implements OnInit {
  private readonly api = inject(ApiService);

  mailboxes: MailboxRecord[] = [];
  threads: ThreadSummary[] = [];
  messages: MailboxInboxMessage[] = [];
  selectedMailboxId = "";
  selectedThreadId = "";
  nextCursor: string | null = null;
  busy = false;
  loadingMessages = false;
  error = "";
  notice = "";

  ngOnInit(): void { void this.load(); }

  mainMailboxes(): MailboxRecord[] {
    return this.mailboxes.filter((mailbox) => mailbox.target?.type === "main");
  }

  selectedMailbox(): MailboxRecord | null {
    return this.mailboxes.find((mailbox) => mailbox.id === this.selectedMailboxId) || null;
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [mailboxes, threads] = await Promise.all([
        firstValueFrom(this.api.mailboxes()),
        firstValueFrom(this.api.threads({ includeAllUsers: true })),
      ]);
      this.mailboxes = mailboxes.mailboxes || [];
      this.threads = threads.threads || [];
      const available = this.mainMailboxes();
      if (!available.some((mailbox) => mailbox.id === this.selectedMailboxId)) this.selectedMailboxId = available[0]?.id || "";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  resetInbox(): void {
    this.messages = [];
    this.nextCursor = null;
    this.notice = "";
    this.error = "";
  }

  async loadMessages(more = false): Promise<void> {
    if (this.loadingMessages || !this.selectedMailboxId || !this.selectedThreadId) return;
    this.loadingMessages = true;
    try {
      const result = await firstValueFrom(this.api.mailboxMessages(this.selectedMailboxId, this.selectedThreadId, more ? this.nextCursor || "" : ""));
      this.messages = more ? [...this.messages, ...(result.messages || [])] : (result.messages || []);
      this.nextCursor = result.nextCursor || null;
      this.notice = result.shadowDenied ? "Mailbox policy is in shadow mode; message content remains redacted." : this.messages.length ? "Managed mailbox content loaded without opening or waking the thread." : "No retained messages for this mailbox.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
      this.notice = "";
    } finally {
      this.loadingMessages = false;
    }
  }

  threadLabel(thread: ThreadSummary): string {
    return `${thread.name || thread.id} · ${thread.id}`;
  }

  private errorText(error: unknown): string {
    const value = error as { error?: { error?: string; message?: string } | string; message?: string };
    const detail = typeof value?.error === "string" ? value.error : value?.error?.message || value?.error?.error;
    return String(detail || value?.message || "Mailbox inbox request failed.");
  }
}
