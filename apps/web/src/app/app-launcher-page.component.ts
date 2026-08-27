import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { ApiService, LauncherApp } from "./api.service";

@Component({
  selector: "ork-app-launcher-page",
  imports: [DatePipe],
  templateUrl: "./app-launcher-page.component.html",
  styleUrl: "./app-launcher-page.component.css",
})
export class AppLauncherPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  error = "";
  apps: LauncherApp[] = [];
  counts: Record<string, number> = {};
  generatedAt = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const payload = await firstValueFrom(this.api.launcherApps(true).pipe(timeout({ first: 15_000 })));
      this.apps = payload.apps || [];
      this.counts = payload.counts || {};
      this.generatedAt = payload.generatedAt || "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  appHref(app: LauncherApp): string {
    const raw = String(app.url || "/");
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!raw.startsWith("/")) return "/";
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    if (parts[0] === "i" && parts[2] === "app") {
      return `/i/${parts[1]}/app${raw === "/" ? "/" : raw}`;
    }
    return raw;
  }

  appTarget(app: LauncherApp): string {
    if (app.external) return "_blank";
    return app.target === "_blank" ? "_blank" : "_self";
  }

  healthLabel(app: LauncherApp): string {
    const status = app.health?.status || "unknown";
    if (status === "ok") return "available";
    if (status === "error") return "needs attention";
    return "not checked";
  }

  healthClass(app: LauncherApp): string {
    const status = app.health?.status || "unknown";
    return `status-pill ${status === "error" ? "bad" : status === "ok" ? "live" : ""}`;
  }

  appDescription(app: LauncherApp): string {
    return app.description || `${this.titleCase(app.type || "app")} app`;
  }

  private titleCase(value: string): string {
    return String(value || "app")
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ");
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
