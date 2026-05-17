import { DatePipe } from "@angular/common";
import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { Agent, AgentTemplate, ApiService, ConnectorStatus, EventRecord, SetupStatus, TimerDoctorResponse, TimerRecord } from "./api.service";

export type ToolsView = "system" | "timers" | "desktops" | "models" | "settings" | "connectors";

@Component({
  selector: "ork-ops-page",
  imports: [DatePipe],
  templateUrl: "./ops-page.component.html",
})
export class OpsPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private poller?: ReturnType<typeof setInterval>;

  @Input() toolsView: ToolsView = "system";
  @Output() toolsViewChange = new EventEmitter<ToolsView>();

  busy = false;
  error = "";
  opsSetup: SetupStatus | null = null;
  opsVersion: Record<string, unknown> | null = null;
  opsWhatsApp: Record<string, unknown> | null = null;
  opsRuntimeBudget: Record<string, unknown> | null = null;
  opsConnectors: ConnectorStatus[] = [];
  opsAgents: Agent[] = [];
  opsAgentTemplates: AgentTemplate[] = [];
  opsTimers: TimerRecord[] = [];
  opsTimerDoctor: TimerDoctorResponse | null = null;
  opsEvents: EventRecord[] = [];
  opsBrowsers: Array<Record<string, unknown>> = [];
  opsRuntimeLeases: Array<Record<string, unknown>> = [];
  opsExecutors: Array<Record<string, unknown>> = [];
  opsExecutions: Array<Record<string, unknown>> = [];
  opsSystem: Record<string, unknown> | null = null;
  opsProcesses: Array<Record<string, unknown>> = [];
  opsModels: Record<string, unknown> | null = null;

  ngOnInit(): void {
    void this.loadOps();
    this.poller = setInterval(() => void this.loadOps(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  setToolsView(view: ToolsView): void {
    this.toolsView = view;
    this.toolsViewChange.emit(view);
  }

  async loadOps(showBusy = true): Promise<void> {
    if (showBusy) this.busy = true;
    try {
      const [version, setup, whatsapp, agents, templates, timers, timerDoctor, events, browsers, runtimeLeases, executors, executions, system, processes, models] = await Promise.allSettled([
        firstValueFrom(this.api.version()),
        firstValueFrom(this.api.setupStatus()),
        firstValueFrom(this.api.whatsappStatus()),
        firstValueFrom(this.api.agents()),
        firstValueFrom(this.api.agentTemplates()),
        firstValueFrom(this.api.timers()),
        firstValueFrom(this.api.timerDoctor()),
        firstValueFrom(this.api.events(40)),
        firstValueFrom(this.api.browserSessions()),
        firstValueFrom(this.api.runtimeLeases()),
        firstValueFrom(this.api.executors()),
        firstValueFrom(this.api.executions()),
        firstValueFrom(this.api.systemSummary()),
        firstValueFrom(this.api.systemProcesses("cpu")),
        firstValueFrom(this.api.modelStatus()),
      ]);
      if (version.status === "fulfilled") this.opsVersion = version.value;
      if (setup.status === "fulfilled") {
        this.opsSetup = setup.value;
        this.opsConnectors = setup.value.connectors || [];
      }
      if (whatsapp.status === "fulfilled") this.opsWhatsApp = whatsapp.value;
      if (agents.status === "fulfilled") this.opsAgents = agents.value.agents || [];
      if (templates.status === "fulfilled") this.opsAgentTemplates = templates.value.templates || [];
      if (timers.status === "fulfilled") this.opsTimers = timers.value.timers || [];
      if (timerDoctor.status === "fulfilled") this.opsTimerDoctor = timerDoctor.value;
      if (events.status === "fulfilled") this.opsEvents = events.value.events || [];
      if (browsers.status === "fulfilled") this.opsBrowsers = browsers.value.sessions || [];
      if (runtimeLeases.status === "fulfilled") {
        this.opsRuntimeLeases = runtimeLeases.value.leases || [];
        this.opsRuntimeBudget = runtimeLeases.value.budget || null;
      }
      if (executors.status === "fulfilled") this.opsExecutors = executors.value.executors || [];
      if (executions.status === "fulfilled") this.opsExecutions = executions.value.executions || [];
      if (system.status === "fulfilled") this.opsSystem = system.value;
      if (processes.status === "fulfilled") this.opsProcesses = processes.value.processes || [];
      if (models.status === "fulfilled") this.opsModels = models.value;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async browserAction(browser: Record<string, unknown>, action: string): Promise<void> {
    const slug = this.objectValue(browser, "slug") || this.objectValue(browser, "id");
    if (!slug) return;
    this.busy = true;
    try {
      await firstValueFrom(this.api.browserAction(slug, action));
      await this.loadOps(false);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
    return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
  }

  formatPercent(value: unknown): string {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return "--";
    return `${Math.round(percent)}%`;
  }

  numberValue(value: unknown, key: string): number {
    if (!value || typeof value !== "object") return 0;
    const parsed = Number((value as Record<string, unknown>)[key]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  numberPath(value: unknown, path: string): number {
    const raw = this.pathValue(value, path);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  objectPath(value: unknown, path: string): string {
    const raw = this.pathValue(value, path);
    if (raw === null || raw === undefined) return "";
    return String(raw);
  }

  objectValue(value: unknown, key: string): string {
    if (!value || typeof value !== "object") return "";
    return String((value as Record<string, unknown>)[key] || "");
  }

  systemCpuPercent(): number {
    return this.numberPath(this.opsSystem, "cpu.percent") || this.numberPath(this.opsSystem, "cpuPercent");
  }

  systemMemoryPercent(): number {
    return this.numberPath(this.opsSystem, "memory.percent");
  }

  systemLoadLabel(): string {
    const load = this.numberPath(this.opsSystem, "loadAverage.one");
    return Number.isFinite(load) ? `${Math.round(load * 10) / 10}` : "--";
  }

  runtimeLeasePercent(): number {
    const max = Number(this.objectValue(this.opsRuntimeBudget, "maxLiveThreads")) || 20;
    return Math.max(0, Math.min(100, (this.opsRuntimeLeases.length / max) * 100));
  }

  jsonLine(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value || "");
    }
  }

  eventKey(event: EventRecord): string {
    return `${event.ts || ""}:${event.type}:${this.jsonLine(event).slice(0, 120)}`;
  }

  private pathValue(value: unknown, path: string): unknown {
    let current = value;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
    return String(error || "Unknown error");
  }
}
