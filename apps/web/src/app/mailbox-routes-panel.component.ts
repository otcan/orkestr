import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, MailboxRecord, MailboxRoute, MailboxRouteStatus, ThreadSummary } from "./api.service";

type RouteMode = MailboxRoute["mode"];

@Component({
  selector: "ork-mailbox-routes-panel",
  imports: [DatePipe, FormsModule],
  templateUrl: "./mailbox-routes-panel.component.html",
})
export class MailboxRoutesPanelComponent implements OnInit {
  private readonly api = inject(ApiService);

  mailboxes: MailboxRecord[] = [];
  threads: ThreadSummary[] = [];
  routes: MailboxRoute[] = [];
  status: MailboxRouteStatus | null = null;
  selectedMailboxId = "";
  targetThreadId = "";
  mode: RouteMode = "append_only";
  busy = false;
  saving = false;
  error = "";
  notice = "";

  readonly routeModes: Array<{ value: RouteMode; label: string; help: string }> = [
    { value: "append_only", label: "Append only", help: "Store the normalized message in the destination thread without starting a turn." },
    { value: "process_immediately", label: "Process now", help: "Queue one passive, read-only turn only when the thread is idle." },
    { value: "context_next_turn", label: "Next human turn", help: "Hold normalized content until the next human request, then consume it once." },
  ];

  ngOnInit(): void {
    void this.load();
  }

  selectedMailbox(): MailboxRecord | null {
    return this.mailboxes.find((mailbox) => mailbox.id === this.selectedMailboxId) || null;
  }

  mainMailboxes(): MailboxRecord[] {
    return this.mailboxes.filter((mailbox) => mailbox.target?.type === "main");
  }

  modeHelp(): string {
    return this.routeModes.find((item) => item.value === this.mode)?.help || "";
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
      await this.loadRouteData();
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async selectMailbox(): Promise<void> {
    this.notice = "";
    this.error = "";
    await this.loadRouteData();
  }

  async createRoute(): Promise<void> {
    if (this.saving || !this.selectedMailboxId || !this.targetThreadId.trim()) return;
    this.saving = true;
    try {
      const result = await firstValueFrom(this.api.createMailboxRoute(this.selectedMailboxId, {
        threadId: this.targetThreadId.trim(),
        mode: this.mode,
      }));
      this.notice = result.idempotent ? "The requested route already exists." : "Mailbox route created.";
      this.targetThreadId = "";
      await this.loadRouteData();
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.saving = false;
    }
  }

  async revokeRoute(route: MailboxRoute): Promise<void> {
    if (this.saving || !this.selectedMailboxId) return;
    this.saving = true;
    try {
      await firstValueFrom(this.api.revokeMailboxRoute(this.selectedMailboxId, route.id, "revoked_from_ops"));
      this.notice = "Mailbox route revoked. Pending work and contexts were cancelled.";
      await this.loadRouteData();
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.saving = false;
    }
  }

  threadLabel(threadId: string): string {
    const thread = this.threads.find((item) => item.id === threadId);
    return thread ? `${thread.name || thread.id} · ${thread.id}` : threadId;
  }

  private async loadRouteData(): Promise<void> {
    if (!this.selectedMailboxId) {
      this.routes = [];
      this.status = null;
      return;
    }
    const [routes, status] = await Promise.all([
      firstValueFrom(this.api.mailboxRoutes(this.selectedMailboxId)),
      firstValueFrom(this.api.mailboxRouteStatus(this.selectedMailboxId)),
    ]);
    this.routes = routes.routes || [];
    this.status = status.status || null;
  }

  private errorText(error: unknown): string {
    const value = error as { error?: { message?: string }; message?: string };
    return String(value?.error?.message || value?.message || "Mailbox route request failed.");
  }
}
