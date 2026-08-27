import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPublicApp,
  createPublicAppGrant,
  listPublicApps,
  listPublicAppsForSession,
  publicAppsEnabled,
  resolvePublicAppForSession,
  revokePublicAppGrant,
  updatePublicApp,
} from "../packages/core/src/public-apps.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { createOidcSecuritySession } from "../packages/core/src/security.js";
import { preflightPublicAppRequest } from "../dist/server/apps/server/src/public-app-gateway.js";
import { startServer } from "../apps/server/src/server.js";
import { listEvents } from "../packages/storage/src/store.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("public apps are default deny, use opaque target state, and redact grants", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-apps-"));
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_PUBLIC_APPS", "ORKESTR_PUBLIC_APP_URL"]);
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_APPS: "1",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  });
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });

  const admin = adminPrincipal({ id: "operator" });
  const created = await createPublicApp({
    slug: "operations",
    title: "Operations",
    tenantRef: "tenant-opaque-1",
    targetRef: "oxrm-target-opaque-1",
  }, { principal: admin });
  assert.equal(publicAppsEnabled(), true);
  assert.equal(created.app.path, "/apps/operations");
  assert.equal(created.app.url, "https://app.example.test/apps/operations");
  assert.equal(JSON.stringify(created.app).includes("tenant-opaque-1"), false);
  assert.equal(JSON.stringify(created.app).includes("oxrm-target-opaque-1"), false);

  await assert.rejects(
    resolvePublicAppForSession("operations", {
      principal: userPrincipal({ id: "employee" }),
      session: { oidcSubject: "oidc-subject-1" },
    }),
    (error) => error?.message === "public_app_not_found" && error?.statusCode === 404,
  );

  const grant = await createPublicAppGrant(created.app.id, {
    kind: "subject",
    value: "oidc-subject-1",
    role: "editor",
  }, { principal: admin });
  assert.equal(grant.grant.kind, "subject");
  assert.equal(JSON.stringify(grant).includes("oidc-subject-1"), false);

  const session = { oidcSubject: "oidc-subject-1", oidcGroups: ["not-a-grant"], oidcRoles: [] };
  const listed = await listPublicAppsForSession({ principal: userPrincipal({ id: "employee" }), session });
  assert.deepEqual(listed.apps.map((app) => [app.slug, app.role]), [["operations", "editor"]]);
  const resolved = await resolvePublicAppForSession("operations", { principal: userPrincipal({ id: "employee" }), session });
  assert.equal(resolved.role, "editor");
  assert.equal(resolved.app.targetRef, "oxrm-target-opaque-1");
  assert.equal(JSON.stringify(resolved.projection).includes("oxrm-target-opaque-1"), false);

  await assert.rejects(
    resolvePublicAppForSession("operations", {
      principal: userPrincipal({ id: "employee" }),
      session: { oidcSubject: "different-subject" },
    }),
    /public_app_not_found/,
  );

  const listing = await listPublicApps({ principal: admin });
  assert.equal(JSON.stringify(listing).includes("oidc-subject-1"), false);
  assert.equal(JSON.stringify(listing).includes("oxrm-target-opaque-1"), false);

  await revokePublicAppGrant(created.app.id, grant.grant.id, { principal: admin });
  await assert.rejects(
    resolvePublicAppForSession("operations", { principal: userPrincipal({ id: "employee" }), session }),
    /public_app_not_found/,
  );

  const groupGrant = await createPublicAppGrant(created.app.id, {
    kind: "group",
    value: "operations-users",
    role: "viewer",
  }, { principal: admin });
  const groupSession = { oidcSubject: "other-subject", oidcGroups: ["operations-users"], oidcRoles: [] };
  assert.equal((await resolvePublicAppForSession("operations", { principal: userPrincipal({ id: "other" }), session: groupSession })).role, "viewer");

  await updatePublicApp(created.app.id, { status: "disabled" }, { principal: admin });
  await assert.rejects(
    resolvePublicAppForSession("operations", { principal: userPrincipal({ id: "other" }), session: groupSession }),
    /public_app_not_found/,
  );
  const audit = await listEvents(process.env, 100);
  assert.equal(JSON.stringify(audit).includes("tenant-opaque-1"), false);
  assert.equal(JSON.stringify(audit).includes("oxrm-target-opaque-1"), false);
  assert.equal(groupGrant.grant.role, "viewer");
});

