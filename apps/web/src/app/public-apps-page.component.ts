import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import {
  ApiService,
  LauncherApp,
  LauncherDirectoryWorkspace,
  PublicAppCard,
} from "./api.service";

@Component({
  selector: "ork-public-apps-page",
  templateUrl: "./public-apps-page.component.html",
  styleUrls: ["./public-apps-page.component.css"],
})
export class PublicAppsPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  apps: LauncherApp[] = [];
  workspaces: LauncherDirectoryWorkspace[] = [];
  selected: PublicAppCard | null = null;
  appUrl = "";
  openingWorkspaceId = "";
  workspaceError = "";
  busy = false;
  error = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const listing = await firstValueFrom(this.api.myLauncher().pipe(timeout({ first: 15_000 })));
      this.apps = listing.apps || [];
      this.workspaces = listing.workspaces || [];
      this.appUrl = listing.appUrl || "";
      const slug = this.slugFromPath();
      if (!slug) return;
      const resolved = await firstValueFrom(this.api.publicApp(slug));
      this.selected = resolved.app;
    } catch {
      // Authorization is intentionally indistinguishable from absence here.
      this.error = "This application is not available to your account.";
    } finally {
      this.busy = false;
    }
  }

  async openWorkspace(workspace: LauncherDirectoryWorkspace): Promise<void> {
    if (this.openingWorkspaceId) return;
    if (!workspace.publicRef) {
      globalThis.location.assign(workspace.url);
      return;
    }
    this.openingWorkspaceId = workspace.id;
    this.workspaceError = "";
    try {
      const result = await firstValueFrom(this.api.openInstanceAccount(workspace.publicRef));
      globalThis.location.assign(this.absoluteAppUrl(result.url || workspace.url));
    } catch {
      this.workspaceError = "That Orkestr workspace is not available right now.";
      this.openingWorkspaceId = "";
    }
  }

  appTarget(app: LauncherApp): string {
    return app.external || app.target === "_blank" ? "_blank" : "_self";
  }

  appInitial(app: LauncherApp): string {
    return String(app.label || "A").trim().slice(0, 1).toUpperCase();
  }

  workspaceInitial(workspace: LauncherDirectoryWorkspace): string {
    return String(workspace.displayName || "O").trim().slice(0, 1).toUpperCase();
  }

  healthLabel(app: LauncherApp): string {
    if (app.health?.status === "error") return "Needs attention";
    if (app.health?.status === "ok") return "Available";
    return "Ready";
  }

  private absoluteAppUrl(value: string): string {
    try { return new URL(value, `${this.appUrl.replace(/\/+$/, "")}/`).toString(); } catch { return this.appUrl; }
  }

  private slugFromPath(): string {
    const parts = (globalThis.location?.pathname || "").split("/").filter(Boolean);
    if (parts[0] !== "apps" || !parts[1]) return "";
    try {
      return decodeURIComponent(parts[1]);
    } catch {
      return "";
    }
  }
}
