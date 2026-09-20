import assert from "node:assert/strict";
import test from "node:test";
import { planAliasRetirement as plan, assessRegistrarReadiness as assess } from "../scripts/security/domain-change-plan.mjs";
const record = { Name: "old.example.invalid.", Type: "A", AliasTarget: { DNSName: "retired.example.invalid.", HostedZoneId: "ZEXAMPLE", EvaluateTargetHealth: false } };
const config = () => ({ zoneId: "ZOWNER", zoneName: "example.invalid", obsoleteTargets: ["retired.example.invalid"], changeRef: "EXAMPLE-1", records: [record], decisions: [{ name: record.Name, type: "A", owner: "owner", reason: "reviewed retired app", action: "delete", approvedForDeletion: true }] });

test("DNS deletion is exact, preserves rollback and never applies", () => {
  const result = plan(config());
  assert.equal(result.applyEnabled, false);
  assert.deepEqual(result.changeBatch.Changes, [{ Action: "DELETE", ResourceRecordSet: record }]);
  assert.deepEqual(result.rollback, [{ Action: "UPSERT", ResourceRecordSet: record }]);
  assert.equal(plan({ ...config(), decisions: [{ ...config().decisions[0], action: "retain" }] }).changeBatch.Changes.length, 0);
});

test("unknown scope, missing decisions and unapproved redirect/deletion fail closed", () => {
  assert.throws(() => plan({ ...config(), decisions: [] }), /unreviewed/);
  assert.throws(() => plan({ ...config(), zoneName: "different.invalid" }), /outside/);
  for (const patch of [{ approvedForDeletion: false }, { name: "different.example.invalid" }, { action: "redirect" }]) assert.throws(() => plan({ ...config(), decisions: [{ ...config().decisions[0], ...patch }] }));
});

test("registrar acceptance requires fresh complete metadata without exposing account details", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const row = { domain: "example.invalid", locked: true, autoRenew: true, mfaReviewed: true, recoveryReviewed: true, paymentHealthReviewed: true, changeAlertsReviewed: true,
    owner: "owner", observedAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01", payment: "PRIVATE" };
  assert.equal(assess({ expectedDomains: [row.domain], domains: [row], now }).ok, true);
  const report = assess({ expectedDomains: [row.domain], domains: [{ ...row, locked: false, expiresAt: "2026-01-15" }], now });
  assert.deepEqual(report.results[0].findings, ["transfer_lock_unconfirmed", "renewal_due_within_30_days"]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.equal(assess({ expectedDomains: [row.domain], domains: [], now }).ok, false);
});
