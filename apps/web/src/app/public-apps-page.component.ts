import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, PublicAppCard } from "./api.service";

@Component({
  selector: "ork-public-apps-page",
  templateUrl: "./public-apps-page.component.html",
  styleUrls: ["./public-apps-page.component.css"],
})
export class PublicAppsPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  apps: PublicAppCard[] = [];
  selected: PublicAppCard | null = null;
  busy = false;
  error = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const listing = await firstValueFrom(this.api.myPublicApps());
      this.apps = listing.apps || [];
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

  open(app: PublicAppCard): void {
    globalThis.location.assign(app.path);
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
