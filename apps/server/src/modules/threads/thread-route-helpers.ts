import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { httpError } from "../../common/http.js";

export function assertThreadAdminOnly(action: string, principal: any) {
  if (isAdminPrincipal(principal)) return;
  throw httpError(`${action.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_admin_required`, 403);
}

export function threadIsActive(status: Record<string, any> | null | undefined): boolean {
  return Boolean(
    status?.working ||
    status?.foregroundWorking ||
    status?.typingActive ||
    Number(status?.runningCount || 0) > 0 ||
    Number(status?.pendingCount || 0) > 0,
  );
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function optionalBodyString(body: Record<string, unknown>, key: string, fallback: unknown = ""): string {
  if (hasOwn(body, key) && (body[key] === null || body[key] === undefined)) return "";
  return String(hasOwn(body, key) ? body[key] : fallback || "").trim();
}

export function optionalBodyBoolean(body: Record<string, unknown>, key: string, fallback = true): boolean {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
  return value !== false;
}

export function optionalBodyStringArray(body: Record<string, unknown>, key: string, fallback: unknown = []): string[] {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = String(item || "").trim();
    const comparable = text.toLowerCase();
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(text);
  }
  return result;
}

export function optionalBodyStringMap(body: Record<string, unknown>, key: string, fallback: unknown = {}): Record<string, string> {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const id = String(rawKey || "").trim();
    const label = String(rawValue || "").trim();
    if (id && label) result[id] = label;
  }
  return result;
}

export function sanitizerFileMeta(file: any): Record<string, unknown> {
  return {
    name: String(file?.name || file?.filename || file?.originalname || "").slice(0, 240),
    mimetype: String(file?.mimetype || file?.type || "").slice(0, 120),
    size: Number(file?.size || 0) || null,
  };
}

export function sanitizedThreadActionInput(input: Record<string, unknown> = {}): Record<string, unknown> {
  const scalarKeys = [
    "text",
    "prompt",
    "promptFile",
    "source",
    "reason",
    "mode",
    "name",
    "title",
    "displayName",
    "threadId",
    "ownerUserId",
    "workspace",
    "cwd",
    "connector",
    "chatId",
    "replyPrefix",
    "senderContactId",
    "responderContactId",
    "ownerContactId",
    "authorizedContactId",
  ];
  const result: Record<string, unknown> = {};
  for (const key of scalarKeys) {
    if (!hasOwn(input, key)) continue;
    result[key] = String(input[key] || "").slice(0, key === "text" || key === "prompt" ? 8000 : 500);
  }
  for (const key of ["wake", "start", "deleteWorkers", "mirrorToWhatsApp", "suppressWhatsAppUpdates", "suppressWhatsAppDebugFooter", "enabled", "allowOtherPeople"]) {
    if (hasOwn(input, key)) result[key] = Boolean(input[key]);
  }
  if (Array.isArray(input.attachments)) {
    result.attachments = input.attachments.map(sanitizerFileMeta);
  }
  if (Array.isArray(input.files)) {
    result.files = input.files.map(sanitizerFileMeta);
  }
  for (const key of ["ownerContactIds", "ownerContactAliases", "authorizedContactIds", "authorizedContactAliases", "additionalParticipantIds"]) {
    if (Array.isArray(input[key])) result[key] = input[key].map((value) => String(value || "").slice(0, 500)).filter(Boolean);
  }
  return result;
}
