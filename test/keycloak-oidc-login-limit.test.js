import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KeycloakOidcController } from "../dist/server/apps/server/src/modules/keycloak-oidc/keycloak-oidc.controller.js";

const issuer = "https://keycloak.example.test/realms/orkestr";
const authorizationEndpoint = `${issuer}/protocol/openid-connect/auth`;
const envKeys = [
  "ORKESTR_HOME", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED", "ORKESTR_KEYCLOAK_ISSUER",
  "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL", "ORKESTR_KEYCLOAK_OIDC_CLIENT_BURST_LIMIT",
  "ORKESTR_TRUST_PROXY_HEADERS", "ORKESTR_TRUST_PROXY", "ORKESTR_TRUSTED_PROXY_IPS",
];

// Each client may start two logins per window here, so the third is refused.
async function loginController(t, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-oidc-login-limit-"));
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_OIDC_ENABLED: "1",
    ORKESTR_KEYCLOAK_ISSUER: issuer,
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_KEYCLOAK_OIDC_CLIENT_BURST_LIMIT: "2",
    ...extraEnv,
  });
  globalThis.fetch = async (url) => {
    if (url !== `${issuer}/.well-known/openid-configuration`) throw new Error(`unexpected_fetch:${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issuer,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      }),
    };
  };
  t.after(async () => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  return new KeycloakOidcController();
}

async function startLogin(controller, { peer = "", forwardedFor = "" } = {}) {
  const request = {
    headers: { host: "app.example.test", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
    ...(peer ? { socket: { remoteAddress: peer } } : {}),
  };
  const response = {
    statusCode: 0,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send() { return this; },
  };
  let error = null;
  try {
    await controller.login(request, "", "", response);
  } catch (caught) {
    error = caught;
  }
  return { response, error };
}

function assertRedirected({ response, error }) {
  assert.equal(error, null);
  assert.equal(response.statusCode, 302);
  assert.equal(String(response.headers.location).startsWith(`${authorizationEndpoint}?`), true);
  assert.equal(response.headers["retry-after"], undefined);
}

function assertRefused({ response, error }) {
  assert.equal(error?.statusCode, 429);
  assert.equal(error.message, "oidc_login_rate_limited");
  assert.equal(error.rateLimitScope, "client_burst");
  assert.equal(response.statusCode, 0);
}

test("OIDC login start limits each client behind the trusted proxy on its own budget", async (t) => {
  const controller = await loginController(t, { ORKESTR_TRUST_PROXY_HEADERS: "1", ORKESTR_TRUSTED_PROXY_IPS: "127.0.0.1" });
  const viaProxy = (forwardedFor) => startLogin(controller, { peer: "127.0.0.1", forwardedFor });

  assertRedirected(await viaProxy("203.0.113.10"));
  assertRedirected(await viaProxy("203.0.113.10"));
  // The proxy appends the address it saw; an entry the client put in front of it earns no new budget.
  assertRefused(await viaProxy("198.51.100.99, 203.0.113.10"));

  assertRedirected(await viaProxy("203.0.113.11"));
});

test("OIDC login start answers a refused client with 429 and the limiter's Retry-After", async (t) => {
  const controller = await loginController(t);
  const direct = () => startLogin(controller, { peer: "203.0.113.20" });

  assertRedirected(await direct());
  assertRedirected(await direct());
  const refused = await direct();
  assertRefused(refused);
  assert.equal(refused.response.headers["retry-after"], String(refused.error.retryAfterSeconds));
  assert.match(refused.response.headers["retry-after"], /^[1-9][0-9]?$/);
});

test("OIDC login start keeps unattributed callers in one bounded budget that headers cannot leave", async (t) => {
  const controller = await loginController(t);

  assertRedirected(await startLogin(controller));
  assertRedirected(await startLogin(controller));
  assertRefused(await startLogin(controller));
  // No proxy is trusted, so a forwarded address is ignored rather than opening a fresh budget.
  assertRefused(await startLogin(controller, { forwardedFor: "203.0.113.30" }));
  // A caller with an address is not held back by the exhausted unattributed budget.
  assertRedirected(await startLogin(controller, { peer: "203.0.113.31" }));

  assertRedirected(await startLogin(controller, { peer: "203.0.113.32", forwardedFor: "198.51.100.1" }));
  assertRedirected(await startLogin(controller, { peer: "203.0.113.32", forwardedFor: "198.51.100.2" }));
  assertRefused(await startLogin(controller, { peer: "203.0.113.32", forwardedFor: "198.51.100.3" }));
});
