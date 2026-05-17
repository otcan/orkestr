import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

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
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_SECURITY_RETURN_PAIRING_CODE", "ORKESTR_RECOVER_RUNNING_ON_START"]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_SECURITY_RETURN_PAIRING_CODE = "1";
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

    const challenge = await json(await fetch(`${baseUrl}/api/setup/security/challenge`, { method: "POST" }));
    assert.equal(challenge.ok, true);
    assert.match(challenge.code, /^\d{6}$/);

    const badPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    assert.equal(badPair.status, 401);

    const pairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: challenge.code }),
    });
    assert.equal(pairResponse.status, 200);
    const cookie = pairResponse.headers.get("set-cookie") || "";
    assert.match(cookie, /orkestr_session=/);

    const allowed = await fetch(`${baseUrl}/api/threads`, { headers: { cookie } });
    assert.equal(allowed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
