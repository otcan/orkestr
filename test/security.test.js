import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge, securityStatus } from "../packages/core/src/security.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function json(response) {
  return response.json();
}

test("browser pairing protects API routes when auth is required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-"));
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START"]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const blocked = await fetch(`${baseUrl}/api/threads`);
    assert.equal(blocked.status, 401);

    const status = await json(await fetch(`${baseUrl}/api/setup/status`));
    assert.equal(status.security.authEnabled, true);
    assert.equal(status.security.paired, false);

    const challenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    assert.equal(challenge.ok, true);
    assert.match(challenge.challengeId, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(challenge.code, undefined);

    const badPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: "missing" }),
    });
    assert.equal(badPair.status, 401);

    const unapprovedPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    assert.equal(unapprovedPair.status, 409);

    await approvePairingChallenge(challenge.challengeId);

    const pairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    assert.equal(pairResponse.status, 200);
    const cookie = pairResponse.headers.get("set-cookie") || "";
    assert.match(cookie, /orkestr_session=/);

    const allowed = await fetch(`${baseUrl}/api/threads`, { headers: { cookie } });
    assert.equal(allowed.status, 200);

    const secondChallenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    const unpairedList = await fetch(`${baseUrl}/api/setup/security/challenges`);
    assert.equal(unpairedList.status, 401);

    const pairedList = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { headers: { cookie } }));
    assert.ok(pairedList.challenges.some((item) => item.id === secondChallenge.challengeId && item.status === "pending"));

    const approveFromBrowser = await json(await fetch(`${baseUrl}/api/setup/security/challenges/${secondChallenge.challengeId}/approve`, {
      method: "POST",
      headers: { cookie },
    }));
    assert.equal(approveFromBrowser.challenge.status, "approved");

    const secondPairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: secondChallenge.challengeId }),
    });
    assert.equal(secondPairResponse.status, 200);
    assert.match(secondPairResponse.headers.get("set-cookie") || "", /orkestr_session=/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("reverse proxy local publish is treated as a local external bind", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-"));
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_HOST", "ORKESTR_REVERSE_PROXY_LOCAL_BIND"]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_HOST = "0.0.0.0";
  process.env.ORKESTR_REVERSE_PROXY_LOCAL_BIND = "1";

  try {
    const status = await securityStatus();
    assert.equal(status.bindLocal, false);
    assert.equal(status.proxyLocalBind, true);
    assert.equal(status.externallyLocal, true);
    assert.equal(status.remoteReady, true);
    assert.deepEqual(status.warnings, []);
  } finally {
    restoreEnv(prior);
  }
});
