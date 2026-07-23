import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import {
  ApiService,
  GmailNotificationRule,
  GoogleWorkspaceConnection,
  ThreadSummary,
} from "./api.service";
import { GmailBrowserNotificationService } from "./gmail-browser-notification.service";

@Component({
  selector: "ork-gmail-notifications-panel",
  imports: [FormsModule],
  templateUrl: "./gmail-notifications-panel.component.html",
  styleUrls: ["./gmail-notifications-panel.component.css"],
})
export class GmailNotificationsPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  readonly browserNotifications = inject(GmailBrowserNotificationService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller: ReturnType<typeof setInterval> | null = null;

  @Input() accounts: GoogleWorkspaceConnection[] = [];
  @Input() initialThreadId = "";

  rules: GmailNotificationRule[] = [];
  threads: ThreadSummary[] = [];
  account = "";
  target = "";
  query = "is:unread newer_than:1d";
  every = "5m";
  label = "Gmail signals";
  busy = "";
  error = "";
  notice = "";

  ngOnInit(): void {
    void this.load();
    this.poller = setInterval(() => void this.load(false), 30_000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  async load(showBusy = true): Promise<void> {
    if (showBusy) this.busy = "load";
    try {
      const [rules, threads] = await Promise.all([
        firstValueFrom(this.api.gmailNotifications()),
        firstValueFrom(this.api.threads()),
      ]);
      this.rules = rules.notifications || [];
      this.threads = threads.threads || [];
      if (!this.account) this.account = this.defaultAccount();
      if (!this.target) this.target = this.initialThreadId || this.threads[0]?.id || "";
      this.error = "";
      await this.browserNotifications.sync(this.rules);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (showBusy) this.busy = "";
      this.cdr.detectChanges();
    }
  }

  async create(): Promise<void> {
    if (!this.account || !this.target || !this.query.trim() || !this.every.trim()) return;
    await this.mutate("create", async () => {
      await firstValueFrom(this.api.createGmailNotification({
        label: this.label.trim() || "Gmail signals",
        account: this.account,
        query: this.query.trim(),
        every: this.every.trim(),
        targetType: "thread",
        target: this.target,
        deliveryMode: "notification",
        maxItemsPerRun: 3,
      }));
      this.notice = "Gmail notification rule created.";
    });
  }

  async toggle(rule: GmailNotificationRule): Promise<void> {
    await this.mutate(`toggle-${rule.id}`, async () => {
      await firstValueFrom(this.api.updateGmailNotification(rule.id, { enabled: !rule.enabled }));
      this.notice = rule.enabled ? "Gmail notification paused." : "Gmail notification enabled.";
    });
  }

  async run(rule: GmailNotificationRule): Promise<void> {
    await this.mutate(`run-${rule.id}`, async () => {
      const result = await firstValueFrom(this.api.runGmailNotification(rule.id));
      this.notice = `Gmail check complete: ${(result.delivered || []).length} delivered.`;
    });
  }

  async remove(rule: GmailNotificationRule): Promise<void> {
    await this.mutate(`delete-${rule.id}`, async () => {
      await firstValueFrom(this.api.deleteGmailNotification(rule.id));
      this.notice = "Gmail notification deleted.";
    });
  }

  async enableBrowserNotifications(): Promise<void> {
    this.busy = "browser";
    try {
      const permission = await this.browserNotifications.requestPermission();
      this.notice = permission === "granted"
        ? "Browser notifications enabled."
        : permission === "denied"
          ? "Browser notifications are blocked in this browser."
          : "Browser notifications are unavailable.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = "";
      this.cdr.detectChanges();
    }
  }

  accountLabel(account: GoogleWorkspaceConnection): string {
    return String(account.alias || account.email || account.connectionId);
  }

  threadLabel(thread: ThreadSummary): string {
    return String(thread.name || thread.title || thread.id);
  }

  browserPermissionLabel(): string {
    const permission = this.browserNotifications.permission();
    if (permission === "granted") return "Browser alerts on";
    if (permission === "denied") return "Browser alerts blocked";
    if (permission === "unsupported") return "Browser alerts unavailable";
    return "Enable browser alerts";
  }

  dateLabel(value = ""): string {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
  }

  private defaultAccount(): string {
    const readable = this.accounts.find((candidate) => (candidate.capabilities || []).includes("gmail_read"));
    return String(readable?.email || "");
  }

  private async mutate(id: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = id;
    this.error = "";
    this.notice = "";
    this.cdr.detectChanges();
    try {
      await action();
      await this.load(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = "";
      this.cdr.detectChanges();
    }
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
    }
    return String(error || "Gmail notification action failed.");
  }
}
