import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { OutsideLink, VaultOutsideApiService } from "./vault-outside-api";
import { vaultErrorMessage } from "./vault-secrets";

// Active and recent shares/requests with people outside Orkestr
// (docs/vault-sharing.md): status, views, opened/received, revoke.

const outsideKinds = new Set(["e2e", "e2e-request"]);

@Component({
  selector: "ork-vault-outside-panel",
  styleUrl: "./vault-dialog.css",
  template: `
@if (links.length) {
  <section class="vault-outside" aria-label="Links with people outside Orkestr">
    <h4>Links with people outside Orkestr</h4>
    @if (error) {<p class="vault-form-error" role="alert">{{ error }}</p>}
    <ul class="vault-thread-list">
      @for (link of links; track link.id) {
        <li>
          <strong>{{ link.kind === "e2e" ? "Share" : "Request" }}: {{ link.name || link.label || link.id }}</strong>
          <small class="vault-dialog-text"> · {{ describe(link) }}</small>
          @if (link.status === "active") {
            <button class="secondary vault-small" type="button" (click)="revoke(link)" [disabled]="busyId === link.id">Revoke</button>
          }
        </li>
      }
    </ul>
  </section>
}`,
})
export class VaultOutsidePanelComponent implements OnInit {
  private readonly api = inject(VaultOutsideApiService);
  links: OutsideLink[] = [];
  busyId = "";
  error = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.links());
      this.links = (result?.links || []).filter((link) => outsideKinds.has(link.kind));
      this.error = "";
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not load shared links.");
    }
  }

  describe(link: OutsideLink): string {
    const when = (value?: string | null) => (value ? new Date(value).toLocaleString() : "");
    if (link.kind === "e2e") {
      const views = `${link.views || 0}/${link.maxViews || 1} views`;
      const opened = link.openedAt ? `, first opened ${when(link.openedAt)}` : ", not opened yet";
      return link.status === "active" ? `${views}${opened}, expires ${when(link.expiresAt)}` : `${link.status} (${views}${opened})`;
    }
    if (link.status === "used") return `received ${when(link.endedAt)}${link.once ? " as single-use item" : ""}`;
    return link.status === "active" ? `waiting, expires ${when(link.expiresAt)}` : link.status;
  }

  async revoke(link: OutsideLink): Promise<void> {
    this.busyId = link.id;
    try {
      await firstValueFrom(this.api.revoke(link.id));
      await this.load();
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not revoke the link.");
    } finally {
      this.busyId = "";
    }
  }
}
