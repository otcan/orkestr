import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvePairingChallenge,
  createPairingChallenge,
  deriveInstanceSecuritySession,
  pairBrowser,
  revokeSecuritySession,
  securitySessionForToken,
} from "../packages/core/src/security.js";
import {
  instanceAccountByPublicRef,
  instanceAccountSwitcherEnabled,
  listInstanceAccounts,
  publicInstanceAccount,
} from "../dist/server/apps/server/src/instance-account-switcher.js";

const childRef = "ins_AgICAgICAgICAgICAgICAg";

test("main account switcher intersects release-enabled children with usable broker records", async () => {
  const env = { ORKESTR_ACCOUNT_SWITCHER_ENABLED: "1" };
  const accounts = await listInstanceAccounts(env, {
    readRegistry: async () => ({
      instances: [
        { instanceId: "child-live", publicRef: childRef, displayName: "Child Live", endpointBaseUrl: "http://child-live" },
        { instanceId: "child-stale", publicRef: "ins_AwMDAwMDAwMDAwMDAwMDAw", displayName: "Child Stale", endpointBaseUrl: "http://child-stale" },
      ],
    }),
    listReleases: async () => [
      { id: "local", kind: "local-service", enabled: true, releaseTrainEnabled: true, status: "running", baseUrl: "http://main" },
      { id: "live", displayName: "Child Live", enabled: true, releaseTrainEnabled: true, status: "running", baseUrl: "http://child-live" },
      { id: "stale", displayName: "Child Stale", enabled: true, releaseTrainEnabled: false, status: "running", baseUrl: "http://child-stale" },
    ],
    resolveBroker: async (instanceId) => instanceId === "child-live" ? { ok: true } : null,
  });

  assert.equal(instanceAccountSwitcherEnabled(env), true);
  assert.deepEqual(accounts, [{
    internalInstanceId: "child-live",
    publicRef: childRef,
    displayName: "Child Live",
    canonicalPath: `/instance/${childRef}/`,
  }]);
  assert.deepEqual(publicInstanceAccount(accounts[0]), {
    publicRef: childRef,
    displayName: "Child Live",
    canonicalPath: `/instance/${childRef}/`,
  });
  assert.equal(await instanceAccountByPublicRef("ins_AwMDAwMDAwMDAwMDAwMDAw", env, {
    readRegistry: async () => ({ instances: [] }),
    listReleases: async () => [],
  }), null);
});

test("account switcher is opt-in and supports an explicit private instance allowlist", async () => {
  assert.equal(instanceAccountSwitcherEnabled({}), false);
  assert.deepEqual(await listInstanceAccounts({}, {
    readRegistry: async () => { throw new Error("must not read"); },
  }), []);

  const accounts = await listInstanceAccounts({
    ORKESTR_ACCOUNT_SWITCHER_ENABLED: "true",
    ORKESTR_ACCOUNT_SWITCHER_INSTANCE_IDS: "chosen-child",
  }, {
    readRegistry: async () => ({ instances: [
      { instanceId: "chosen-child", publicRef: childRef, displayName: "Chosen" },
      { instanceId: "other-child", publicRef: "ins_AwMDAwMDAwMDAwMDAwMDAw", displayName: "Other" },
    ] }),
    listReleases: async () => [],
    resolveBroker: async () => ({ ok: true }),
  });
  assert.deepEqual(accounts.map((account) => account.displayName), ["Chosen"]);
});

test("derived child sessions are exact-instance scoped and die with the main session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-derived-instance-session-"));
  const env = { ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env, requestedBy: "node:test" });
  await approvePairingChallenge(challenge.challengeId, { env, approvedBy: "node:test" });
  const main = await pairBrowser({ env, challengeId: challenge.challengeId });
  const child = await deriveInstanceSecuritySession({
    env,
    sourceSession: main.session,
    instanceId: "child-internal-id",
    userAgent: "node:test",
    ip: "192.0.2.25",
  });

  const verified = await securitySessionForToken(child.token, env, { touch: false });
  assert.equal(verified.instanceId, "child-internal-id");
  assert.equal(verified.parentSessionId, main.session.id);
  assert.equal(verified.role, "admin");

  await revokeSecuritySession(main.session.id, { env, revokedBy: "node:test" });
  assert.equal(await securitySessionForToken(child.token, env, { touch: false }), null);
});
