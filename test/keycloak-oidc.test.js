import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginKeycloakLogin,
  completeKeycloakLogin,
  consumeKeycloakBackchannelLogout,
  keycloakOidcEnabled,
  keycloakOidcSettings,
} from "../packages/core/src/keycloak-oidc.js";
import { authorizeHttpRequest, createOidcSecuritySession, oidcSecurityCookieName, sessionCookieHeader, verifySecurityToken } from "../packages/core/src/security.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function jwt(privateKey, payload, { kid = "signing-key" } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function oidcFixture({ issuer, clientId, privateKey, jwk, idToken, logoutToken = "" }) {
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  };
  return async (url, options = {}) => {
    if (url === `${issuer}/.well-known/openid-configuration`) return jsonResponse(discovery);
    if (url === discovery.jwks_uri) return jsonResponse({ keys: [jwk] });
    if (url === discovery.token_endpoint && options.method === "POST") return jsonResponse({ id_token: idToken });
    throw new Error(`unexpected_fetch:${url}`);
  };
}

function configuredEnv(home, issuer) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_OIDC_ENABLED: "1",
    ORKESTR_KEYCLOAK_ISSUER: issuer,
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  };
}

test("Keycloak OIDC uses code+PKCE, validates signed verified-email tokens, and creates host-only sessions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-oidc-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
  ]);
  const issuer = "https://keycloak.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer));
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const start = await beginKeycloakLogin({ returnTo: "/apps/operations", fetchImpl: oidcFixture({ issuer, clientId: "orkestr-web", privateKey, jwk, idToken: "" }) });
  const authorization = new URL(start.authorizationUrl);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("state"));
  assert.ok(authorization.searchParams.get("nonce"));
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://app.example.test/auth/callback");
  const idToken = jwt(privateKey, {
    iss: issuer,
    aud: "orkestr-web",
    exp: now + 300,
    iat: now,
    nonce: authorization.searchParams.get("nonce"),
    sub: "keycloak-subject-123",
    sid: "keycloak-session-123",
    email: "employee@example.test",
    email_verified: true,
    name: "Employee",
    groups: ["operations-users"],
    realm_access: { roles: ["employee"] },
  });
  const completed = await completeKeycloakLogin({
    code: "authorization-code",
    state: authorization.searchParams.get("state"),
    fetchImpl: oidcFixture({ issuer, clientId: "orkestr-web", privateKey, jwk, idToken }),
  });
  assert.equal(completed.redirectPath, "/apps/operations");
  assert.equal(await verifySecurityToken(completed.token), true);
  const cookie = sessionCookieHeader(completed.token, process.env, { name: oidcSecurityCookieName(), hostOnly: true, requestHost: "app.example.test" });
  assert.match(cookie, /^__Host-orkestr_app_session=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/);
  const authorized = await authorizeHttpRequest({ method: "GET", url: "/api/me/apps", headers: { cookie: cookie.split(";")[0] } });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.principal.source, "oidc-session");
  assert.equal(authorized.session.oidcSubject, "keycloak-subject-123");
  assert.equal(JSON.stringify(authorized.principal).includes("employee@example.test"), false);
  assert.equal(JSON.stringify(authorized.session).includes("employee@example.test"), false);
});

test("Keycloak OIDC binds launcher login and callback to the configured launcher origin", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-launcher-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_PUBLIC_LAUNCHER_URL",
  ]);
  const issuer = "https://keycloak-launcher.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer), {
    ORKESTR_PUBLIC_LAUNCHER_URL: "https://launcher.example.test",
  });
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const fixture = oidcFixture({ issuer, privateKey, jwk, idToken: "" });
  const start = await beginKeycloakLogin({
    returnTo: "/apps",
    requestOrigin: "https://launcher.example.test",
    fetchImpl: fixture,
  });
  const authorization = new URL(start.authorizationUrl);
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://launcher.example.test/auth/callback");
  await assert.rejects(
    beginKeycloakLogin({ requestOrigin: "https://attacker.example.test", fetchImpl: fixture }),
    /oidc_redirect_origin_mismatch/,
  );
  const now = Math.floor(Date.now() / 1000);
  const idToken = jwt(privateKey, {
    iss: issuer,
    aud: "orkestr-web",
    exp: now + 300,
    iat: now,
    nonce: authorization.searchParams.get("nonce"),
    sub: "launcher-subject",
    email: "launcher@example.test",
    email_verified: true,
  });
  const completed = await completeKeycloakLogin({
    code: "launcher-code",
    state: authorization.searchParams.get("state"),
    requestOrigin: "https://launcher.example.test",
    fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken }),
  });
  assert.equal(completed.redirectPath, "/apps");
});

