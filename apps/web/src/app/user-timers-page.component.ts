import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, AutomationRecord, ThreadSummary } from "./api.service";

@Component({
  selector: "ork-user-timers-page",
  imports: [DatePipe, FormsModule],
  templateUrl: "./user-timers-page.component.html",
})
export class UserTimersPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  error = "";
  notice = "";
  automations: AutomationRecord[] = [];
  threads: ThreadSummary[] = [];
  targetThreadId = "";
  timerLabel = "Thread timer";
  timerCadence = "daily";
  timerTime = "09:00";
  timerPrompt = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [threads, automations] = await Promise.all([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.automations()),
      ]);
      this.threads = threads.threads || [];
      this.automations = this.sortAutomations(automations.automations || []);
      if (!this.targetThreadId && this.threads[0]) this.targetThreadId = this.threads[0].id;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async createTimer(): Promise<void> {
    const prompt = this.timerPrompt.trim();
    if (!prompt || !this.targetThreadId || this.busy) return;
    this.busy = true;
    try {
      const body: Record<string, unknown> = {
        type: "timer",
        label: this.timerLabel.trim() || "Thread timer",
        cadence: this.timerCadence,
        prompt,
        targetType: "thread",
        target: this.targetThreadId,
      };
      if (this.timerCadence === "interval") body["every"] = this.timerTime.trim() || "1d";
      else body["time"] = this.timerTime.trim() || "09:00";
      const payload = await firstValueFrom(this.api.createAutomation(body));
      if (payload.automation) this.automations = this.upsertAutomation(payload.automation);
      this.timerPrompt = "";
      this.notice = "Automation added.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async runAutomation(automation: AutomationRecord): Promise<void> {
    if (!automation.automationId || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.runAutomation(automation.automationId));
      this.notice = "Automation queued for one run.";
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async toggleAutomation(automation: AutomationRecord): Promise<void> {
    if (!automation.automationId || this.busy) return;
    this.busy = true;
    try {
      const payload = automation.enabled
        ? await firstValueFrom(this.api.pauseAutomation(automation.automationId))
        : await firstValueFrom(this.api.resumeAutomation(automation.automationId));
      if (payload.automation) this.automations = this.upsertAutomation(payload.automation);
      this.notice = automation.enabled ? "Automation paused." : "Automation resumed.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async deleteAutomation(automation: AutomationRecord): Promise<void> {
    if (!automation.automationId || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.deleteAutomation(automation.automationId));
      this.automations = this.automations.filter((item) => item.automationId !== automation.automationId);
      this.notice = "Automation deleted.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  targetLabel(automation: AutomationRecord): string {
    const target = String(automation.target || "");
    return this.threads.find((thread) => thread.id === target || thread.name === target)?.name || target || "Chat";
  }

  automationTypeLabel(automation: AutomationRecord): string {
    const type = String(automation.type || "").toLowerCase();
    if (type === "gmail_notification") return "Mail watch";
    if (type === "push" || type === "connector_push") return "Watcher";
    return "Timer";
  }

  automationScheduleLabel(automation: AutomationRecord): string {
    const schedule = automation.schedule || {};
    if (automation.type === "gmail_notification") return schedule.every || "watch";
    if (schedule.cadence === "interval") return schedule.every || "interval";
    if (schedule.cadence === "once") return schedule.runAt || "once";
    return [schedule.cadence || schedule.type || "scheduled", schedule.time || "", schedule.timezone || ""].filter(Boolean).join(" ");
  }

  automationNextLabel(automation: AutomationRecord): string {
    if (automation.enabled === false) return "Paused";
    const nextRunAt = String(automation.schedule?.nextRunAt || "");
    if (!nextRunAt) return "Not scheduled";
    return nextRunAt;
  }

  automationNextDisplay(automation: AutomationRecord): string {
    const label = this.automationNextLabel(automation);
    const ms = Date.parse(label);
    if (!Number.isFinite(ms)) return label;
    return new Date(ms).toLocaleString();
  }

  automationRequirementLabel(automation: AutomationRecord): string {
    const requirements = automation.requirements || {};
    const values = [
      requirements.connector ? `${requirements.connector} connector` : "",
      requirements.desktop ? `${requirements.desktop} desktop` : "",
    ].filter(Boolean);
    return values.join(" · ");
  }

  private upsertAutomation(automation: AutomationRecord): AutomationRecord[] {
    return this.sortAutomations([...this.automations.filter((item) => item.automationId !== automation.automationId), automation]);
  }

  private sortAutomations(automations: AutomationRecord[]): AutomationRecord[] {
    return [...automations].sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      const leftMs = Date.parse(String(left.schedule?.nextRunAt || ""));
      const rightMs = Date.parse(String(right.schedule?.nextRunAt || ""));
      const leftSort = Number.isFinite(leftMs) ? leftMs : Number.MAX_SAFE_INTEGER;
      const rightSort = Number.isFinite(rightMs) ? rightMs : Number.MAX_SAFE_INTEGER;
      return leftSort - rightSort || String(left.label || "").localeCompare(String(right.label || ""));
    });
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown; status?: unknown; statusText?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
      if (record.status) return `HTTP ${record.status}${record.statusText ? ` ${record.statusText}` : ""}`;
    }
    return String(error || "Unknown error");
  }
}
