// Offline qualification only: evidence is supplied by an attended operator.
// This validates its scope/completeness, never creates traffic or proves that
// an operator's assertions are authentic.
const text = value => typeof value === "string" && value.trim().length > 0;
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;

export function evaluateRuntimeCanaryEvidence(input = {}, nowMs = Date.now()) {
  const evidence = input?.canaryEvidence;
  const checks = [];
  const check = (signal, ok) => checks.push({ signal, ok: Boolean(ok) });
  const start = timestamp(evidence?.startedAt), end = timestamp(evidence?.completedAt);
  const windowOk = Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= nowMs;
  check("canary_release_scope", evidence?.version === 1 && text(evidence?.releaseId));
  check("canary_observation_window", windowOk);
  const within = value => windowOk && timestamp(value) >= start && timestamp(value) <= end;
  const canaries = Array.isArray(evidence?.canaries) ? evidence.canaries : [];
  const ids = canaries.map(row => row?.id);
  check("canary_distinct_identities", canaries.length >= 2 && ids.every(text) && new Set(ids).size === ids.length);
  check("canary_distinct_receipts", canaries.length >= 2 && ["scopeRef", "finalMessageId", "deliveryReceiptRef"].every(key => {
    const values = canaries.map(row => row?.[key]);
    return values.every(text) && new Set(values).size === values.length;
  }));
  for (const stage of ["internal", "tenant"]) {
    const rows = canaries.filter(row => row?.stage === stage);
    check(`canary_${stage}`, rows.length > 0 && rows.every(row =>
      row.releaseId === evidence.releaseId && text(row.scopeRef) && text(row.evidenceRef) &&
      row.terminalDisposition === "completed" && within(row.completedAt) &&
      text(row.finalMessageId) && row.finalPersisted === true &&
      row.transportAccepted === true && text(row.deliveryReceiptRef) && within(row.deliveryAcceptedAt) &&
      timestamp(row.deliveryAcceptedAt) >= timestamp(row.completedAt) &&
      row.stopObserved === true && row.steeringObserved === true && row.checkpointResumeObserved === true));
  }
  const rollback = evidence?.rollback;
  check("canary_rollback_observed", rollback?.observed === true && text(rollback.evidenceRef) &&
    rollback.releaseId === evidence?.releaseId && text(rollback.restoredReleaseId) &&
    rollback.restoredReleaseId !== evidence?.releaseId && within(rollback.observedAt) && rollback.healthy === true);
  return { ok: checks.every(row => row.ok), checks };
}
