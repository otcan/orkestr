import { randomUUID } from "node:crypto";
import { mutateThreadResourcePolicy } from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();
const nowIso = () => new Date().toISOString();

export async function claimThreadResourcePolicyAuditOutbox({ limit = 100, leaseMs = 30_000 } = {}, env = process.env) {
  const claimToken = randomUUID();
  const boundedLimit = Math.max(1, Math.min(500, Number(limit || 100) || 100));
  const boundedLeaseMs = Math.max(1_000, Math.min(5 * 60_000, Number(leaseMs || 30_000) || 30_000));
  const updated = await mutateThreadResourcePolicy((state) => {
    const now = Date.now();
    const expiresAt = new Date(now + boundedLeaseMs).toISOString();
    const claimed = (state.policyAuditOutbox || []).filter((item) => {
      const claimExpiresAt = Date.parse(item.claimExpiresAt || "");
      return item.state === "pending" || (item.state === "claimed" && (!Number.isFinite(claimExpiresAt) || claimExpiresAt <= now));
    }).slice(0, boundedLimit).map((item) => {
      item.state = "claimed"; item.claimToken = claimToken; item.claimExpiresAt = expiresAt; item.deliveredAt = null;
      return { ...item };
    });
    if (!claimed.length) return { noChange: true, result: { claimToken: "", records: [] } };
    return { claimToken, records: claimed, auditOutboxUpserts: claimed, skipPolicyEpoch: true };
  }, env);
  return { ok: true, claimToken: updated.result.claimToken, records: updated.result.records };
}

export async function markThreadResourcePolicyAuditOutboxDelivered({ claimToken = "", ids = [] } = {}, env = process.env) {
  const requested = new Set((Array.isArray(ids) ? ids : [ids]).map(clean).filter(Boolean));
  const token = clean(claimToken);
  if (!token || !requested.size) return { ok: true, delivered: 0 };
  const updated = await mutateThreadResourcePolicy((state) => {
    const deliveredAt = nowIso();
    const delivered = (state.policyAuditOutbox || []).filter((item) => requested.has(item.id) && item.state === "claimed" && item.claimToken === token).map((item) => {
      item.state = "delivered"; item.claimToken = null; item.claimExpiresAt = null; item.deliveredAt = deliveredAt;
      return { ...item };
    });
    if (!delivered.length) return { noChange: true, result: { delivered: 0 } };
    return { delivered: delivered.length, auditOutboxUpserts: delivered, skipPolicyEpoch: true };
  }, env);
  return { ok: true, delivered: updated.result.delivered || 0 };
}
