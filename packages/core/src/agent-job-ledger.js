// Effect ledger and approval queue for Agent Job runs (docs/spec/agent-job.md
// §5-§6). Effects move intended -> committed | failed | unknown. Approvals are
// bound to effect_key + args_hash, are single use, and expire (G7).
import { EFFECT_STATES } from "./effect-ledger.js";
import { newId, nowIso, nowMs, openAgentJobDb, sha256, stableStringify, tx } from "./agent-job-store.js";

export { EFFECT_STATES };
export const APPROVAL_STATES = Object.freeze(["pending", "approved", "denied", "expired"]);

const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|authorization|credential|cookie|private[_-]?key)/i;

export function effectKeyFor(runId, tool, logicalKey) {
  return `eff_${sha256(stableStringify([runId, tool, logicalKey ?? null])).slice(0, 40)}`;
}

export function argsHashFor(args) {
  return `sha256:${sha256(stableStringify(args ?? {}))}`;
}

// Redact at write time (agent-job §7): secret-looking keys and any value that
// equals a known secret value are replaced before anything is stored.
export function redactValue(value, secretValues = []) {
  if (typeof value === "string") {
    return secretValues.some((secret) => secret && value.includes(secret)) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secretValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY_RE.test(key) && entry !== null && typeof entry !== "object" ? "[redacted]" : redactValue(entry, secretValues),
    ]));
  }
  return value;
}

function parse(json, fallback = null) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