test("public app target and tenant values reject URL-shaped caller input", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-apps-invalid-"));
  const prior = saveEnv(["ORKESTR_HOME"]);
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  await assert.rejects(
    createPublicApp({ slug: "bad", tenantRef: "tenant-1", targetRef: "https://private.example.test" }, {
      principal: adminPrincipal({ id: "operator" }),
    }),
    /invalid_target_ref/,
  );
});

test("public app classes keep Orkestr UI, desktop, and oXRM grants distinct", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-app-types-"));
  const prior = saveEnv(["ORKESTR_HOME"]);
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });

  const admin = adminPrincipal({ id: "operator" });
  const [ui, desktop, oxrm] = await Promise.all([
    createPublicApp({ slug: "workbench", type: "orkestr-ui", tenantRef: "tenant-ui", targetRef: "ui-target" }, { principal: admin }),
    createPublicApp({ slug: "research-desktop", type: "desktop", tenantRef: "tenant-desktop", targetRef: "desktop-target" }, { principal: admin }),
    createPublicApp({ slug: "crm", type: "oxrm", tenantRef: "tenant-crm", targetRef: "crm-target" }, { principal: admin }),
  ]);
  for (const app of [ui, desktop, oxrm]) {
    await createPublicAppGrant(app.app.id, {
      kind: "subject",
      value: "person-1",
      role: "viewer",
    }, { principal: admin });
  }

  const listed = await listPublicAppsForSession({
    principal: userPrincipal({ id: "person" }),
    session: { oidcSubject: "person-1" },
  });
  assert.deepEqual(listed.apps.map((app) => [app.slug, app.type]).sort(), [
    ["crm", "oxrm"],
    ["research-desktop", "desktop"],
    ["workbench", "orkestr-ui"],
  ]);
  await assert.rejects(
    createPublicApp({ slug: "unknown", type: "anything", tenantRef: "tenant", targetRef: "target" }, { principal: admin }),
    /public_app_type_unsupported/,
  );
});

test("public app registry serializes concurrent create and grant mutations", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-apps-race-"));
  const prior = saveEnv(["ORKESTR_HOME"]);
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const admin = adminPrincipal({ id: "operator" });
  const [first, second] = await Promise.all([
    createPublicApp({ slug: "one", tenantRef: "tenant-one", targetRef: "target-one" }, { principal: admin }),
    createPublicApp({ slug: "two", tenantRef: "tenant-two", targetRef: "target-two" }, { principal: admin }),
  ]);
  const grants = await Promise.all([
    createPublicAppGrant(first.app.id, { kind: "subject", value: "subject-one", role: "viewer" }, { principal: admin }),
    createPublicAppGrant(second.app.id, { kind: "subject", value: "subject-two", role: "viewer" }, { principal: admin }),
  ]);
  const listing = await listPublicApps({ principal: admin });
  assert.deepEqual(listing.apps.map((app) => app.slug).sort(), ["one", "two"]);
  assert.equal(listing.grants.length, 2);
  assert.ok(grants.every((grant) => grant.ok));

  const duplicate = await Promise.allSettled([
    createPublicApp({ slug: "same", tenantRef: "tenant-same", targetRef: "target-same" }, { principal: admin }),
    createPublicApp({ slug: "same", tenantRef: "tenant-same", targetRef: "target-same" }, { principal: admin }),
  ]);
  assert.equal(duplicate.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(duplicate.filter((result) => result.status === "rejected" && /public_app_slug_exists/.test(String(result.reason))).length, 1);
});

test("public app routes redirect only unauthenticated users into OIDC and deny pairing fallbacks", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-app-routes-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_PUBLIC_APPS", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
  ]);
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_APPS: "1",
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_OIDC_ENABLED: "1",
    ORKESTR_KEYCLOAK_ISSUER: "https://keycloak.example.test/realms/orkestr",
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
  });
  t.after(async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });
  const admin = adminPrincipal({ id: "admin" });
  const created = await createPublicApp({ slug: "operations", tenantRef: "tenant-1", targetRef: "target-1" }, { principal: admin });
  await createPublicAppGrant(created.app.id, { kind: "subject", value: "subject-1", role: "viewer" }, { principal: admin });

  const unsigned = await preflightPublicAppRequest({ originalUrl: "/apps/operations" });
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.loginPath, "/auth/login?return=%2Fapps%2Foperations");
  const paired = await preflightPublicAppRequest({
    originalUrl: "/apps/operations",
    orkestrSecuritySession: { id: "pair", authProvider: "browser_pairing" },
  });
  assert.equal(paired.ok, false);
  const oidc = await createOidcSecuritySession({ subject: "subject-1", issuedAt: new Date().toISOString() });
  const allowed = await preflightPublicAppRequest({
    originalUrl: "/apps/operations/history",
    orkestrSecuritySession: { id: oidc.session.id, authProvider: "oidc", oidcSubject: "subject-1" },
    orkestrPrincipal: userPrincipal({ id: "oidc-user" }),
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.loginPath, undefined);
  assert.equal(allowed.matched, true);
});

