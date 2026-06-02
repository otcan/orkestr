import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, WaitlistEntry, WhatsAppAccount, WhatsAppStatusResponse } from "./api.service";

interface WaitlistStatusOption {
  value: string;
  label: string;
}

interface WaitlistApprovalDraft {
  connectionName: string;
  whatsappAccountId: string;
  senderAccountId: string;
  responderAccountId: string;
  outboundAccountId: string;
  chatId: string;
  actorUserId: string;
  adminNote: string;
  createWhatsAppGroup: boolean;
  sendFirstPrompt: boolean;
}

@Component({
  selector: "ork-ops-waitlist",
  imports: [DatePipe, FormsModule],
  templateUrl: "./ops-waitlist.component.html",
})
export class OpsWaitlistComponent implements OnInit {
  private readonly api = inject(ApiService);

  entries: WaitlistEntry[] = [];
  whatsapp: WhatsAppStatusResponse | null = null;
  statusFilter = "pending";
  selectedEntryId = "";
  busy = false;
  error = "";
  notice = "";
  savingReview = false;
  approvingId = "";
  reviewStatus = "contacted";
  reviewNote = "";
  approvalConfirmed = false;
  approvalDraft: WaitlistApprovalDraft = this.emptyApprovalDraft();

  readonly statusOptions: WaitlistStatusOption[] = [
    { value: "", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "contacted", label: "Contacted" },
    { value: "approved", label: "Approved" },
    { value: "paused", label: "Paused" },
    { value: "rejected", label: "Rejected" },
  ];

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [waitlist, whatsapp] = await Promise.all([
        firstValueFrom(this.api.waitlist("", 500)),
        firstValueFrom(this.api.whatsappStatus()).catch(() => null),
      ]);
      this.entries = waitlist.entries || [];
      this.whatsapp = whatsapp;
      const visible = this.visibleEntries();
      const selectedStillVisible = visible.some((entry) => entry.id === this.selectedEntryId);
      if (!selectedStillVisible) this.selectEntry(visible[0] || this.entries[0] || null);
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  setFilter(status: string): void {
    this.statusFilter = status;
    const visible = this.visibleEntries();
    if (!visible.some((entry) => entry.id === this.selectedEntryId)) this.selectEntry(visible[0] || null);
  }

  visibleEntries(): WaitlistEntry[] {
    const status = this.statusFilter.trim();
    return this.entries.filter((entry) => !status || entry.status === status);
  }

  statusCount(status: string): number {
    return this.entries.filter((entry) => !status || entry.status === status).length;
  }

  selectedEntry(): WaitlistEntry | null {
    return this.entries.find((entry) => entry.id === this.selectedEntryId) || this.visibleEntries()[0] || null;
  }

  selectEntry(entry: WaitlistEntry | null): void {
    this.selectedEntryId = entry?.id || "";
    this.notice = "";
    this.approvalConfirmed = false;
    this.reviewStatus = entry?.status && entry.status !== "approved" ? entry.status : "contacted";
    this.reviewNote = entry?.adminNote || "";
    this.approvalDraft = this.buildApprovalDraft(entry || null);
  }

  whatsappAccountOptions(): WhatsAppAccount[] {
    return Array.isArray(this.whatsapp?.accounts) ? this.whatsapp.accounts : [];
  }

  accountId(account: WhatsAppAccount): string {
    return String(account.accountId || account.id || "").trim();
  }

  accountLabel(account: WhatsAppAccount): string {
    const id = this.accountId(account);
    const label = String(account.label || account.name || id || "WhatsApp account").trim();
    const state = String(account.state || (account.ready ? "ready" : "") || "").trim();
    return state ? `${label} - ${state}` : label;
  }

  notificationLabel(entry: WaitlistEntry): string {
    const notification = entry.notification;
    if (!notification?.state) return "Email status unknown";
    if (notification.state === "sent") return "Admin email sent";
    if (notification.state === "failed") return `Admin email failed${notification.error ? `: ${notification.error}` : ""}`;
    if (notification.skippedReason === "waitlist_email_not_configured") return "Admin email not configured";
    return `Admin email ${notification.state}`;
  }

