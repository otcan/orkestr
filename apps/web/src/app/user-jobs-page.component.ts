import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import {
  ApiService,
  CalendarExportResponse,
  JobAlertRoute,
  JobAlertRouteResponse,
  OrkestrMailDraft,
  ThreadSummary,
} from "./api.service";

@Component({
  selector: "ork-user-jobs-page",
  imports: [DatePipe, FormsModule],
  templateUrl: "./user-jobs-page.component.html",
})
export class UserJobsPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  actionBusy = "";
  error = "";
  notice = "";
  threads: ThreadSummary[] = [];
  routes: JobAlertRoute[] = [];
  inbound: JobAlertRouteResponse["inbound"] = {};
  drafts: OrkestrMailDraft[] = [];
  targetThreadId = "";
  draftTo = "";
  draftSubject = "";
  draftBody = "";
  calendarTitle = "";
  calendarStart = "";
  calendarEnd = "";
  calendarDescription = "";
  calendarLocation = "";
  calendarExport: CalendarExportResponse | null = null;

  ngOnInit(): void {
    this.setCalendarDefaults();
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [threads, routes, drafts] = await Promise.all([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.jobAlertRoutes()),
        firstValueFrom(this.api.orkestrMailDrafts()),
      ]);
      this.threads = threads.threads || [];
      this.routes = routes.routes || [];
      this.inbound = routes.inbound || {};
      this.drafts = this.sortDrafts(drafts.drafts || []);
      if (!this.targetThreadId && this.threads.length) this.targetThreadId = this.defaultThreadId();
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async createAlertAddress(rotate = false): Promise<void> {
    if (!this.targetThreadId || this.actionBusy) return;
    this.actionBusy = "alert-address";
    try {
      const result = await firstValueFrom(this.api.createJobAlertRoute({ targetThreadId: this.targetThreadId, rotate }));
      this.routes = this.upsertRoute(result.route);
      this.inbound = result.inbound || this.inbound;
      this.notice = result.created ? "Private job-alert address created." : "This thread already has a private job-alert address.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  async testAlertRoute(route: JobAlertRoute): Promise<void> {
    if (!route.id || this.actionBusy) return;
    this.actionBusy = `test-${route.id}`;
    try {
      const result = await firstValueFrom(this.api.testJobAlertRoute(route.id));
      this.routes = this.upsertRoute(result.route);
      this.notice = "Test job alert queued. It appears in the selected thread only as a passive Jobs signal.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  async createDraft(): Promise<void> {
    if (!this.draftTo.trim() || this.actionBusy) return;
    this.actionBusy = "draft-create";
    try {
      const result = await firstValueFrom(this.api.createOrkestrMailDraft({
        threadId: this.targetThreadId,
        to: this.draftTo,
        subject: this.draftSubject,
        body: this.draftBody,
      }));
      this.drafts = this.sortDrafts([result.draft, ...this.drafts]);
      this.draftTo = "";
      this.draftSubject = "";
      this.draftBody = "";
      this.notice = "Draft saved in Orkestr. Sending remains an explicit action.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  async sendDraft(draft: OrkestrMailDraft): Promise<void> {
    if (!draft.id || this.actionBusy || draft.status === "sent") return;
    this.actionBusy = `draft-send-${draft.id}`;
    try {
      const result = await firstValueFrom(this.api.sendOrkestrMailDraft(draft.id));
      this.drafts = this.sortDrafts(this.drafts.map((item) => item.id === result.draft.id ? result.draft : item));
      this.notice = result.ok ? "Email sent." : "Email was not sent. Review the draft status.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  async exportCalendar(): Promise<void> {
    if (!this.calendarTitle.trim() || !this.calendarStart || !this.calendarEnd || this.actionBusy) return;
    this.actionBusy = "calendar-export";
    try {
      this.calendarExport = await firstValueFrom(this.api.createCalendarExport({
        title: this.calendarTitle,
        startsAt: new Date(this.calendarStart).toISOString(),
        endsAt: new Date(this.calendarEnd).toISOString(),
        description: this.calendarDescription,
        location: this.calendarLocation,
      }));
      this.notice = "Calendar file prepared. Import it or review the event in Google Calendar before saving.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.actionBusy = "";
    }
  }

  downloadCalendar(): void {
    if (!this.calendarExport || typeof document === "undefined") return;
    const blob = new Blob([this.calendarExport.ics], { type: "text/calendar;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "orkestr-event.ics";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  routeThreadLabel(route: JobAlertRoute): string {
    return this.threadLabel(route.targetThreadId);
  }

  threadLabel(threadId: string): string {
    const thread = this.threads.find((item) => item.id === threadId);
    return thread?.name || thread?.title || threadId || "No thread";
  }

  relayStatus(): string {
    if (!this.inbound.configured) return "An administrator must configure a job-alert email domain before addresses can be created.";
    if (!this.inbound.relayConfigured) return "Addresses are ready, but the host still needs its relay token before inbound mail can be accepted.";
    return "Use this address directly in job boards, or forward only a dedicated Jobs label to it. Orkestr deduplicates deliveries and records a passive Jobs signal.";
  }

  draftStatusLabel(draft: OrkestrMailDraft): string {
    if (draft.status === "send_failed") return draft.lastError ? `Send failed: ${draft.lastError}` : "Send failed";
    return draft.status === "sent" ? "Sent" : "Draft";
  }

  private defaultThreadId(): string {
    const jobThread = this.threads.find((thread) => /\b(job|application|outreach)\b/i.test(`${thread.name || ""} ${thread.title || ""}`));
    return jobThread?.id || this.threads[0]?.id || "";
  }

  private upsertRoute(route: JobAlertRoute): JobAlertRoute[] {
    return [route, ...this.routes.filter((item) => item.id !== route.id)];
  }

  private sortDrafts(drafts: OrkestrMailDraft[]): OrkestrMailDraft[] {
    return [...drafts].sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
  }

  private setCalendarDefaults(): void {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    this.calendarStart = this.localDateTime(start);
    this.calendarEnd = this.localDateTime(end);
  }

  private localDateTime(value: Date): string {
    const offset = value.getTimezoneOffset() * 60_000;
    return new Date(value.getTime() - offset).toISOString().slice(0, 16);
  }

  private errorText(error: unknown): string {
    const candidate = error as { error?: { error?: unknown; message?: unknown }; message?: unknown };
    return String(candidate?.error?.error || candidate?.error?.message || candidate?.message || error || "Request failed");
  }
}
