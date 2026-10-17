import assert from "node:assert/strict";
import test from "node:test";
import { assessConnectorHealth, runConnectorDoctor } from "../scripts/orkestr-connectors-doctor.mjs";

const env = { ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "fixture" };
const payload = {
  ok: true, gateway: { ok: true }, worker: { ok: true },
  accounts: [{ accountId: "fixture", state: "qr_required", authenticated: false,
    runtimeUsable: false, sendReady: false, inboundReady: false }],
};

test("code activation can retain an explicitly baselined pairing requirement without declaring operational health", () => {
  const baseline = { ...env, ORKESTR_RELEASE_CONNECTORS_AUTH_REQUIRED_ACCOUNTS: "fixture" };
  assert.equal(assessConnectorHealth(payload, env, {}, { releaseHealth: true }).ok, false);
  assert.equal(assessConnectorHealth(payload, baseline).ok, false);
  const release = assessConnectorHealth(payload, baseline, {}, { releaseHealth: true });
  assert.equal(release.ok, true);
  assert.deepEqual(release.ignoredIssues, ["required_accounts_unavailable"]);
  assert.deepEqual(release.pairingRequiredAccounts, ["fixture"]);
});

test("the pairing baseline never hides worker failure, drift, missing accounts or new runtime failure", () => {
  const baseline = { ...env, ORKESTR_RELEASE_CONNECTORS_AUTH_REQUIRED_ACCOUNTS: "fixture" };
  for (const [health, release] of [
    [{ ...payload, worker: { ok: false } }, {}],
    [{ ...payload, gateway: { ok: false } }, {}],
    [{ ...payload, ok: false }, {}],
    [payload, { drift: true }],
    [{ ...payload, accounts: [] }, {}],
    [{ ...payload, accounts: [{ ...payload.accounts[0], state: "disconnected" }] }, {}],
    [{ ...payload, accounts: [{ ...payload.accounts[0], authenticated: true }] }, {}],
  ]) assert.equal(assessConnectorHealth(health, baseline, release, { releaseHealth: true }).ok, false);
  assert.equal(assessConnectorHealth(payload, { ...baseline,
    ORKESTR_RELEASE_CONNECTORS_AUTH_REQUIRED_ACCOUNTS: "another" }, {}, { releaseHealth: true }).ok, false);
  assert.equal(assessConnectorHealth({ ...payload, accounts: [...payload.accounts,
    { ...payload.accounts[0], accountId: "new" }] }, { ...baseline,
    ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "fixture,new" }, {}, { releaseHealth: true }).ok, false);
});

test("automatic repair preserves a pairing prompt instead of restarting the account", async () => {
  for (const deadLetter of [0, 3]) {
  const result = await runConnectorDoctor({ repair: true,
    env: { ...env, ORKESTR_CONNECTORS_DOCTOR_REVISION_CHECK: "0" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...payload, queue: { deadLetter } }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.repaired, false);
  assert.equal(result.repairSuppressed, "pairing_required");
  }
});
