import { Component, EventEmitter, Input, Output } from "@angular/core";
import type { ThreadSummary } from "./api.service";

export type PersonalAgentHomeDataState = "loading" | "ready" | "offline" | "stale" | "unavailable";

@Component({
  selector: "ork-personal-agent-home",
  templateUrl: "./personal-agent-home.component.html",
  styleUrl: "./personal-agent-home.component.css",
})
export class PersonalAgentHomeComponent {
  @Input() dataState: PersonalAgentHomeDataState = "unavailable";
  @Input() lastVerifiedAt = "";
  @Input() conversations: ThreadSummary[] = [];
  @Output() openConversation = new EventEmitter<ThreadSummary>();
  @Output() showAllConversations = new EventEmitter<void>();
  @Output() createConversation = new EventEmitter<void>();

  statusLabel(): string {
    return {
      loading: "Loading verified work status",
      ready: "Work status feed connected",
      offline: "Work status is offline",
      stale: "Showing stale work status",
      unavailable: "Work status is not connected yet",
    }[this.dataState];
  }

  statusDescription(): string {
    if (this.dataState === "loading") return "Checking the latest persisted status.";
    if (this.dataState === "offline") return "The status service is unavailable. Existing conversations are still available.";
    if (this.dataState === "stale") {
      return this.lastVerifiedAt
        ? `The latest verified status is from ${this.lastVerifiedAt}. It may have changed.`
        : "The latest verified status may be out of date.";
    }
    if (this.dataState === "ready") return "Only persisted work state and evidence will appear in these sections.";
    return "Verified work and briefing data will appear when the status service is available.";
  }

  sectionDescription(): string {
    if (this.dataState === "loading") return "Waiting for persisted status.";
    if (this.dataState === "offline") return "Could not refresh this section. Try again when the status service is online.";
    if (this.dataState === "stale") return "This section is stale; no new result has been verified.";
    if (this.dataState === "ready") return "No verified items are available.";
    return "No live status is connected yet.";
  }

  conversationTitle(thread: ThreadSummary): string {
    return String(thread.title || thread.name || "Untitled conversation").trim();
  }
}
