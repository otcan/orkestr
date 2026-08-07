import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { desktopAccessMode } from "./desktop-access.js";
import { withDesktopShareLock } from "./desktop-share-lock.js";
import { normalizeUserId } from "./users.js";

const shareAuditTtlMs = 24 * 60 * 60 * 1000;

export function desktopShareNowIso() {
  return new Date().toISOString();
}

function secretPath(env = process.env) {
  return `${dataPaths(env).secrets}/desktop-shares.json`;
}

export function desktopShareSha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function desktopShareRandomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function cleanDesktopSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function desktopShareLineageId(share = {}) {
  const value = [share.ownerUserId, share.threadId || "legacy", share.boundaryId || "local", share.desktopId || share.desktopSlug].join("\u0000");
  return `dsl-${desktopShareSha256(value).slice(0, 24)}`;
}

export function normalizeDesktopShareAttempt(attempt = {}, now = Date.now()) {
  const expiresAt = String(attempt.expiresAt || "").trim();
  const expired = Date.parse(expiresAt || "") <= now;
  const status = String(attempt.status || (attempt.approvedAt ? "approved" : "pending")).trim() || "pending";
  return {
    id: String(attempt.id || desktopShareRandomToken(10)).trim(),
    tokenHash: String(attempt.tokenHash || "").trim(),
    challenge: String(attempt.challenge || "").trim(),
    status: status === "pending" && expired ? "expired" : status,
    createdAt: String(attempt.createdAt || "").trim() || desktopShareNowIso(),
    expiresAt,
    openedAt: String(attempt.openedAt || "").trim() || null,
    approvedAt: String(attempt.approvedAt || "").trim() || null,
    approvedBy: String(attempt.approvedBy || "").trim() || null,
    userAgent: String(attempt.userAgent || "").slice(0, 240),
    ip: String(attempt.ip || "").slice(0, 80),
  };
}

export function normalizeDesktopShare(share = {}, now = Date.now()) {
  const expiresAt = String(share.expiresAt || "").trim();
  const expired = Date.parse(expiresAt || "") <= now;
  const status = String(share.status || "pending").trim() || "pending";
  return {
    id: String(share.id || "").trim(),
    desktopSlug: cleanDesktopSlug(share.desktopSlug || share.slug),
    ownerUserId: normalizeUserId(share.ownerUserId || share.userId || "admin"),
    threadId: String(share.threadId || "").trim() || null,
    desktopId: String(share.desktopId || share.resourceId || "").trim() || null,
    boundaryId: String(share.boundaryId || share.tenantVmId || "").trim() || null,
    grantRevision: Math.max(0, Number(share.grantRevision || 0) || 0),
    policyRevision: Math.max(0, Number(share.policyRevision || 0) || 0),
    desktopGeneration: Math.max(1, Number(share.desktopGeneration || 1) || 1),
    lineageId: String(share.lineageId || "").trim(),
    shareGeneration: Math.max(0, Number(share.shareGeneration || 0) || 0),
    currentShareId: String(share.currentShareId || "").trim() || null,
    replacesShareId: String(share.replacesShareId || "").trim() || null,
    supersessionReason: String(share.supersessionReason || "").trim() || null,
    breakGlass: share.breakGlass === true,
    breakGlassReason: String(share.breakGlassReason || "").trim() || null,
    breakGlassChangeRef: String(share.breakGlassChangeRef || share.changeRef || "").trim() || null,
    breakGlassAuthenticatedAt: String(share.breakGlassAuthenticatedAt || "").trim() || null,
    subdomain: String(share.subdomain || "").trim().toLowerCase(),
    keyHash: String(share.keyHash || "").trim(),
    status: status === "pending" && expired ? "expired" : status,
    createdAt: String(share.createdAt || "").trim() || desktopShareNowIso(),
    expiresAt,
    supersededAt: String(share.supersededAt || "").trim() || null,
    supersededBy: String(share.supersededBy || "").trim() || null,
    revokedAt: String(share.revokedAt || "").trim() || null,
    revokeReason: String(share.revokeReason || "").trim() || null,
    createdBy: String(share.createdBy || "").trim() || null,
    label: String(share.label || "").trim() || null,
    attempts: Array.isArray(share.attempts) ? share.attempts.map((attempt) => normalizeDesktopShareAttempt(attempt, now)) : [],
  };
}

