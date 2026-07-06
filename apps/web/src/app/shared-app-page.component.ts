import { Component, OnInit, inject } from "@angular/core";
import { DatePipe } from "@angular/common";
import { firstValueFrom } from "rxjs";
import { ApiService, SharedAppPayload, SharedAppPerson } from "./api.service";

@Component({
  selector: "ork-shared-app-page",
  imports: [DatePipe],
  templateUrl: "./shared-app-page.component.html",
  styleUrls: ["./shared-app-page.component.css"],
})
export class SharedAppPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  payload: SharedAppPayload | null = null;
  people: SharedAppPerson[] = [];
  selectedId = "";
  busy = false;
  error = "";
  notice = "";
  savingPersonId = "";

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const route = this.route();
      this.payload = await firstValueFrom(this.api.sharedApp(route.instanceId, route.appSlug, route.shareToken));
      this.people = this.payload.data?.people || [];
      if (!this.selectedId && this.people.length) this.selectedId = this.people[0].id;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  title(): string {
    return this.payload?.app?.title || "Shared Review";
  }

  selectedPerson(): SharedAppPerson | null {
    return this.people.find((person) => person.id === this.selectedId) || this.people[0] || null;
  }

  select(person: SharedAppPerson): void {
    this.selectedId = person.id;
    this.notice = "";
  }

  labels(): string[] {
    return this.payload?.data?.labels || ["not_evaluated", "to_contact", "to_skip"];
  }

  labelText(label: string): string {
    return label.replace(/_/g, " ");
  }

  classifiedCount(): number {
    return this.people.filter((person) => person.currentClassification && person.currentClassification !== "not_evaluated").length;
  }

  canClassify(): boolean {
    return (this.payload?.data?.allowedActions || this.payload?.share?.allowedActionsJson || []).includes("setClassification");
  }

  async setClassification(label: string): Promise<void> {
    const person = this.selectedPerson();
    if (!person || !this.canClassify()) return;
    const route = this.route();
    this.savingPersonId = person.id;
    this.error = "";
    this.notice = "";
    try {
      const result = await firstValueFrom(this.api.sharedAppAction(route.instanceId, route.appSlug, route.shareToken, "setClassification", {
        personId: person.id,
        classification: label,
      }));
      this.payload = { ...this.payload, data: result.data || this.payload?.data };
      this.people = result.data?.people || this.people.map((item) => item.id === person.id ? { ...item, currentClassification: label } : item);
      this.notice = "Saved.";
      this.selectNext();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.savingPersonId = "";
    }
  }

  selectNext(): void {
    if (!this.people.length) return;
    const index = Math.max(0, this.people.findIndex((person) => person.id === this.selectedId));
    this.selectedId = this.people[Math.min(this.people.length - 1, index + 1)]?.id || this.people[0].id;
  }

  private route(): { instanceId: string; appSlug: string; shareToken: string } {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return {
      instanceId: decodeURIComponent(parts[1] || ""),
      appSlug: decodeURIComponent(parts[3] || ""),
      shareToken: decodeURIComponent(parts[5] || ""),
    };
  }

  private errorText(error: unknown): string {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown }; message?: unknown } : null;
    return String(record?.error?.error || record?.message || error || "Unable to load shared app");
  }
}
