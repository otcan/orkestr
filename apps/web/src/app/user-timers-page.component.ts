import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, ThreadSummary, TimerRecord } from "./api.service";

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
  timers: TimerRecord[] = [];
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
      const [threads, timers] = await Promise.all([
        firstValueFrom(this.api.threads()),
        firstValueFrom(this.api.timers()),
      ]);
      this.threads = threads.threads || [];
      this.timers = timers.timers || [];
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
      const body: Record<string, string> = {
        label: this.timerLabel.trim() || "Thread timer",
        cadence: this.timerCadence,
        prompt,
        targetType: "thread",
        target: this.targetThreadId,
      };
      if (this.timerCadence === "interval") body["every"] = this.timerTime.trim() || "1d";
      else body["time"] = this.timerTime.trim() || "09:00";
      const payload = await firstValueFrom(this.api.createTimer(body));
      if (payload.timer) this.timers = this.upsertTimer(payload.timer);
      this.timerPrompt = "";
      this.notice = "Timer added.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async runTimer(timer: TimerRecord): Promise<void> {
    if (!timer.id || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.runTimer(timer.id));
      this.notice = "Timer queued.";
      this.error = "";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async deleteTimer(timer: TimerRecord): Promise<void> {
    if (!timer.id || this.busy) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.deleteTimer(timer.id));
      this.timers = this.timers.filter((item) => item.id !== timer.id);
      this.notice = "Timer deleted.";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  targetLabel(timer: TimerRecord): string {
    const target = String(timer.target || timer.threadId || "");
    return this.threads.find((thread) => thread.id === target || thread.name === target)?.name || target || "Chat";
  }

  timerTimeLabel(timer: TimerRecord): string {
    if (timer.cadence === "interval") return String(timer.every || "interval");
    return String(timer.time || "09:00");
  }

  private upsertTimer(timer: TimerRecord): TimerRecord[] {
    return [...this.timers.filter((item) => item.id !== timer.id), timer]
      .sort((left, right) => Date.parse(String(left.nextRunAt || "")) - Date.parse(String(right.nextRunAt || "")));
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
