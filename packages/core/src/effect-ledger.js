import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

// Durable ledger for external side effects. Each effect is keyed by an
// idempotency key and moves through:
//   pending_approval -> approved | denied
//   approved -> started -> committed
// A crash between "started" and "committed" leaves the outcome unknown; the
// next attempt must reconcile against the external system before it is allowed
// to perform the effect again. This is what prevents duplicate side effects
// (for example a second pull request) after a crash or interrupt.

const terminalStates = new Set(["committed", "denied"]);

function clean(value = "") {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function keyDigest(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function payloadDigest(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

function ledgerError(code, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode: 409, ...extra });
}

async function ledgerDir(env) {
  const paths = await ensureDataDirs(env);
  const dir = path.join(paths.home, "effect-ledger");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function effectPath(key, env) {
  return path.join(await ledgerDir(env), `${keyDigest(key)}.json`);
}

function requireKey(key) {
  const normalized = clean(key);
  if (!normalized) throw ledgerError("effect_key_required", { statusCode: 400 });
  return normalized;
}

export async function getEffect(key, env = process.env) {
  return readJson(await effectPath(requireKey(key), env), null);
}

async function saveEffect(effect, env) {
  const next = { ...effect, updatedAt: nowIso() };
  await writeJson(await effectPath(effect.key, env), next);
  return next;
}

export async function listEffects(filter = {}, env = process.env) {
  const dir = await ledgerDir(env);
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  const effects = [];
  for (const name of names) {
    const effect = await readJson(path.join(dir, name), null);
    if (!effect) continue;
    if (filter.jobId && effect.jobId !== filter.jobId) continue;
    if (filter.state && effect.state !== filter.state) continue;
    effects.push(effect);
  }
  return effects.sort((a, b) => clean(a.createdAt).localeCompare(clean(b.createdAt)));
}

async function audit(type, effect, extra, env) {
  await appendEvent({
    type,
    effectKey: effect.key,
    effectKind: effect.kind,
    jobId: effect.jobId || null,
    state: effect.state,
    ...extra,
  }, env);
}

export async function decideEffectApproval(key, { decision, decidedBy = "", reason = "" } = {}, env = process.env) {
  const effect = await getEffect(key, env);
  if (!effect) throw ledgerError("effect_not_found", { statusCode: 404 });
  if (effect.state !== "pending_approval") return effect;
  const approved = clean(decision).toLowerCase() === "approved";
  const next = await saveEffect({
    ...effect,
    state: approved ? "approved" : "denied",
    approval: {
      ...(effect.approval || {}),
      decision: approved ? "approved" : "denied",
      decidedBy: clean(decidedBy) || null,
      reason: clean(reason) || null,
      decidedAt: nowIso(),
    },
  }, env);
  await audit(approved ? "effect_approved" : "effect_denied", next, { decidedBy: next.approval.decidedBy }, env);
  return next;
}

async function waitForApprovalDecision(key, { timeoutMs = 600_000, pollMs = 100 } = {}, env) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    const effect = await getEffect(key, env);
    if (effect?.state !== "pending_approval") return effect;
    if (Date.now() >= deadline) throw ledgerError("effect_approval_timeout", { effectKey: key });
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(pollMs) || 100)));
  }
}

async function commitEffect(effect, result, extra, env) {
  const committed = await saveEffect({ ...effect, state: "committed", result: result ?? null, committedAt: nowIso(), ...extra }, env);
  await audit(extra.reconciled ? "effect_reconciled" : "effect_committed", committed, {}, env);
  return committed;
}

/**
 * Perform an external side effect at most once per idempotency key.
 *
 * spec.perform({ idempotencyKey, effect }) performs the effect.
 * spec.reconcile(effect) looks the effect up in the external system and returns
 * its result if it already happened, or null when it did not.
 * spec.approval === "required" pauses until decideEffectApproval() is called.
 * spec.afterPerform(result, effect) runs after the effect but before commit
 * (used for fault injection in tests and the demo).
 */
export async function runEffect(spec = {}, env = process.env) {
  const key = requireKey(spec.key);
  const digest = payloadDigest(spec.payload);
  let effect = await getEffect(key, env);

  if (effect && effect.payloadDigest !== digest) {
    throw ledgerError("effect_idempotency_conflict", { effectKey: key });
  }
  if (effect?.state === "committed") {
    await audit("effect_deduplicated", effect, { attempt: spec.attempt ?? null }, env);
    return { status: "deduplicated", effect, result: effect.result };
  }
  if (effect?.state === "denied") throw ledgerError("effect_approval_denied", { effectKey: key, statusCode: 403 });

  if (!effect) {
    const approvalRequired = clean(spec.approval).toLowerCase() === "required";
    effect = await saveEffect({
      key,
      kind: clean(spec.kind) || "effect",
      jobId: clean(spec.jobId) || null,
      payload: spec.payload ?? null,
      payloadDigest: digest,
      state: approvalRequired ? "pending_approval" : "approved",
      approval: approvalRequired ? { required: true, requestedAt: nowIso() } : { required: false },
      attempts: [],
      createdAt: nowIso(),
    }, env);
    await audit(approvalRequired ? "effect_approval_requested" : "effect_recorded", effect, {}, env);
  }

  if (effect.state === "pending_approval") {
    if (typeof spec.onApprovalRequested === "function") await spec.onApprovalRequested(effect);
    effect = await waitForApprovalDecision(key, spec.waitForApproval, env);
    if (effect?.state === "denied") throw ledgerError("effect_approval_denied", { effectKey: key, statusCode: 403 });
  }

  if (effect.state === "started") {
    // A previous attempt crashed after starting the effect. Never repeat it
    // blindly: ask the external system whether it already happened.
    if (typeof spec.reconcile !== "function") {
      throw ledgerError("effect_outcome_unknown", { effectKey: key });
    }
    const existing = await spec.reconcile(effect);
    if (existing) {
      const committed = await commitEffect(effect, existing, { reconciled: true, reconciledAttempt: spec.attempt ?? null }, env);
      return { status: "reconciled", effect: committed, result: committed.result };
    }
    await audit("effect_reconcile_missing", effect, { attempt: spec.attempt ?? null }, env);
  }

  effect = await saveEffect({
    ...effect,
    state: "started",
    startedAt: nowIso(),
    attempts: [...(effect.attempts || []), { attempt: spec.attempt ?? null, startedAt: nowIso() }],
  }, env);
  await audit("effect_started", effect, { attempt: spec.attempt ?? null }, env);
  const result = await spec.perform({ idempotencyKey: key, effect });
  if (typeof spec.afterPerform === "function") await spec.afterPerform(result, effect);
  const committed = await commitEffect(effect, result, { reconciled: false }, env);
  return { status: "performed", effect: committed, result: committed.result };
}

export function effectIsTerminal(effect) {
  return terminalStates.has(clean(effect?.state));
}
