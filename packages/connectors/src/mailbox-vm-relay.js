import { appendEvent } from "../../storage/src/store.js";
import { getConnectorInboxEvent, markConnectorInboxEvent } from "./connector-inbox.js";
import { getMailbox, readMailboxStore, writeMailboxStore } from "../../core/src/mailboxes.js";
import { getTenantVm } from "../../core/src/tenant-vm-registry.js";

const clean = (value = "") => String(value || "").trim();

function relayLimit(env = process.env) {
  return Math.max(1, Math.min(100, Number(env.ORKESTR_MAILBOX_VM_RELAY_PUMP_LIMIT || 25) || 25));
}

export function mailboxVmRelayPumpIntervalMs(env = process.env) {
  return Math.max(1_000, Math.min(5 * 60_000, Number(env.ORKESTR_MAILBOX_VM_RELAY_PUMP_INTERVAL_MS || 10_000) || 10_000));
}

function retryDelayMs(attempt, env = process.env) {
  const base = Math.max(1_000, Number(env.ORKESTR_MAILBOX_VM_RELAY_RETRY_MS || 5_000) || 5_000);
  return Math.min(15 * 60_000, base * (2 ** Math.max(0, Number(attempt || 1) - 1)));
}

function relayTarget(vm = {}) {
  const base = clean(vm.endpoint?.brokerBaseUrl || vm.endpoint?.baseUrl || vm.endpoint?.url).replace(/\/+$/, "");
  if (!base) return "";
  try {
    const parsed = new URL(base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return String(new URL("/api/mailboxes/relay-inbound", `${base}/`));
  } catch {
    return "";
  }
}

async function updateAudit(auditId, patch, env) {
  const store = await readMailboxStore(env);
  let updated = null;
  const relayAudits = store.relayAudits.map((audit) => {
    if (audit.id !== auditId) return audit;
    updated = { ...audit, ...patch, updatedAt: new Date().toISOString() };
    return updated;
  });
  if (updated) await writeMailboxStore({ ...store, relayAudits }, env);
  return updated;
}

async function relayFailure(audit, error, env) {
  const attemptCount = Number(audit.attemptCount || 0) + 1;
  const expired = audit.expiresAt && Date.parse(audit.expiresAt) <= Date.now();
  const maxAttempts = Math.max(1, Math.min(100, Number(env.ORKESTR_MAILBOX_VM_RELAY_MAX_ATTEMPTS || 20) || 20));
  const terminal = expired || attemptCount >= maxAttempts;
  const reason = clean(error?.message || error || "mailbox_vm_relay_failed").slice(0, 500);
  const updated = await updateAudit(audit.id, {
    state: terminal ? "dead-lettered" : "queued",
    attemptCount,
    lastAttemptAt: new Date().toISOString(),
    nextAttemptAt: terminal ? "" : new Date(Date.now() + retryDelayMs(attemptCount, env)).toISOString(),
    lastError: reason,
  }, env);
  await markConnectorInboxEvent(audit.id, {
    state: terminal ? "dead_letter" : "pending",
    attemptCount,
    nextAttemptAt: updated?.nextAttemptAt || "",
    error: reason,
  }, env).catch(() => {});
  await appendEvent({
    type: terminal ? "mailbox_vm_relay_dead_lettered" : "mailbox_vm_relay_deferred",
    mailboxId: audit.mailboxId,
    tenantVmId: audit.tenantVmId,
    relayAuditId: audit.id,
    reason,
  }, env).catch(() => {});
  return { ok: false, audit: updated, error: reason, terminal };
}

export async function dispatchVmMailboxRelay(audit, env = process.env, fetchImpl = fetch) {
  const inbox = await getConnectorInboxEvent(audit.id, env);
  if (!inbox?.payload) return relayFailure(audit, new Error("mailbox_vm_relay_payload_missing"), env);
  const [mailbox, vm] = await Promise.all([getMailbox(audit.mailboxId, env), getTenantVm(audit.tenantVmId, env)]);
  if (!mailbox || mailbox.target?.type !== "vm" || mailbox.target?.tenantVmId !== audit.tenantVmId) {
    return relayFailure(audit, new Error("mailbox_vm_relay_original_target_missing"), env);
  }
  if (!vm || vm.status !== "running" || vm.deletedAt) return relayFailure(audit, new Error("mailbox_vm_relay_target_unavailable"), env);
  const target = relayTarget(vm);
  const token = clean(env.ORKESTR_MAILBOX_RELAY_TOKEN);
  if (!target) return relayFailure(audit, new Error("mailbox_vm_relay_target_missing"), env);
  if (!token) return relayFailure(audit, new Error("mailbox_vm_relay_token_missing"), env);
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tenantVmId: vm.id,
        threadId: clean(vm.bootstrap?.firstThreadId),
        idempotencyKey: audit.id,
        mailbox,
        message: inbox.payload,
      }),
      signal: AbortSignal.timeout(Math.max(5_000, Number(env.ORKESTR_MAILBOX_VM_RELAY_TIMEOUT_MS || 60_000) || 60_000)),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || payload.ok !== true) throw new Error(clean(payload.error || payload.message || `mailbox_vm_relay_http_${response.status}`));
    const now = new Date().toISOString();
    const updated = await updateAudit(audit.id, {
      state: "delivered",
      attemptCount: Number(audit.attemptCount || 0) + 1,
      lastAttemptAt: now,
      deliveredAt: now,
      nextAttemptAt: "",
      lastError: "",
    }, env);
    await markConnectorInboxEvent(audit.id, { state: "routed", nextAttemptAt: "", error: "", result: payload }, env);
    await appendEvent({ type: "mailbox_vm_relay_delivered", mailboxId: audit.mailboxId, tenantVmId: audit.tenantVmId, relayAuditId: audit.id }, env).catch(() => {});
    return { ok: true, audit: updated, response: payload };
  } catch (error) {
    return relayFailure(audit, error, env);
  }
}

export async function runVmMailboxRelayPump(env = process.env, fetchImpl = fetch) {
  const store = await readMailboxStore(env);
  const now = Date.now();
  const due = store.relayAudits.filter((audit) =>
    audit.targetType === "vm" && audit.state === "queued" && (!audit.nextAttemptAt || Date.parse(audit.nextAttemptAt) <= now)
  ).slice(0, relayLimit(env));
  const results = [];
  for (const audit of due) results.push(await dispatchVmMailboxRelay(audit, env, fetchImpl));
  return { ok: true, inspected: store.relayAudits.length, attempted: due.length, results };
}