test("public app HTTP routes expose only granted projections and deny ordinary browser sessions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-app-http-"));
  const prior = saveEnv([
    "ORKESTR_HOME", "ORKESTR_PUBLIC_APPS", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_CODEX_BIN",
  ]);
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_APPS: "1",
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_OIDC_ENABLED: "1",
    ORKESTR_KEYCLOAK_ISSUER: "https://keycloak.example.test/realms/orkestr",
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_CODEX_BIN: "__orkestr_disabled_codex__",
  });
  const admin = adminPrincipal({ id: "admin" });
  const created = await createPublicApp({
    slug: "operations",
    tenantRef: "tenant-internal-7",
    targetRef: "target-internal-9",
  }, { principal: admin });
  await createPublicAppGrant(created.app.id, {
    kind: "subject",
    value: "allowed-subject",
    role: "viewer",
  }, { principal: admin });
  const oidc = await createOidcSecuritySession({ subject: "allowed-subject", issuedAt: new Date().toISOString() });
  const ordinary = await createOidcSecuritySession({ subject: "ordinary-subject", issuedAt: new Date().toISOString() });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (String(input) === "https://keycloak.example.test/realms/orkestr/.well-known/openid-configuration") {
      return new Response(JSON.stringify({
        issuer: "https://keycloak.example.test/realms/orkestr",
        authorization_endpoint: "https://keycloak.example.test/realms/orkestr/protocol/openid-connect/auth",
        token_endpoint: "https://keycloak.example.test/realms/orkestr/protocol/openid-connect/token",
        jwks_uri: "https://keycloak.example.test/realms/orkestr/protocol/openid-connect/certs",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return nativeFetch(input, options);
  };
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = nativeFetch;
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true });
  });

  const unsigned = await fetch(`${baseUrl}/apps/operations`, { redirect: "manual" });
  assert.equal(unsigned.status, 302);
  assert.equal(unsigned.headers.get("location"), "/auth/login?return=%2Fapps%2Foperations");

  const login = await fetch(`${baseUrl}${unsigned.headers.get("location")}`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location") || "", /^https:\/\/keycloak\.example\.test\/realms\/orkestr\/protocol\/openid-connect\/auth\?/);

  const denied = await fetch(`${baseUrl}/apps/operations`, {
    headers: { cookie: `__Host-orkestr_app_session=${encodeURIComponent(ordinary.token)}` },
  });
  assert.equal(denied.status, 404);

  const cookie = `__Host-orkestr_app_session=${encodeURIComponent(oidc.token)}`;
  const appRoute = await fetch(`${baseUrl}/apps/operations`, { headers: { cookie } });
  assert.equal(appRoute.status, 200);
  assert.equal((await appRoute.text()).includes("target-internal-9"), false);

  const mine = await fetch(`${baseUrl}/api/me/apps`, { headers: { cookie } });
  assert.equal(mine.status, 200);
  const minePayload = await mine.json();
  assert.deepEqual(minePayload.apps.map((app) => app.slug), ["operations"]);
  assert.equal(JSON.stringify(minePayload).includes("tenant-internal-7"), false);
  assert.equal(JSON.stringify(minePayload).includes("target-internal-9"), false);

  for (const path of ["/api/desktops/leases", "/api/threads"]) {
    const rawApi = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    assert.equal(rawApi.status, 403);
    assert.equal((await rawApi.json()).error, "oidc_app_scope_denied");
  }

  const exact = await fetch(`${baseUrl}/api/apps/operations`, { headers: { cookie } });
  assert.equal(exact.status, 200);
  assert.equal(JSON.stringify(await exact.json()).includes("target-internal-9"), false);
});
