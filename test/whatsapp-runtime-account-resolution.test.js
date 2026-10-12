import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";

// Synthetic identities only. The canonical ID of a role-named runtime account
// ("sender") is its phone identity, which the bridge does not accept as an
// account ID.
const CANONICAL_ID = "15550001111";
const RUNTIME_ID = "sender";

async function bridgeEnv(t, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-account-resolution-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    WHATSAPP_BRIDGE_URL: "http://bridge.example.test",
    ...extra,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// health: "unreachable" | "failed" | "scoped" | "listed" | "listed-other"
function fakeBridge(health) {
  const sends = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/health") {
      if (health === "unreachable") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (health === "scoped") return json({ ok: false, error: "forbidden" }, 403);
      if (health === "failed") return json({ ok: false, error: "synthetic_bridge_failure" }, 502);
      const account = health === "listed"
        ? { accountId: CANONICAL_ID, runtimeAccountId: RUNTIME_ID, phoneNumber: CANONICAL_ID, ready: true }
        : { accountId: "15550002222", runtimeAccountId: "responder", phoneNumber: "15550002222", ready: true };
      return json({ ok: true, ready: true, state: "ready", accounts: [account] });
    }
    if (options.method === "POST") {
      sends.push({ pathname, body: JSON.parse(options.body) });
      return json({ ok: true, ids: ["synthetic-ack"] });
    }
    return json({ ok: false }, 404);
  };
  return { fetchImpl, sends };
}

async function send(env, fetchImpl, accountId, hooks = {}) {
  return sendWhatsAppText({ chatId: "synthetic-chat@g.us", text: "synthetic", accountId, env, fetchImpl, ...hooks });
}

test("a canonical account ID is translated to the bridge runtime ID when status lists it", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("listed");
  await send(env, bridge.fetchImpl, CANONICAL_ID);
  assert.deepEqual(bridge.sends.map((item) => item.body.accountId), [RUNTIME_ID]);
});

test("status unavailable: a canonical account ID is not dispatched; the failure is retryable", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("unreachable");
  let beforeDispatchCalls = 0;
  await assert.rejects(
    send(env, bridge.fetchImpl, CANONICAL_ID, { beforeDispatch: () => { beforeDispatchCalls += 1; } }),
    (error) => {
      assert.equal(error.message, "whatsapp_account_resolution_unavailable");
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryable, true);
      // Not the bridge's terminal rejection, so the outbox retries instead of dead-lettering.
      assert.doesNotMatch(error.message, /unknown_whatsapp_account|whatsapp_send_not_confirmed/);
      assert.equal(error.accountResolution?.reason, "status_unavailable");
      assert.equal(JSON.stringify(error.accountResolution).includes(CANONICAL_ID), false, "no phone identity in diagnostics");
      return true;
    },
  );
  assert.equal(bridge.sends.length, 0, "nothing was sent");
  assert.equal(beforeDispatchCalls, 0, "dispatch was never started");
});

test("scoped bridge without an account list: a canonical ID passes through for the parent to resolve", async (t) => {
  // A tenant's scoped parent bridge lists no accounts; the parent's own
  // sendWhatsAppText resolves and verifies the ID against its status.
  const env = await bridgeEnv(t, { WHATSAPP_BRIDGE_TOKEN: "synthetic-scoped-token" });
  const bridge = fakeBridge("scoped");
  await send(env, bridge.fetchImpl, CANONICAL_ID);
  assert.deepEqual(bridge.sends.map((item) => item.body.accountId), [CANONICAL_ID]);
});

test("parent side: the canonical ID forwarded by a scoped tenant is resolved to the runtime ID", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("listed");
  await send(env, bridge.fetchImpl, CANONICAL_ID);
  assert.deepEqual(bridge.sends.map((item) => item.body.accountId), [RUNTIME_ID]);
});

test("bridge health failing (HTTP 502): a canonical account ID is not dispatched", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("failed");
  await assert.rejects(send(env, bridge.fetchImpl, CANONICAL_ID), (error) =>
    error.message === "whatsapp_account_resolution_unavailable" && error.retryable === true &&
    error.accountResolution?.reason === "status_unavailable");
  assert.equal(bridge.sends.length, 0);
});

test("status lists other accounts only: a canonical account ID is not dispatched", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("listed-other");
  await assert.rejects(send(env, bridge.fetchImpl, CANONICAL_ID), (error) =>
    error.message === "whatsapp_account_resolution_unavailable" && error.retryable === true &&
    error.accountResolution?.reason === "account_not_listed");
  assert.equal(bridge.sends.length, 0);
});

test("runtime-style account IDs keep working when status is unavailable or unlisted", async (t) => {
  for (const health of ["unreachable", "failed", "scoped", "listed-other"]) {
    const env = await bridgeEnv(t, health === "scoped" ? { WHATSAPP_BRIDGE_TOKEN: "synthetic-scoped-token" } : {});
    const bridge = fakeBridge(health);
    await send(env, bridge.fetchImpl, RUNTIME_ID);
    assert.deepEqual(bridge.sends.map((item) => item.body.accountId), [RUNTIME_ID], health);
  }
});

test("no account ID: the request still omits accountId and uses the bridge default", async (t) => {
  const env = await bridgeEnv(t);
  const bridge = fakeBridge("unreachable");
  await send(env, bridge.fetchImpl, "");
  assert.equal(bridge.sends.length, 1);
  assert.equal(Object.hasOwn(bridge.sends[0].body, "accountId"), false);
});
