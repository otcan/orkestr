import assert from "node:assert/strict";
import test from "node:test";
import { publicAuthStatus } from "../packages/core/src/auth-config.js";
import { publicUrlConfig, publicUrlIdentityDiagnostics } from "../packages/core/src/public-url-config.js";
import { sessionCookieHeader } from "../packages/core/src/security.js";
import { getSetupStatus, publicSetupStatus } from "../packages/core/src/setup.js";

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

test("auth status describes Microsoft Graph mail without exposing token config", async () => {
  const auth = publicAuthStatus({
    ORKESTR_MAIL_PROVIDER: "graph",
    ORKESTR_GRAPH_MAIL_FROM: "hello@example.test",
    ORKESTR_GRAPH_MAIL_SENDER: "sender@example.test",
    ORKESTR_GRAPH_MAIL_TOKEN_COMMAND_JSON: "[\"/private/token-helper\"]",
  });

  assert.equal(auth.mail.provider, "graph");
  assert.equal(auth.mail.configured, true);
  assert.equal(auth.mail.from, "he***@example.test");
  assert.equal(auth.mail.user, "se***@example.test");
  assert.equal(JSON.stringify(auth).includes("token-helper"), false);
});

test("public URL config separates app and auth hosts for hosted deployments", () => {
  const urls = publicUrlConfig({
    ORKESTR_PRIMARY_DOMAIN: "orkestr.example.test",
    ORKESTR_APP_HOST: "app.orkestr.example.test",
    ORKESTR_AUTH_HOST: "auth.orkestr.example.test",
  });

  assert.equal(urls.primaryDomain, "orkestr.example.test");
  assert.equal(urls.appUrl, "https://app.orkestr.example.test");
  assert.equal(urls.authUrl, "https://auth.orkestr.example.test");
  assert.equal(urls.cookieDomain, "orkestr.example.test");
  assert.equal(urls.sameOriginAuth, false);
});

test("public URL config prefers explicit public app and auth URLs over legacy aliases", () => {
  const urls = publicUrlConfig({
    ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
    ORKESTR_PUBLIC_URL: "https://app.public.example.test",
    ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
    ORKESTR_AUTH_URL: "https://auth.public.example.test",
    ORKESTR_PUBLIC_AUTH_URL: "https://auth.ops.example.test",
  });

  assert.equal(urls.appUrl, "https://orkestr.app.ops.example.test");
  assert.equal(urls.authUrl, "https://auth.ops.example.test");
  assert.equal(urls.appHost, "orkestr.app.ops.example.test");
  assert.equal(urls.authHost, "auth.ops.example.test");
});

test("public URL identity diagnostics accept one hosted URL family", () => {
  const diagnostics = publicUrlIdentityDiagnostics({
    ORKESTR_PRIMARY_DOMAIN: "orkestr.example.test",
    ORKESTR_APP_HOST: "app.orkestr.example.test",
    ORKESTR_AUTH_HOST: "auth.orkestr.example.test",
    ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example.test",
    ORKESTR_PUBLIC_APP_URL: "https://app.orkestr.example.test",
    ORKESTR_AUTH_URL: "https://auth.orkestr.example.test",
    ORKESTR_PAIRING_URL: "https://app.orkestr.example.test/setup/pairing",
    ORKESTR_COOKIE_DOMAIN: "orkestr.example.test",
  });

  assert.equal(diagnostics.ok, true);
  assert.deepEqual(diagnostics.roots.map((root) => root.root), ["orkestr.example.test"]);
});

test("public URL identity diagnostics ignore a separate public marketing site URL", () => {
  const diagnostics = publicUrlIdentityDiagnostics({
    ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
    ORKESTR_APP_HOST: "orkestr.app.ops.example.test",
    ORKESTR_AUTH_HOST: "auth.ops.example.test",
    ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example.test",
    ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
    ORKESTR_AUTH_URL: "https://auth.ops.example.test",
    ORKESTR_PAIRING_URL: "https://orkestr.app.ops.example.test/setup/pairing",
  });

  assert.equal(diagnostics.ok, true);
  assert.deepEqual(diagnostics.roots.map((root) => root.root), ["ops.example.test"]);
  assert.equal(diagnostics.records.some((record) => record.name === "ORKESTR_PUBLIC_SITE_URL"), false);
});

