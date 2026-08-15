import assert from "node:assert/strict";
import test from "node:test";
import { applyTrustedOperatorProxy } from "../dist/server/apps/server/src/trusted-operator-proxy.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";

function request({ remoteAddress = "127.0.0.1", host = "operator.example.test", proto = "https" } = {}) {
  return {
    method: "GET",
    url: "/api/threads",
    headers: {
      host: "127.0.0.1:19812",
      "x-forwarded-host": host,
      "x-forwarded-proto": proto,
    },
    socket: { remoteAddress },
  };
}

function env(extra = {}) {
  return {
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_TRUSTED_OPERATOR_PROXY: "1",
    ORKESTR_TRUSTED_OPERATOR_ORIGINS: "https://operator.example.test",
    ...extra,
  };
}

test("trusted operator proxy rewrites only exact allowlisted HTTPS origins from loopback", () => {
  const allowed = request();
  assert.equal(applyTrustedOperatorProxy(allowed, env()), true);
  assert.equal(allowed.headers["x-forwarded-host"], "app.example.test");
  assert.equal(allowed.headers["x-forwarded-proto"], "https");
  assert.equal(allowed.orkestrTrustedOperatorProxy, true);

  assert.equal(applyTrustedOperatorProxy(request(), env({ ORKESTR_TRUSTED_OPERATOR_PROXY: "0" })), false);
  assert.equal(applyTrustedOperatorProxy(request({ remoteAddress: "203.0.113.7" }), env()), false);
  assert.equal(applyTrustedOperatorProxy(request({ host: "attacker.example.test" }), env()), false);
  assert.equal(applyTrustedOperatorProxy(request({ proto: "http" }), env()), false);
});

test("trusted operator marker authorizes the local operator surface without a browser challenge", async () => {
  const unmarked = await authorizeHttpRequest(request(), env());
  assert.equal(unmarked.ok, false);
  assert.equal(unmarked.error, "browser_pairing_required");

  const marked = request();
  assert.equal(applyTrustedOperatorProxy(marked, env()), true);
  const authorized = await authorizeHttpRequest(marked, env());
  assert.equal(authorized.ok, true);
  assert.equal(authorized.principal.role, "admin");
  assert.equal(authorized.machineAuth, "trusted_operator_proxy");
});
