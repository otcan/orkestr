import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { userPrincipal } from "../packages/core/src/principal.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { pollOutlookDeviceOAuth, readOutlookToken, startOutlookDeviceOAuth } from "../packages/connectors/src/outlook.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { userDataPaths } from "../packages/storage/src/paths.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("outlook device auth start saves pending login state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outlook-start-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("outlook", {
    clientId: "client-id",
    tenantId: "common",
    scopes: "offline_access User.Read Mail.Read",
  }, env);

  const started = await startOutlookDeviceOAuth(env, { account: "person@example.com" }, async (url, options) => {
    const requestUrl = new URL(String(url));
    const body = new URLSearchParams(options.body);
    assert.equal(requestUrl.hostname, "login.microsoftonline.com");
    assert.equal(requestUrl.pathname, "/common/oauth2/v2.0/devicecode");
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("scope"), "offline_access User.Read Mail.Read");
    return jsonResponse({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://microsoft.com/devicelogin",
      verification_uri_complete: "https://microsoft.com/devicelogin?code=ABCD-EFGH",
      interval: 5,
      expires_in: 900,
      message: "Use code ABCD-EFGH",
    });
  });
  const pending = JSON.parse(await fs.readFile(path.join(home, "secrets", "outlook-device-pending.json"), "utf8"));

  assert.equal(started.ok, true);
  assert.equal(started.account, "person@example.com");
  assert.equal(started.userCode, "ABCD-EFGH");
  assert.equal(pending.deviceCode, "device-code");
  assert.equal(pending.account, "person@example.com");
});

test("outlook device auth poll stores token after approval", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outlook-poll-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("outlook", { clientId: "client-id", tenantId: "organizations" }, env);
  const started = await startOutlookDeviceOAuth(env, {}, async () =>
    jsonResponse({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://microsoft.com/devicelogin",
      interval: 5,
      expires_in: 900,
    }),
  );

  const polled = await pollOutlookDeviceOAuth(started.pendingId, env, async (url, options) => {
    const requestUrl = new URL(String(url));
    const body = new URLSearchParams(options.body);
    assert.equal(requestUrl.pathname, "/organizations/oauth2/v2.0/token");
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("device_code"), "device-code");
    return jsonResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "Mail.Read User.Read",
      token_type: "Bearer",
    });
  });
  const token = await readOutlookToken(env);

  assert.equal(polled.ok, true);
  assert.equal(polled.state, "connected");
  assert.equal(token.accessToken, "access-1");
  assert.equal(token.refreshToken, "refresh-1");
});

test("outlook device auth is scoped to the non-admin user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outlook-user-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal({ id: "alice" });
  const bob = userPrincipal({ id: "bob" });
  await writeConnectorConfig("outlook", { clientId: "client-id", tenantId: "organizations" }, env);

  const started = await startOutlookDeviceOAuth(env, { account: "alice@example.com", principal: alice }, async () =>
    jsonResponse({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://microsoft.com/devicelogin",
      interval: 5,
      expires_in: 900,
    }),
  );
  const alicePaths = userDataPaths("alice", env);
  const pending = JSON.parse(await fs.readFile(path.join(alicePaths.secrets, "outlook-device-pending.json"), "utf8"));
  assert.equal(pending.userId, "alice");

  await assert.rejects(
    () => pollOutlookDeviceOAuth(started.pendingId, env, async () => jsonResponse({}), { principal: bob }),
    /outlook_oauth_pending_not_found/,
  );

  const polled = await pollOutlookDeviceOAuth(
    started.pendingId,
    env,
    async () =>
      jsonResponse({
        access_token: "alice-access",
        refresh_token: "alice-refresh",
        expires_in: 3600,
        scope: "Mail.Read User.Read",
        token_type: "Bearer",
      }),
    { principal: alice },
  );
  const token = await readOutlookToken(env, { principal: alice });

  assert.equal(polled.ok, true);
  assert.equal(token.accessToken, "alice-access");
  assert.deepEqual(await readOutlookToken(env), {});
  assert.deepEqual(await readOutlookToken(env, { principal: bob }), {});

  let status = await getSetupStatus({ env, home, principal: alice });
  let outlook = status.connectors.find((connector) => connector.id === "outlook");
  assert.equal(outlook.state, "connected");

  status = await getSetupStatus({ env, home, principal: bob });
  outlook = status.connectors.find((connector) => connector.id === "outlook");
  assert.equal(outlook.state, "partial");
});

test("outlook setup status reflects configured and connected states", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outlook-status-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("outlook", { clientId: "client-id", tenantId: "common" }, env);

  let status = await getSetupStatus({ env, home });
  let outlook = status.connectors.find((connector) => connector.id === "outlook");
  assert.equal(outlook.state, "partial");

  await fs.writeFile(path.join(home, "secrets", "outlook-token.json"), JSON.stringify({ accessToken: "access" }));
  status = await getSetupStatus({ env, home });
  outlook = status.connectors.find((connector) => connector.id === "outlook");
  assert.equal(outlook.state, "connected");
});