function ledgerError(code, statusCode = 409, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

function rowToEffect(row) {
  if (!row) return null;
  return {
    effectKey: row.effect_key,
    runId: row.run_id,
    tool: row.tool,
    argsHash: row.args_hash,
    args: parse(row.args_json, {}),
    state: row.state,
    mode: row.mode,
    dispatchedAt: row.dispatched_at || null,
    result: parse(row.result_json),
    ref: row.ref || null,
    outcome: row.outcome || null,
    reconciled: Boolean(row.reconciled),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApproval(row) {
  if (!row) return null;
  return {
    approvalId: row.id,
    runId: row.run_id,
    effectKey: row.effect_key,
    argsHash: row.args_hash,
    tool: row.tool,
    args: parse(row.args_json, {}),
    reason: row.reason,
    state: row.state,
    requestedAt: row.requested_at,
    expiresAt: nowIso(Number(row.expires_at)),
    expiresAtMs: Number(row.expires_at),
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    comment: row.comment || null,
    consumedAt: row.consumed_at || null,
  };
}

// ---- effects ----

export function getEffectSync(db, key) {
  return rowToEffect(db.prepare("select * from effects where effect_key = ?").get(key));
}

export function listEffectsSync(db, runId) {
  return db.prepare("select * from effects where run_id = ? order by created_at, rowid").all(runId).map(rowToEffect);
}

export async function listRunEffects(runId, env = process.env) {
  return listEffectsSync(await openAgentJobDb(env), runId);
}

// Write (or refresh) the intent before anything external happens. A changed
// args hash on a not-yet-committed effect replaces the old intent, so an
// approval granted for the old args no longer matches (G7).
export function intendEffectSync(db, { effectKey, runId, tool, argsHash, args, mode }) {
  const existing = getEffectSync(db, effectKey);
  const now = nowIso();
  if (!existing) {
    db.prepare(`insert into effects (effect_key, run_id, tool, args_hash, args_json, state, mode, created_at, updated_at)
      values (?, ?, ?, ?, ?, 'intended', ?, ?, ?)`).run(effectKey, runId, tool, argsHash, JSON.stringify(args ?? {}), mode, now, now);
  } else if (existing.argsHash !== argsHash && existing.state !== "committed") {
    db.prepare(`update effects set args_hash = ?, args_json = ?, state = 'intended', dispatched_at = null, outcome = null,
      error = null, updated_at = ? where effect_key = ?`).run(argsHash, JSON.stringify(args ?? {}), now, effectKey);
  }
  return getEffectSync(db, effectKey);
}

export function markEffectDispatchedSync(db, effectKey) {
  db.prepare("update effects set dispatched_at = ?, updated_at = ? where effect_key = ? and state = 'intended'").run(nowIso(), nowIso(), effectKey);
}

export function commitEffectSync(db, effectKey, { result = null, ref = null, reconciled = false } = {}) {
  db.prepare(`update effects set state = 'committed', result_json = ?, ref = ?, reconciled = ?, outcome = 'committed', updated_at = ?
    where effect_key = ?`).run(JSON.stringify(result ?? null), ref ? String(ref) : null, reconciled ? 1 : 0, nowIso(), effectKey);
  return getEffectSync(db, effectKey);
}

export function failEffectSync(db, effectKey, { outcome = "failed", error = null } = {}) {
  db.prepare("update effects set state = 'failed', outcome = ?, error = ?, updated_at = ? where effect_key = ?")
    .run(outcome, error ? String(error).slice(0, 1000) : null, nowIso(), effectKey);
  return getEffectSync(db, effectKey);
}

export function markEffectUnknownSync(db, effectKey, error = null) {
  db.prepare("update effects set state = 'unknown', outcome = 'unknown', error = ?, updated_at = ? where effect_key = ?")
    .run(error ? String(error).slice(0, 1000) : null, nowIso(), effectKey);
  return getEffectSync(db, effectKey);
}

// A human approved retrying an `unknown` effect: it becomes a fresh intent.
export function reopenEffectSync(db, effectKey) {
  db.prepare("update effects set state = 'intended', dispatched_at = null, updated_at = ? where effect_key = ?").run(nowIso(), effectKey);
  return getEffectSync(db, effectKey);
}

// ---- approvals ----

export function findApprovalSync(db, effectKey, argsHash) {
  return rowToApproval(db.prepare("select * from approvals where effect_key = ? and args_hash = ? order by requested_at desc, rowid desc limit 1")
    .get(effectKey, argsHash));
}

export function pendingApprovalForRunSync(db, runId) {
  return rowToApproval(db.prepare("select * from approvals where run_id = ? and state = 'pending' order by requested_at, rowid limit 1").get(runId));
}

export function getApprovalSync(db, approvalId) {
  return rowToApproval(db.prepare("select * from approvals where id = ?").get(String(approvalId || "")));
}

export function createApprovalSync(db, { runId, effectKey, argsHash, tool, args, reason, ttlMs }) {
  const id = newId("apr");
  db.prepare(`insert into approvals (id, run_id, effect_key, args_hash, tool, args_json, reason, state, requested_at, expires_at)
    values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, runId, effectKey, argsHash, tool, JSON.stringify(args ?? {}), reason, nowIso(), nowMs() + ttlMs);
  return getApprovalSync(db, id);
}

// Single use: only one caller can flip approved -> consumed.
export function consumeApprovalSync(db, approvalId) {
  const result = db.prepare("update approvals set consumed_at = ? where id = ? and state = 'approved' and consumed_at is null").run(nowIso(), approvalId);
  return Number(result.changes) === 1;
}

export function expireApprovalSync(db, approvalId) {
  db.prepare("update approvals set state = 'expired', decided_at = ? where id = ? and state = 'pending'").run(nowIso(), approvalId);
  return getApprovalSync(db, approvalId);
}

export async function getApproval(approvalId, env = process.env) {
  return getApprovalSync(await openAgentJobDb(env), approvalId);
}

export async function listApprovals({ runId = "", state = "" } = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  const where = [];
  const args = [];
  if (runId) { where.push("run_id = ?"); args.push(runId); }
  if (state) { where.push("state = ?"); args.push(state); }
  return db.prepare(`select * from approvals ${where.length ? `where ${where.join(" and ")}` : ""} order by requested_at, rowid`).all(...args).map(rowToApproval);
}

// Record a human decision. Exactly one decision wins even when several
// processes decide concurrently; later ones get approval_already_decided.
export async function decideApproval(approvalId, { decision, by = "", comment = "" } = {}, env = process.env) {
  const normalized = String(decision || "").toLowerCase();
  if (!["approved", "denied"].includes(normalized)) throw ledgerError("approval_decision_invalid", 400);
  const db = await openAgentJobDb(env);
  // Errors are returned out of the transaction so the expiry write commits.
  const outcome = tx(db, () => {
    const approval = getApprovalSync(db, approvalId);
    if (!approval) return { error: ledgerError("approval_not_found", 404) };
    if (approval.state === "pending" && approval.expiresAtMs <= nowMs()) {
      expireApprovalSync(db, approvalId);
      return { error: ledgerError("approval_expired", 410, { approvalId }) };
    }
    if (approval.state !== "pending") return { error: ledgerError(approval.state === "expired" ? "approval_expired" : "approval_already_decided", approval.state === "expired" ? 410 : 409, { approvalId, state: approval.state }) };
    const result = db.prepare("update approvals set state = ?, decided_by = ?, decided_at = ?, comment = ? where id = ? and state = 'pending'")
      .run(normalized, String(by || "unknown").slice(0, 200), nowIso(), String(comment || "").slice(0, 1000) || null, approvalId);
    if (Number(result.changes) !== 1) return { error: ledgerError("approval_already_decided", 409, { approvalId }) };
    return { approval: getApprovalSync(db, approvalId) };
  });
  if (outcome.error) throw outcome.error;
  return outcome.approval;
}

export function listApprovalsSync(db, runId) {
  return db.prepare("select * from approvals where run_id = ? order by requested_at, rowid").all(runId).map(rowToApproval);
}
