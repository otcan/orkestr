import { DatePipe, JsonPipe, KeyValuePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, InstanceStatusResponse } from "./api.service";

@Component({
  selector: "ork-instance-settings-page",
  imports: [DatePipe, JsonPipe, KeyValuePipe],
  templateUrl: "./instance-settings-page.component.html",
})
export class InstanceSettingsPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  error = "";
  snapshot: InstanceStatusResponse | null = null;

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.busy = true;
    try {
      this.snapshot = await firstValueFrom(this.api.instanceStatus());
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  desiredJson(): string {
    return JSON.stringify(this.snapshot?.config || {}, null, 2);
  }

  mailboxConfigured(): boolean {
    return Object.keys(this.snapshot?.config?.mailboxes || {}).length > 0;
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        return String((record.error as { error?: unknown }).error || "instance_status_error");
      }
      if (record.message) return String(record.message);
    }
    return String(error || "instance_status_error");
  }
}
