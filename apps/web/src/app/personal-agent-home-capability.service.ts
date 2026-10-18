import { Injectable, computed, inject, signal } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { ApiService } from "./api.service";
import type { PersonalAgentCapabilityResponse } from "./api.service";
import type { PersonalAgentHomeDataState } from "./personal-agent-home.component";

@Injectable({ providedIn: "root" })
export class PersonalAgentHomeCapabilityService {
  private readonly api = inject(ApiService);
  private started = false;

  readonly response = signal<PersonalAgentCapabilityResponse | null>(null);
  readonly checked = signal(false);
  readonly enabled = computed(() => this.response()?.enabled === true);
  readonly assistantAvailable = computed(() => this.response()?.assistant.available === true);
  readonly assistantReason = computed(() => this.response()?.assistant.reason || "not_configured");
  readonly capabilityReason = computed(() => this.response()?.reason || "");
  readonly dataState = computed<PersonalAgentHomeDataState>(() => {
    if (!this.checked()) return "loading";
    if (!this.response()?.enabled || !this.response()?.capability) return "offline";
    // OP-06 status data is not part of this shell slice. Never imply its feed is live.
    return "unavailable";
  });

  async load(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const response = await firstValueFrom(this.api.personalAgentCapability().pipe(timeout(2_500)));
      if (typeof response?.enabled !== "boolean" || typeof response?.capability !== "boolean" ||
          typeof response?.assistant?.available !== "boolean") {
        throw new Error("Invalid personal-agent capability response");
      }
      this.response.set(response);
    } catch {
      this.response.set(null);
    } finally {
      this.checked.set(true);
    }
  }
}