test("Keycloak control-plane access requires an explicit realm role and maps to the existing admin", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-control-plane-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_KEYCLOAK_CONTROL_PLANE_ENABLED", "ORKESTR_KEYCLOAK_CONTROL_PLANE_ADMIN_ROLE",
    "ORKESTR_KEYCLOAK_CONTROL_PLANE_ADMIN_USER_ID",
  ]);
  const issuer = "https://keycloak-control.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer), {
    ORKESTR_KEYCLOAK_CONTROL_PLANE_ENABLED: "1",
    ORKESTR_KEYCLOAK_CONTROL_PLANE_ADMIN_ROLE: "orkestr-control-plane-admin",
    ORKESTR_KEYCLOAK_CONTROL_PLANE_ADMIN_USER_ID: "admin",
  });
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const start = await beginKeycloakLogin({ returnTo: "/", fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: "" }) });
  const authorization = new URL(start.authorizationUrl);
  const idToken = jwt(privateKey, {
    iss: issuer,
    aud: "orkestr-web",
    exp: now + 300,
    iat: now,
    nonce: authorization.searchParams.get("nonce"),
    sub: "control-plane-subject",
    email: "admin@example.test",
    email_verified: true,
    realm_access: { roles: ["orkestr-control-plane-admin"] },
  });
  const completed = await completeKeycloakLogin({
    code: "authorization-code",
    state: authorization.searchParams.get("state"),
    fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken }),
  });
  assert.equal(completed.redirectPath, "/");
  assert.equal(completed.session.userId, "admin");
  assert.equal(completed.session.role, "admin");
  const cookie = sessionCookieHeader(completed.token, process.env, { name: oidcSecurityCookieName(), hostOnly: true, requestHost: "app.example.test" });
  const authorized = await authorizeHttpRequest({ method: "GET", url: "/api/threads", headers: { cookie: cookie.split(";")[0] } });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.principal.userId, "admin");
  assert.equal(authorized.principal.role, "admin");

  const ordinary = await createOidcSecuritySession({
    subject: "ordinary-subject",
    roles: ["employee"],
    issuedAt: new Date().toISOString(),
  });
  const denied = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { cookie: `${oidcSecurityCookieName()}=${encodeURIComponent(ordinary.token)}` },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "oidc_app_scope_denied");
});

test("Keycloak OIDC fails closed on replay, unverified email, and invalid audience", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-oidc-deny-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
  ]);
  const issuer = "https://keycloak-deny.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer));
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const start = await beginKeycloakLogin({ fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: "" }) });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  const invalid = jwt(privateKey, {
    iss: issuer,
    aud: "another-client",
    exp: now + 300,
    iat: now,
    nonce: "not-used-after-audience-reject",
    sub: "subject",
    email: "employee@example.test",
    email_verified: false,
  });
  await assert.rejects(
    completeKeycloakLogin({ code: "code", state, fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: invalid }) }),
    /oidc_token_claims_invalid/,
  );
  await assert.rejects(
    completeKeycloakLogin({ code: "code", state, fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: invalid }) }),
    /oidc_state_invalid/,
  );
});

test("Keycloak OIDC atomically consumes a callback state under concurrent replay", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-oidc-race-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
  ]);
  const issuer = "https://keycloak-race.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer));
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const start = await beginKeycloakLogin({ fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: "" }) });
  const authorization = new URL(start.authorizationUrl);
  const idToken = jwt(privateKey, {
    iss: issuer, aud: "orkestr-web", exp: now + 300, iat: now,
    nonce: authorization.searchParams.get("nonce"), sub: "race-subject", sid: "race-sid",
    email: "employee@example.test", email_verified: true,
  });
  const complete = () => completeKeycloakLogin({
    code: "one-time-code",
    state: authorization.searchParams.get("state"),
    fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken }),
  });
  const results = await Promise.allSettled([complete(), complete()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /oidc_state_invalid/.test(String(result.reason))).length, 1);
});

test("Keycloak backchannel logout revokes only matching OIDC sessions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-keycloak-oidc-logout-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
  ]);
  const issuer = "https://keycloak-logout.example.test/realms/orkestr";
  Object.assign(process.env, configuredEnv(home, issuer));
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  assert.equal(keycloakOidcEnabled(), true);
  assert.equal(keycloakOidcSettings().redirectUri, "https://app.example.test/auth/callback");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "signing-key", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const start = await beginKeycloakLogin({ fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken: "" }) });
  const parsed = new URL(start.authorizationUrl);
  const idToken = jwt(privateKey, {
    iss: issuer, aud: "orkestr-web", exp: now + 300, iat: now,
    nonce: parsed.searchParams.get("nonce"), sub: "subject-logout", sid: "sid-logout",
    email: "employee@example.test", email_verified: true,
  });
  const session = await completeKeycloakLogin({ code: "code", state: parsed.searchParams.get("state"), fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken }) });
  const logoutToken = jwt(privateKey, {
    iss: issuer, aud: "orkestr-web", exp: now + 300, iat: now,
    sub: "subject-logout", sid: "sid-logout",
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  });
  const revoked = await consumeKeycloakBackchannelLogout({ logoutToken, fetchImpl: oidcFixture({ issuer, privateKey, jwk, idToken }) });
  assert.equal(revoked.revoked.length, 1);
  assert.equal(await verifySecurityToken(session.token), false);
  await assert.rejects(
    createOidcSecuritySession({
      subject: "subject-logout",
      sid: "sid-logout",
      issuedAt: new Date(now * 1000).toISOString(),
    }),
    /oidc_session_revoked/,
  );
});
