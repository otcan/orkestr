// Pure helpers for the first-run wizard (WhatsApp mode and live-check logic).
import { SetupStatus, ThreadMessage } from "./api.service";

export type WhatsAppAccessMode = "managed" | "self_hosted";

export function configuredWhatsAppAccessMode(status: SetupStatus | null): WhatsAppAccessMode {
  const settings = (status?.settings || {}) as Record<string, unknown>;
  const connectors = (settings["connectors"] || {}) as Record<string, Record<string, unknown>>;
  const mode = String(connectors["whatsapp"]?.["accessMode"] || "").toLowerCase();
  return normalizeWhatsAppAccessMode(mode) || "self_hosted";
}

export function normalizeWhatsAppAccessMode(value: unknown): WhatsAppAccessMode | null {
  const mode = String(value || "").toLowerCase();
  if (["self_hosted", "own", "local"].includes(mode)) return "self_hosted";
  if (["managed", "relay", "external"].includes(mode)) return "managed";
  return null;
}

// True once a message that arrived from WhatsApp is followed by an assistant reply.
export function whatsappRoundTrip(messages: ThreadMessage[]): { inbound: boolean; reply: boolean } {
  const index = messages.findIndex((message) => message.role === "user" &&
    (String(message.source || "").startsWith("whatsapp") || message["originSurface"] === "whatsapp"));
  if (index < 0) return { inbound: false, reply: false };
  const reply = messages.slice(index + 1).some((message) => message.role === "assistant" && Boolean(String(message.text || "").trim()));
  return { inbound: true, reply };
}
