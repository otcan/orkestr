// How a thread is reachable from WhatsApp, for the thread header badge.
type ThreadLike = { id?: string; name?: string; binding?: Record<string, unknown> | null };

function binding(thread: ThreadLike | null | undefined): Record<string, unknown> {
  const value = thread?.binding;
  return value && typeof value === "object" ? value : {};
}

// One word that works after @ and /switch in the home chat.
export function whatsappAddress(thread: ThreadLike): string {
  const name = String(thread.name || "").trim();
  return /^[A-Za-z0-9][\w.-]*$/.test(name) ? name : String(thread.id || "");
}

export function whatsappReachLabel(thread: ThreadLike | null | undefined, threads: ThreadLike[] = []): string {
  if (!thread) return "";
  const own = binding(thread);
  if (own["privateOwnerChat"] === true) return "WhatsApp: Message yourself";
  if (String(own["chatId"] || "") && own["enabled"] !== false) return `WhatsApp: ${String(own["displayName"] || "own chat")}`;
  if (String(own["chatId"] || "")) return "";
  const hasHome = threads.some((item) => binding(item)["privateOwnerChat"] === true);
  return hasHome ? `WhatsApp: @${whatsappAddress(thread)}` : "";
}
