import { resolveManagedLocalWhatsAppAccountId, sendLocalWhatsAppRepairQrEmail } from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { checkWhatsAppRepairIntent } from "../../../../../packages/connectors/src/whatsapp-repair-intent.js";
import {
  acquireWhatsAppRepairQrSlot,
  recordWhatsAppRepairRejection,
  reserveWhatsAppRepairAccountAttempt,
  reserveWhatsAppRepairSourceAttempt,
} from "../../../../../packages/connectors/src/whatsapp-repair-guard.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import {
  authenticatedAdminPrincipal,
  jsonRequest,
  originPolicyViolation,
  requestIntentHost,
  requestSourceKey,
} from "../../request-security.js";
import { whatsappRepairPageHtml } from "./whatsapp-repair-page.js";

// WhatsApp repair page and action (ORK-513).
//
// The action runs only for an authenticated administrator or for the holder of
// a signed one-time repair intent issued by the pairing-required notification.
// Order of checks: origin/CSRF, per-source budget, authorization, per-account
// QR slot and durable budget, atomic intent consumption, then the readiness
// checked QR workflow. Every failure before authorization returns the same
// minimized body, so callers learn nothing about accounts or recipients.

export interface RepairResult {
  status: number;
  payload: Record<string, unknown>;
}

const rejected: RepairResult = { status: 403, payload: { ok: false, error: "repair_request_rejected" } };
const unavailable: RepairResult = { status: 503, payload: { ok: false, error: "repair_unavailable" } };

let repairOptionsForTest: Record<string, unknown> | null = null;

/** Test hook: stub QR artifacts, runtime start and mail transport. */
export function setWhatsAppRepairOptionsForTest(options: Record<string, unknown> | null): void {
  repairOptionsForTest = options;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function maskEmail(value: unknown): string {
  const [local, domain] = clean(value).split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, Math.min(2, local.length))}${local.length > 2 ? "***" : "*"}@${domain}`;
}

export function renderWhatsAppRepairPage(request: any, accountId = ""): { status: number; html: string } {
  const admin = Boolean(authenticatedAdminPrincipal(request));
  return { status: 200, html: whatsappRepairPageHtml({ accountId: admin ? accountId : "", admin }) };
}

export async function handleWhatsAppRepairSend(request: any, body: Record<string, unknown> = {}, env = process.env): Promise<RepairResult> {
  const source = requestSourceKey(request, env);
  const admin = authenticatedAdminPrincipal(request);
  const reject = async (reason: string, extra: Record<string, unknown> = {}) => {
    await recordWhatsAppRepairRejection({ reason, sourceKey: source, ...extra }, env);
    return rejected;
  };
  const violation = originPolicyViolation(request, env, { requireOrigin: !admin });
  if (violation) return reject(violation);
  if (!jsonRequest(request)) return reject("json_required");
  // Unauthenticated sources are budgeted; administrators are bounded by the
  // per-account budget so anonymous traffic cannot lock them out.
  if (!admin) {
    const sourceBudget = await reserveWhatsAppRepairSourceAttempt(source, env);
    if (!sourceBudget.ok) return reject("source_rate_limited");
  }

  const host = requestIntentHost(request, env);
  const intentToken = clean(body.intent);
  let accountId = "";
  if (admin) {
    try {
      accountId = await resolveManagedLocalWhatsAppAccountId(clean(body.accountId), env);
    } catch (error: any) {
      return { status: Number(error?.statusCode || 404) || 404, payload: { ok: false, error: clean(error?.message) || "unknown_whatsapp_account" } };
    }
  } else {
    const checked = await checkWhatsAppRepairIntent(intentToken, { host, accountId: clean(body.accountId) }, env);
    if (!checked.ok) return reject(checked.reason, { intentId: checked.intentId });
    accountId = checked.accountId;
  }

  const release = acquireWhatsAppRepairQrSlot(accountId, env);
  if (!release) {
    await appendEvent({ type: "whatsapp_repair_request_busy", accountId }, env).catch(() => {});
    return admin ? { status: 429, payload: { ok: false, error: "repair_busy" } } : unavailable;
  }
  try {
    const accountBudget = await reserveWhatsAppRepairAccountAttempt(accountId, env);
    if (!accountBudget.ok) {
      await appendEvent({ type: "whatsapp_repair_request_throttled", accountId }, env).catch(() => {});
      return admin ? { status: 429, payload: { ok: false, error: "repair_rate_limited" } } : unavailable;
    }
    if (!admin) {
      const consumed = await checkWhatsAppRepairIntent(intentToken, { host, accountId }, env, { consume: true });
      if (!consumed.ok) return reject(consumed.reason, { intentId: consumed.intentId, accountId });
    }
    await appendEvent({
      type: "whatsapp_repair_request_authorized",
      accountId,
      via: admin ? "admin_session" : "repair_intent",
      ...(admin ? { actorUserId: clean(admin.userId) } : {}),
    }, env).catch(() => {});
    const result: any = await sendLocalWhatsAppRepairQrEmail({
      accountId,
      reason: admin ? "manual_repair_page" : "pairing_notification_repair",
      force: true,
    }, env, repairOptionsForTest || {});
    if (!admin) return result.ok || result.skipped ? { status: 200, payload: { ok: true, status: "requested" } } : unavailable;
    if (!result.ok && !result.skipped) {
      return {
        status: Number(result.statusCode || 500) || 500,
        payload: { ok: false, error: clean(result.error || result.skippedReason) || "whatsapp_qr_email_failed" },
      };
    }
    return {
      status: 200,
      payload: {
        ok: result.ok,
        skipped: Boolean(result.skipped),
        skippedReason: result.skippedReason || "",
        accountId: result.accountId || accountId,
        recipients: Array.isArray(result.recipients) ? result.recipients.map(maskEmail).filter(Boolean) : [],
      },
    };
  } finally {
    release();
  }
}
