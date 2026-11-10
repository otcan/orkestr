import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConsent, decideConsent, exchangeMcpToken, registerMcpClient, validateAuthorizeRequest,
} from "../packages/core/src/mcp-oauth.js";

async function fixture(t, redirects = ["http://localhost/callback", "http://127.0.0.1/callback"]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-oauth-loopback-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_MCP_PUBLIC_URL: "https://app.example.test",
    ORKESTR_MCP_OAUTH_ALLOW_LOOPBACK: "1",
    ORKESTR_MCP_OAUTH_REDIRECT_HOSTS: "client.example.test",
  };
  const clientId = `https://client.example.test/oauth/${crypto.randomUUID()}.json`;
  const doc = { client_id: clientId, client_name: "Native client", redirect_uris: redirects, token_endpoint_auth_method: "none" };
  const fetchImpl = async () => ({ status: 200, text: JSON.stringify(doc) });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const query = {
    client_id: clientId, redirect_uri: "http://localhost:41541/callback", response_type: "code",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  };
  return { env, clientId, fetchImpl, verifier, query };
}

test("metadata-document loopback redirects accept runtime ports with explicit opt-in", async (t) => {
  const { env, query, fetchImpl } = await fixture(t);
  for (const host of ["localhost", "127.0.0.1"]) {
    for (const port of [1024, 41541, 65535]) {
      const redirect = `http://${host}:${port}/callback`;
      const request = await validateAuthorizeRequest({ ...query, redirect_uri: redirect }, env, fetchImpl);
      assert.equal(request.redirectUri, redirect, "consent must retain the actual runtime port");
    }
  }
  // The client is cached; disabling the flag must still disable the exception.
  for (const flag of [undefined, "0", "true"]) {
    await assert.rejects(validateAuthorizeRequest(query, { ...env, ORKESTR_MCP_OAUTH_ALLOW_LOOPBACK: flag }, fetchImpl), /invalid_request/);
  }
});

test("dynamic registration shares loopback port matching and preserves exact registered callbacks", async (t) => {
  const { env, query } = await fixture(t);
  const registered = await registerMcpClient({
    client_name: "Native client", redirect_uris: ["http://localhost:3000/callback"], token_endpoint_auth_method: "none",
  }, env);
  const request = { ...query, client_id: registered.client_id };
  assert.equal((await validateAuthorizeRequest(request, env)).redirectUri, query.redirect_uri);
  await assert.rejects(validateAuthorizeRequest(request, { ...env, ORKESTR_MCP_OAUTH_ALLOW_LOOPBACK: "0" }), /invalid_request/);
  assert.equal((await validateAuthorizeRequest({ ...request, redirect_uri: registered.redirect_uris[0] }, env)).redirectUri, registered.redirect_uris[0]);
});

test("loopback port exception does not change the host, path, query or non-loopback matching", async (t) => {
  const httpsRedirect = "https://client.example.test/callback?mode=code";
  const { env, query, fetchImpl } = await fixture(t, ["http://localhost/callback", httpsRedirect]);
  assert.equal((await validateAuthorizeRequest({ ...query, redirect_uri: httpsRedirect }, env, fetchImpl)).redirectUri, httpsRedirect);
  for (const redirect of [
    "http://127.0.0.1:41541/callback", "http://localhost:41541/other", "http://localhost:41541/callback/",
    "http://localhost:41541/a/../callback", "http://localhost:41541/callback?extra=1", "http://localhost:41541/callback#fragment",
    "http://user@localhost:41541/callback", "http://localhost:65536/callback", "http://localhost.evil.example:41541/callback",
    "https://localhost:41541/callback", "https://client.example.test:41541/callback?mode=code",
    "https://client.example.test/callback?mode=other", "http://client.example.test:41541/callback?mode=code",
  ]) {
    await assert.rejects(validateAuthorizeRequest({ ...query, redirect_uri: redirect }, env, fetchImpl), /invalid_request/, redirect);
  }
});

test("loopback metadata remains refused without opt-in and requires PKCE S256 when enabled", async (t) => {
  const { env, query, fetchImpl } = await fixture(t);
  await assert.rejects(validateAuthorizeRequest(query, { ...env, ORKESTR_MCP_OAUTH_ALLOW_LOOPBACK: "0" }, fetchImpl), /invalid_client/);
  await assert.rejects(validateAuthorizeRequest({ ...query, code_challenge_method: "plain" }, env, fetchImpl), /invalid_request/);
  await assert.rejects(validateAuthorizeRequest({ ...query, code_challenge: "" }, env, fetchImpl), /invalid_request/);
});

test("loopback OAuth requires approval and binds token exchange to the approved runtime port and PKCE", async (t) => {
  const { env, clientId, query, fetchImpl, verifier } = await fixture(t);
  const request = await validateAuthorizeRequest(query, env, fetchImpl);
  const owner = { userId: "owner-a", sessionId: "session-a" };
  const decision = async (approve) => {
    const consentId = await createConsent(request, owner, env);
    return new URL(await decideConsent({ consentId, ...owner, approve }, env));
  };
  const denied = await decision(false);
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("code"), null);
  const body = {
    grant_type: "authorization_code", client_id: clientId, redirect_uri: query.redirect_uri, code_verifier: verifier,
  };
  const approved = await decision(true);
  assert.equal(approved.origin + approved.pathname, query.redirect_uri);
  await assert.rejects(exchangeMcpToken({ ...body, code: approved.searchParams.get("code"), redirect_uri: "http://localhost:41542/callback" }, "", env, fetchImpl), /invalid_grant/);
  const badProof = await decision(true);
  await assert.rejects(exchangeMcpToken({ ...body, code: badProof.searchParams.get("code"), code_verifier: "wrong" }, "", env, fetchImpl), /invalid_grant/);
  const allowed = await decision(true);
  const tokens = await exchangeMcpToken({ ...body, code: allowed.searchParams.get("code") }, "", env, fetchImpl);
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token);
});