test("public URL identity diagnostics warn on mixed runtime service URLs", () => {
  const diagnostics = publicUrlIdentityDiagnostics({
    ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
    ORKESTR_APP_HOST: "orkestr.app.ops.example.test",
    ORKESTR_AUTH_HOST: "auth.ops.example.test",
    ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example.test",
    ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
    ORKESTR_AUTH_URL: "https://auth.orkestr.example.test",
    ORKESTR_PAIRING_URL: "https://orkestr.app.ops.example.test/setup/pairing",
  });

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.status, "warning");
  assert.deepEqual(diagnostics.roots.map((root) => root.root), ["example.test", "ops.example.test"]);
  assert.ok(diagnostics.records.some((record) => record.name === "ORKESTR_AUTH_URL" && record.root === "example.test"));
});

test("public URL identity diagnostics ignore role-specific public auth and connect URLs", () => {
  const diagnostics = publicUrlIdentityDiagnostics({
    ORKESTR_PRIMARY_DOMAIN: "ops.example.test",
    ORKESTR_APP_HOST: "orkestr.app.ops.example.test",
    ORKESTR_AUTH_HOST: "auth.ops.example.test",
    ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
    ORKESTR_AUTH_URL: "https://auth.ops.example.test",
    ORKESTR_PUBLIC_AUTH_URL: "https://connect.orkestr.de/setup/pairing",
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.crawlerai.de",
    ORKESTR_PAIRING_URL: "https://orkestr.app.ops.example.test/setup/pairing",
  });

  assert.equal(diagnostics.ok, true);
  assert.deepEqual(diagnostics.roots.map((root) => root.root), ["ops.example.test"]);
  assert.equal(diagnostics.records.some((record) => record.name === "ORKESTR_PUBLIC_AUTH_URL"), false);
  assert.equal(diagnostics.records.some((record) => record.name === "ORKESTR_CONNECT_PUBLIC_URL"), false);
});

test("pairing session cookie can cover app and auth subdomains", () => {
  const header = sessionCookieHeader("token-value", {
    ORKESTR_PRIMARY_DOMAIN: "orkestr.example.test",
    ORKESTR_APP_HOST: "app.orkestr.example.test",
    ORKESTR_AUTH_HOST: "auth.orkestr.example.test",
  }, { requestHost: "app.orkestr.example.test" });

  assert.match(header, /Domain=orkestr\.example\.test/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
});

test("pairing session cookie is host-only for temporary Cloudflare hosts", () => {
  const header = sessionCookieHeader("token-value", {
    ORKESTR_PRIMARY_DOMAIN: "ops.oguzcanunver.com",
    ORKESTR_APP_HOST: "orkestr.app.ops.oguzcanunver.com",
    ORKESTR_AUTH_HOST: "auth.ops.oguzcanunver.com",
  }, { requestHost: "doctor-interfaces-nearly-consistently.trycloudflare.com" });

  assert.match(header, /orkestr_session=token-value/);
  assert.doesNotMatch(header, /Domain=/);
  assert.match(header, /Secure/);
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

test("redacted setup status keeps public app and auth URLs for pairing", async () => {
  const status = await getSetupStatus({
    env: {
      ORKESTR_HOME: "/tmp/orkestr-auth-url-test",
      ORKESTR_PRIMARY_DOMAIN: "orkestr.example.test",
      ORKESTR_APP_HOST: "app.orkestr.example.test",
      ORKESTR_AUTH_HOST: "auth.orkestr.example.test",
      ORKESTR_AUTH_REQUIRED: "1",
      ORKESTR_SECURITY_APPROVE_SSH_COMMAND: "ssh root@203.0.113.10",
      ORKESTR_SECURITY_APPROVE_COMMAND: "orkestr-public security approve <challenge-id>",
      ORKESTR_SECURITY_APPROVE_SUDO_COMMAND: "sudo orkestr-public security approve <challenge-id>",
    },
  });

  const redacted = publicSetupStatus(status);
  assert.equal(redacted.urls.appUrl, "https://app.orkestr.example.test");
  assert.equal(redacted.urls.authUrl, "https://auth.orkestr.example.test");
  assert.equal(redacted.security.https.url, undefined);
  assert.equal(redacted.security.approval.sshCommand, "ssh root@203.0.113.10");
  assert.equal(redacted.security.approval.approveCommand, "orkestr-public security approve <challenge-id>");
  assert.equal(redacted.security.approval.sudoApproveCommand, "sudo orkestr-public security approve <challenge-id>");
});

test("public app URL alone enables remote auth protection", async () => {
  const status = await getSetupStatus({
    env: {
      ORKESTR_HOME: "/tmp/orkestr-auth-public-app-test",
      ORKESTR_PUBLIC_APP_URL: "https://orkestr.app.ops.example.test",
    },
  });

  assert.equal(status.urls.appUrl, "https://orkestr.app.ops.example.test");
  assert.equal(status.security.authRequired, true);
  assert.equal(status.security.remoteReady, true);
});
