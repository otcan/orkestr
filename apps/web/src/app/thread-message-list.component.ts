import { DatePipe } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ThreadMessage } from "./api.service";
import { hasProposedPlanEnvelope, renderMessageTextHtml } from "./message-renderer";

@Component({
  selector: "ork-thread-message-list",
  imports: [DatePipe],
  templateUrl: "./thread-message-list.component.html",
})
export class ThreadMessageListComponent {
  @Input() messages: ThreadMessage[] = [];
  @Input() loading = false;
  @Input() sending = false;
  @Input() sendingNow = false;
  @Input() implementingPlan = false;
  @Input() threadInputReady = true;
  @Output() implementPlan = new EventEmitter<void>();

  messageKey(message: ThreadMessage): string {
    return String(message.id || message.eventId || message.cursor || `${message.role}:${message.createdAt}:${message.text}`);
  }

  messageText(message: ThreadMessage): string {
    return String(message.text || message.promptFile || "").trim();
  }

  messageTextHtml(message: ThreadMessage): string {
    return renderMessageTextHtml(this.messageText(message));
  }

  messagePhase(message: ThreadMessage | null): string {
    const role = String(message?.role || "").trim().toLowerCase();
    const phase = String(message?.phase || "").trim().toLowerCase();
    if (role === "assistant" && phase !== "plan" && hasProposedPlanEnvelope(message?.text)) return "plan";
    return phase;
  }

  isFinalAssistantMessage(message: ThreadMessage | null): boolean {
    const role = String(message?.role || "").trim().toLowerCase();
    const phase = this.messagePhase(message);
    return role === "assistant" && (!phase || phase === "final_answer" || phase === "final");
  }

  isInfoAssistantMessage(message: ThreadMessage | null): boolean {
    return String(message?.role || "").toLowerCase() === "assistant" && !this.isFinalAssistantMessage(message);
  }

  messageRoleLabel(message: ThreadMessage): string {
    const role = String(message.role || "assistant").toLowerCase();
    if (role === "user") return "You";
    if (this.messagePhase(message) === "signal") return "Signal";
    if (this.isFinalAssistantMessage(message)) return "Assistant";
    if (this.messagePhase(message) === "plan") return "Plan";
    return "Update";
  }

  messagePhaseLabel(message: ThreadMessage): string {
    if (String(message.role || "").toLowerCase() !== "assistant") return "";
    const phase = this.messagePhase(message);
    if (!phase || phase === "final_answer" || phase === "final") return "Final answer";
    if (phase === "commentary") return "Info";
    if (phase === "plan") return "Plan";
    if (phase === "signal") return "Passive";
    return phase.replace(/_/g, " ");
  }

  messageTime(message: ThreadMessage): Date {
    return new Date(String(message.timestamp || message.createdAt || new Date().toISOString()));
  }

  messageDeliveryStateLabel(message: ThreadMessage): string {
    const state = String(message.deliveryState || message.state || "").trim();
    if (state === "failed") return "Delivery failed";
    return state.replace(/_/g, " ");
  }

  messageFailureDetail(message: ThreadMessage): string {
    if (String(message.state || "").toLowerCase() !== "failed") return "";
    return String(message.error || "Orkestr could not confirm this message reached Codex.").trim();
  }

  replyDeliveryLabel(message: ThreadMessage): string {
    const intent = message["replyDeliveryIntent"] as Record<string, unknown> | undefined;
    if (!intent || intent["channel"] !== "whatsapp") return "";
    const status = String(intent["status"] || "").trim();
    if (status === "pending_reply") return "WhatsApp reply requested";
    if (status === "queued") return "WhatsApp delivery queued";
    if (status === "delivered") return "WhatsApp delivered";
    if (status === "policy_skipped") return `WhatsApp skipped${intent["reason"] ? `: ${String(intent["reason"]).replace(/_/g, " ")}` : ""}`;
    if (status === "delivery_unknown") return "WhatsApp delivery unknown";
    if (status === "retry_exhausted") return "WhatsApp delivery failed";
    return status.replace(/_/g, " ");
  }

  attachmentLabel(attachment: Record<string, unknown>): string {
    return String(attachment["name"] || attachment["filename"] || attachment["path"] || attachment["saved_path"] || "attachment");
  }

  attachmentDownloadUrl(attachment: Record<string, unknown>): string {
    return String(attachment["downloadUrl"] || "").trim();
  }

  attachmentEncrypted(attachment: Record<string, unknown>): boolean {
    return attachment["encrypted"] === true;
  }
}
