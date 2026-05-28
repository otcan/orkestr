import assert from "node:assert/strict";
import test from "node:test";
import { publicAuthStatus } from "../packages/core/src/auth-config.js";
import { getSetupStatus } from "../packages/core/src/setup.js";

test("auth status describes Keycloak passwordless email and phone policy", async () => {
  const auth = publicAuthStatus({
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_ISSUER: "https://keycloak.example.test/realms/orkestr",
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_OUTLOOK_SMTP_USER: "notifications@example.test",
    ORKESTR_OUTLOOK_SMTP_FROM: "notifications@example.test",
    ORKESTR_OUTLOOK_SMTP_PASSWORD: "super-secret",
  });

  assert.equal(auth.provider, "keycloak");
  assert.equal(auth.configured, true);
  assert.equal(auth.login.passwordless, true);
  assert.equal(auth.login.emailUnique, true);
  assert.equal(auth.login.phoneUnique, false);
  assert.deepEqual(auth.login.requiredFactors, ["email", "phone"]);
  assert.equal(auth.keycloak.realm, "orkestr");
  assert.equal(auth.mail.provider, "outlook");
  assert.equal(auth.mail.configured, true);
  assert.equal(auth.storage.genericIdentityLinks, false);
  assert.equal(JSON.stringify(auth).includes("super-secret"), false);
});

test("setup status exposes public auth policy without secrets", async () => {
  const status = await getSetupStatus({
    env: {
      ORKESTR_HOME: "/tmp/orkestr-auth-test",
      ORKESTR_AUTH_PROVIDER: "keycloak",
      ORKESTR_KEYCLOAK_URL: "https://keycloak.example.test",
      ORKESTR_KEYCLOAK_REALM: "orkestr",
      ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
      ORKESTR_OUTLOOK_SMTP_PASSWORD: "super-secret",
    },
  });

  assert.equal(status.auth.provider, "keycloak");
  assert.equal(status.auth.keycloak.issuer, "https://keycloak.example.test/realms/orkestr");
  assert.equal(status.auth.login.emailRequired, true);
  assert.equal(status.auth.login.phoneRequired, true);
  assert.equal(JSON.stringify(status.auth).includes("super-secret"), false);
});
