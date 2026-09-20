// Metadata-only preparation. Never probes retired targets or invokes a provider.
const hostname = value => typeof value === "string" && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\.?$/.test(value);
const normalized = value => value.toLowerCase().replace(/\.$/, "");
const recordKey = record => `${normalized(record.Name)}|${record.Type}|${record.SetIdentifier || ""}`;

export function planAliasRetirement({ zoneId, zoneName, records, decisions, obsoleteTargets, changeRef } = {}) {
  if (!/^Z[A-Z0-9]+$/.test(zoneId || "") || !hostname(zoneName) || !Array.isArray(records) || records.length > 1000 ||
      !Array.isArray(decisions) || !Array.isArray(obsoleteTargets) || !obsoleteTargets.length || !obsoleteTargets.every(hostname) || !changeRef) throw new Error("explicit_dns_scope_required");
  const retired = new Set(obsoleteTargets.map(normalized)), candidates = new Map();
  for (const record of records) {
    if (!hostname(record?.Name) || !["A", "AAAA"].includes(record.Type) || !hostname(record.AliasTarget?.DNSName) ||
        !/^Z[A-Z0-9]+$/.test(record.AliasTarget?.HostedZoneId || "") || typeof record.AliasTarget.EvaluateTargetHealth !== "boolean") throw new Error("invalid_alias_inventory");
    const name = normalized(record.Name), zone = normalized(zoneName);
    if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error("alias_outside_reviewed_zone");
    if (!retired.has(normalized(record.AliasTarget.DNSName))) continue;
    if (candidates.has(recordKey(record))) throw new Error("duplicate_alias_identity");
    candidates.set(recordKey(record), record);
  }
  const reviewed = new Set(), changes = [], dispositions = [];
  for (const decision of decisions) {
    if (!hostname(decision?.name) || !["A", "AAAA"].includes(decision.type) || !decision.owner || !decision.reason ||
        !["retain", "delete", "redirect"].includes(decision.action)) throw new Error("accountable_alias_disposition_required");
    const id = `${normalized(decision.name)}|${decision.type}|${decision.setIdentifier || ""}`, original = candidates.get(id);
    if (!original || reviewed.has(id)) throw new Error("alias_disposition_scope_mismatch");
    reviewed.add(id);
    dispositions.push({ name: original.Name, type: original.Type, owner: decision.owner, action: decision.action });
    if (decision.action === "delete") {
      if (decision.approvedForDeletion !== true) throw new Error("exact_alias_deletion_approval_required");
      changes.push({ Action: "DELETE", ResourceRecordSet: structuredClone(original) });
    } else if (decision.action === "redirect") {
      const target = decision.target;
      if (decision.productOwnerApproved !== true || !hostname(target?.DNSName) || retired.has(normalized(target.DNSName)) ||
          !/^Z[A-Z0-9]+$/.test(target.HostedZoneId || "") || typeof target.EvaluateTargetHealth !== "boolean") throw new Error("reviewed_alias_target_required");
      changes.push({ Action: "UPSERT", ResourceRecordSet: { ...structuredClone(original), AliasTarget: structuredClone(target) } });
    }
  }
  if (reviewed.size !== candidates.size) throw new Error("unreviewed_retired_aliases_remain");
  return { zoneId, changeRef, applyEnabled: false, dispositions, changeBatch: { Changes: changes },
    rollback: changes.map(change => ({ Action: "UPSERT", ResourceRecordSet: structuredClone(candidates.get(recordKey(change.ResourceRecordSet))) })),
    requires: ["fresh_authoritative_record_equality_before_apply", "approved_change_window", "authoritative_post_change_readback"] };
}

export function assessRegistrarReadiness({ expectedDomains, domains, now = Date.now() } = {}) {
  if (!Array.isArray(expectedDomains) || !expectedDomains.length || !expectedDomains.every(hostname) || !Array.isArray(domains) || !Number.isFinite(now)) throw new Error("explicit_registrar_scope_required");
  const results = expectedDomains.map(domain => {
    const matches = domains.filter(row => typeof row.domain === "string" && normalized(row.domain) === normalized(domain));
    if (matches.length !== 1) return { domain, ok: false, findings: ["missing_or_ambiguous_registrar_evidence"] };
    const row = matches[0], findings = [];
    if (row.locked !== true) findings.push("transfer_lock_unconfirmed");
    if (row.autoRenew !== true) findings.push("auto_renew_unconfirmed");
    for (const key of ["mfaReviewed", "recoveryReviewed", "paymentHealthReviewed", "changeAlertsReviewed"]) if (row[key] !== true) findings.push(`${key}_missing`);
    const observed = Date.parse(row.observedAt), expires = Date.parse(row.expiresAt);
    if (!Number.isFinite(observed) || observed > now || now - observed > 86400_000) findings.push("registrar_evidence_stale");
    if (!Number.isFinite(expires)) findings.push("expiry_unknown");
    else if (expires - now < 30 * 86400_000) findings.push("renewal_due_within_30_days");
    if (typeof row.owner !== "string" || !row.owner.trim()) findings.push("accountable_owner_missing");
    return { domain, ok: !findings.length, findings };
  });
  return { ok: results.every(row => row.ok), results, mutations: false, limitation: "supplied_metadata_not_independent_provider_verification" };
}
