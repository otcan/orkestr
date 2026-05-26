import { DatePipe } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ThreadSummary, TimerRecord } from "./api.service";

type CapacityTone = "ok" | "warn" | "danger" | "unknown" | string;

@Component({
  selector: "ork-thread-management-panel",
  imports: [DatePipe],
  templateUrl: "./thread-management-panel.component.html",
  styleUrls: ["./thread-management-panel.component.css"],
})
export class ThreadManagementPanelComponent {
  @Input() thread: ThreadSummary | null = null;
  @Input() parentThread: ThreadSummary | null = null;
  @Input() workers: ThreadSummary[] = [];
  @Input() timers: TimerRecord[] = [];
  @Input() busy = false;
  @Input() codexReady = true;
  @Input() canWake = false;
  @Input() canSleep = false;
  @Input() canRecover = false;
  @Input() canStop = false;
  @Input() statusLabel = "Unknown";
  @Input() statusClass = "idle";
  @Input() branchLabel = "";
  @Input() workspaceLabel = "";
  @Input() gitLabel = "";
  @Input() modelName = "Syncing model";
  @Input() reasoningLabel = "default";
  @Input() modeLabel = "code";
  @Input() primaryRateLabel = "--";
  @Input() primaryRateFill = 0;
  @Input() primaryRateTone: CapacityTone = "unknown";
  @Input() secondaryRateLabel = "--";
  @Input() secondaryRateFill = 0;
  @Input() secondaryRateTone: CapacityTone = "unknown";
  @Input() contextLabel = "--";
  @Input() contextFill = 0;
  @Input() contextTone: CapacityTone = "unknown";

  @Output() wake = new EventEmitter<void>();
  @Output() sleep = new EventEmitter<void>();
  @Output() recover = new EventEmitter<void>();
  @Output() stop = new EventEmitter<void>();
  @Output() createWorker = new EventEmitter<void>();
  @Output() openThread = new EventEmitter<ThreadSummary>();
  @Output() openTimers = new EventEmitter<void>();
  @Output() openWorkers = new EventEmitter<void>();
  @Output() openSettings = new EventEmitter<void>();
  @Output() openDesktops = new EventEmitter<void>();
  @Output() openOps = new EventEmitter<void>();
  @Output() openRuntime = new EventEmitter<void>();
  @Output() openModelDetails = new EventEmitter<void>();

  workerTitle(worker: ThreadSummary): string {
    return String(worker.workerLabel || worker.bindingName || worker.name || worker.title || worker.id);
  }

  workerStatus(worker: ThreadSummary): string {
    return String(worker.publicStatus || worker.status || worker.state || "unknown").replace(/_/g, " ");
  }

  timerTitle(timer: TimerRecord): string {
    return String(timer.label || timer.id || "Timer");
  }

  timerCadence(timer: TimerRecord): string {
    return String(timer.cadence || timer.every || "scheduled").replace(/_/g, " ");
  }

  timerTrack(timer: TimerRecord): string {
    return String(timer.target || timer.threadId || "thread");
  }

  shownWorkers(): ThreadSummary[] {
    return this.workers.slice(0, 3);
  }

  shownTimers(): TimerRecord[] {
    return this.timers.slice(0, 2);
  }

  extraWorkerCount(): number {
    return Math.max(0, this.workers.length - this.shownWorkers().length);
  }

  extraTimerCount(): number {
    return Math.max(0, this.timers.length - this.shownTimers().length);
  }

  capacityToneClass(tone: CapacityTone): string {
    const value = String(tone || "unknown").toLowerCase();
    return value === "warn" || value === "danger" || value === "ok" ? value : "unknown";
  }

  meterFill(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(100, parsed));
  }

  hasWorkspaceContext(): boolean {
    return Boolean(this.branchLabel || this.workspaceLabel || this.gitLabel);
  }
}