function keepShare(share, now = Date.now()) {
  const expiresMs = Date.parse(share.expiresAt || "");
  if (Number.isFinite(expiresMs) && expiresMs > now) return true;
  return Number.isFinite(expiresMs) && expiresMs + shareAuditTtlMs > now;
}

export async function readDesktopShareState(env = process.env) {
  const state = await readJson(secretPath(env), { desktopShares: [] });
  const now = Date.now();
  const enforce = desktopAccessMode(env) === "enforce";
  const desktopShares = Array.isArray(state.desktopShares)
    ? state.desktopShares
        .map((share) => normalizeDesktopShare(share, now))
        .map((share) => enforce && !(share.breakGlass && share.breakGlassReason && share.breakGlassChangeRef && share.breakGlassAuthenticatedAt) && (!share.threadId || !share.desktopId || !share.boundaryId || !share.grantRevision)
          ? { ...share, status: "revoked", revokedAt: share.revokedAt || desktopShareNowIso(), revokeReason: "legacy_share_missing_thread_scope" }
          : share)
        .filter((share) => share.id && keepShare(share, now))
    : [];
  const lineages = new Map();
  for (const share of desktopShares) {
    share.lineageId = share.lineageId || desktopShareLineageId(share);
    const items = lineages.get(share.lineageId) || [];
    items.push(share);
    lineages.set(share.lineageId, items);
  }
  const desktopShareLineages = [];
  for (const [lineageId, items] of lineages) {
    items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
    let generation = 0;
    for (const item of items) {
      generation = Math.max(generation + 1, item.shareGeneration || 0);
      item.shareGeneration = generation;
    }
    const candidates = items.filter((item) => !["expired", "revoked", "superseded"].includes(item.status) && Date.parse(item.expiresAt || "") > now);
    const current = candidates.at(-1) || null;
    const ambiguous = candidates.length > 1 && candidates.some((item) => !item.threadId || !item.desktopId || !item.boundaryId);
    for (const item of items) item.currentShareId = current?.id || null;
    desktopShareLineages.push({
      id: lineageId,
      ownerUserId: items.at(-1)?.ownerUserId || "",
      threadId: items.at(-1)?.threadId || null,
      boundaryId: items.at(-1)?.boundaryId || null,
      desktopId: items.at(-1)?.desktopId || null,
      desktopSlug: items.at(-1)?.desktopSlug || "",
      generation,
      currentShareId: current?.id || null,
      migrationAmbiguous: ambiguous,
    });
  }
  return { version: 2, desktopShares, desktopShareLineages };
}

async function writeDesktopShareState(state, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  await writeSecretJson(secretPath(env), {
    version: 2,
    desktopShares: (state.desktopShares || []).map((share) => normalizeDesktopShare(share, now)).filter((share) => keepShare(share, now)),
    desktopShareLineages: state.desktopShareLineages || [],
    updatedAt: desktopShareNowIso(),
  });
}

export async function mutateDesktopShareState(env, operation) {
  return withDesktopShareLock(secretPath(env), async () => {
    const state = await readDesktopShareState(env);
    const result = await operation(state);
    await writeDesktopShareState(state, env);
    return result;
  });
}

export function publicDesktopShare(share) {
  if (!share) return null;
  return {
    id: share.id,
    desktopSlug: share.desktopSlug,
    ownerUserId: share.ownerUserId,
    threadId: share.threadId,
    desktopId: share.desktopId,
    boundaryId: share.boundaryId,
    grantRevision: share.grantRevision,
    desktopGeneration: share.desktopGeneration,
    lineageId: share.lineageId,
    shareGeneration: share.shareGeneration,
    currentShareId: share.currentShareId,
    current: share.currentShareId === share.id && !["expired", "revoked", "superseded"].includes(share.status),
    replacesShareId: share.replacesShareId,
    breakGlass: share.breakGlass === true,
    subdomain: share.subdomain,
    status: share.status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    supersededAt: share.supersededAt || null,
    supersededBy: share.supersededBy || null,
    supersessionReason: share.supersessionReason || null,
    revokedAt: share.revokedAt || null,
    revokeReason: share.revokeReason || null,
    label: share.label,
  };
}

export function publicDesktopShareAttempt(attempt, { includeChallenge = false } = {}) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    status: attempt.status,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    approvedAt: attempt.approvedAt,
    openedAt: attempt.openedAt,
    ...(includeChallenge ? { challenge: attempt.challenge } : {}),
  };
}