  notificationClass(entry: WaitlistEntry): string {
    const state = entry.notification?.state || "";
    if (state === "sent") return "ready";
    if (state === "failed") return "bad";
    return "";
  }

  statusClass(entry: WaitlistEntry): string {
    if (entry.status === "approved" || entry.status === "contacted") return "ready";
    if (entry.status === "rejected") return "bad";
    return "";
  }

  async saveReview(entry: WaitlistEntry): Promise<void> {
    if (this.savingReview) return;
    this.savingReview = true;
    try {
      const result = await firstValueFrom(this.api.updateWaitlistEntry(entry.id, {
        status: this.reviewStatus,
        adminNote: this.reviewNote,
        reviewedBy: "admin",
      }));
      this.replaceEntry(result.entry);
      this.selectedEntryId = result.entry.id;
      this.notice = "Waitlist review saved.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingReview = false;
    }
  }

  canApprove(entry: WaitlistEntry): boolean {
    return Boolean(
      entry?.id &&
      entry.status !== "approved" &&
      this.approvalConfirmed &&
      this.approvalDraft.connectionName.trim() &&
      !this.approvingId,
    );
  }

  async approve(entry: WaitlistEntry): Promise<void> {
    if (!this.canApprove(entry)) return;
    this.approvingId = entry.id;
    try {
      const draft = this.approvalDraft;
      const result = await firstValueFrom(this.api.approveWaitlistEntry(entry.id, {
        connectionName: draft.connectionName,
        whatsappAccountId: draft.whatsappAccountId,
        senderAccountId: draft.senderAccountId || draft.whatsappAccountId,
        responderAccountId: draft.responderAccountId || draft.whatsappAccountId,
        outboundAccountId: draft.outboundAccountId || draft.responderAccountId || draft.whatsappAccountId,
        chatId: draft.chatId,
        actorUserId: draft.actorUserId || "admin",
        adminNote: draft.adminNote,
        createWhatsAppGroup: draft.createWhatsAppGroup,
        sendFirstPrompt: draft.sendFirstPrompt,
      }));
      if (result.entry) this.replaceEntry(result.entry);
      this.selectedEntryId = result.entry?.id || entry.id;
      this.approvalConfirmed = false;
      this.notice = result.whatsapp?.["pendingChatCreation"]
        ? "Approved. WhatsApp chat creation is still pending."
        : "Approved and onboarding was provisioned.";
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.approvingId = "";
    }
  }

  trackEntry(_: number, entry: WaitlistEntry): string {
    return entry.id;
  }

  private buildApprovalDraft(entry: WaitlistEntry | null): WaitlistApprovalDraft {
    const accountId = this.defaultWhatsAppAccountId();
    const name = String(entry?.displayName || entry?.phoneNumber || "New user").trim();
    return {
      connectionName: `${name} - Orkestr`.replace(/\s+/g, " ").trim(),
      whatsappAccountId: accountId,
      senderAccountId: accountId,
      responderAccountId: accountId,
      outboundAccountId: accountId,
      chatId: "",
      actorUserId: "admin",
      adminNote: entry?.adminNote || "",
      createWhatsAppGroup: true,
      sendFirstPrompt: true,
    };
  }

  private emptyApprovalDraft(): WaitlistApprovalDraft {
    return {
      connectionName: "",
      whatsappAccountId: "",
      senderAccountId: "",
      responderAccountId: "",
      outboundAccountId: "",
      chatId: "",
      actorUserId: "admin",
      adminNote: "",
      createWhatsAppGroup: true,
      sendFirstPrompt: true,
    };
  }

  private defaultWhatsAppAccountId(): string {
    const accounts = this.whatsappAccountOptions();
    const ready = accounts.find((account) => account.ready || String(account.state || "").toLowerCase() === "ready");
    return this.accountId(ready || accounts[0] || {});
  }

  private replaceEntry(entry: WaitlistEntry): void {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else this.entries = [entry, ...this.entries];
  }

  private errorText(error: unknown): string {
    if (typeof error === "string") return error;
    const maybe = error as { error?: { message?: string; error?: string }; message?: string };
    return maybe?.error?.message || maybe?.error?.error || maybe?.message || "Request failed.";
  }
}
