import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeDirectWhatsAppTarget, runRealWhatsAppDemoOnboarding } from "../scripts/real-wa-demo-onboarding.mjs";
import { desktopShareApiUrl, extractDesktopShareUrlParts } from "../scripts/real-wa-e2e.mjs";
import { validateWhatsAppPreflight } from "../scripts/real-wa-e2e-preflight.mjs";

test("real WhatsApp E2E preflight fails before real sender transport when sender is not ready", () => {
  const status = {
    mode: "local",
    state: "partial",
    accounts: [
      { accountId: "sender", state: "idle", ready: false, nextAction: "start_or_pair_account" },
      { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154" },
    ],
  };

  assert.throws(
    () => validateWhatsAppPreflight({
      senderAccountId: "sender",
      responderAccountId: "responder",
      manualSend: false,
      injectInbound: false,
    }, status, {}, {
      selected: {
        bindingId: "thread:real-wa-e2e:whatsapp",
        threadId: "real-wa-e2e",
        chatId: "fixture-group@g.us",
        state: "ready",
        enabled: true,
        routeEligible: true,
      },
    }),
    (error) => {
      assert.equal(error.code, "sender_account_not_ready");
      assert.equal(error.details.account.accountId, "sender");
      assert.equal(error.details.account.nextAction, "start_or_pair_account");
      return true;
    },
  );
});

test("real WhatsApp E2E injected mode requires only responder and keeps sender isolated", () => {
  const preflight = validateWhatsAppPreflight({
    senderAccountId: "sender",
    responderAccountId: "responder",
    manualSend: false,
    injectInbound: true,
  }, {
    mode: "local",
    state: "partial",
    accounts: [
      { accountId: "sender", state: "idle", ready: false, nextAction: "start_or_pair_account" },
      { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154" },
    ],
  }, {}, {
    selected: {
      bindingId: "thread:real-wa:whatsapp",
      authorizedContactIds: ["491763240@c.us"],
      responderAccountId: "905555154",
      runtimeAccountId: "responder",
    },
  });

  assert.equal(preflight.injectInbound, true);
  assert.equal(preflight.required.responder.runtimeAccountId, "responder");
  assert.equal(preflight.required.sender, null);
  assert.equal(preflight.observed.sender.accountId, "sender");
  assert.equal(preflight.observed.sender.ready, false);
  assert.deepEqual(preflight.required.senderContactIds, ["491763240@c.us"]);
});

test("real WhatsApp E2E manual-send mode requires only the responder account", () => {
  const preflight = validateWhatsAppPreflight({
    senderAccountId: "sender",
    responderAccountId: "responder",
    manualSend: true,
  }, {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154" },
    ],
  }, {}, {
    selected: {
      bindingId: "thread:real-wa-e2e:whatsapp",
      threadId: "real-wa-e2e",
      chatId: "fixture-group@g.us",
      state: "ready",
      enabled: true,
      routeEligible: true,
    },
  });

  assert.equal(preflight.manualSend, true);
  assert.equal(preflight.required.responder.runtimeAccountId, "responder");
  assert.equal(preflight.required.sender, null);
  assert.equal(preflight.observed.sender, null);
});

test("real WhatsApp E2E manual-send mode discovers authorized sender contacts from binding", () => {
  const preflight = validateWhatsAppPreflight({
    senderAccountId: "sender",
    responderAccountId: "responder",
    manualSend: true,
  }, {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154" },
    ],
  }, {}, {
    selected: {
      bindingId: "thread:onboarding-admin-orkestr-de:whatsapp",
      threadId: "onboarding-admin-orkestr-de",
      chatId: "fixture-group@g.us",
      displayName: "orkestr.example.test",
      authorizedContactIds: ["663788370@lid", "+491763240", "491763240@c.us"],
      acl: { send: { mode: "users", users: ["+491763240", "491763240@c.us"] } },
      responderAccountId: "905555154",
      runtimeAccountId: "responder",
    },
  });

  assert.equal(preflight.required.sender, null);
  assert.deepEqual(preflight.required.senderContactIds, ["663788370@lid", "+491763240", "491763240@c.us"]);
  assert.equal(preflight.observed.binding.displayName, "orkestr.example.test");
});

test("real WhatsApp E2E rejects a requested sender contact outside the binding", () => {
  assert.throws(
    () => validateWhatsAppPreflight({
      senderAccountId: "sender",
      senderContactId: "+49111111111",
      responderAccountId: "responder",
      manualSend: true,
    }, {
      mode: "local",
      state: "paired",
      accounts: [
        { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154" },
      ],
    }, {}, {
      selected: {
        bindingId: "thread:onboarding-admin-orkestr-de:whatsapp",
        authorizedContactIds: ["+491763240"],
      },
    }),
    /sender_contact_not_authorized/,
  );
});

test("real WhatsApp E2E preflight matches accounts by phone or contact id aliases", () => {
  const preflight = validateWhatsAppPreflight({
    senderAccountId: "+491760000",
    responderAccountId: "905555154@c.us",
    manualSend: false,
  }, {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "sender-runtime", state: "ready", ready: true, phoneNumber: "+491760000", contactId: "491760000@c.us" },
      { accountId: "responder-runtime", state: "ready", ready: true, phoneNumber: "+905555154", contactId: "905555154@c.us" },
    ],
  }, {}, {
    selected: {
      bindingId: "thread:real-wa-e2e:whatsapp",
      threadId: "real-wa-e2e",
      chatId: "fixture-group@g.us",
      state: "ready",
      enabled: true,
      routeEligible: true,
    },
  });

  assert.equal(preflight.required.sender.accountId, "sender-runtime");
  assert.equal(preflight.required.responder.accountId, "responder-runtime");
});

test("real WhatsApp E2E rejects disabled bindings before live side effects", () => {
  assert.throws(
    () => validateWhatsAppPreflight({
      senderAccountId: "sender",
      responderAccountId: "responder",
      manualSend: false,
      injectInbound: true,
    }, {
      mode: "local",
      state: "paired",
      accounts: [
        { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true },
      ],
    }, {}, {
      selected: {
        bindingId: "thread:real-wa-e2e:whatsapp",
        threadId: "real-wa-e2e",
        chatId: "fixture-group@g.us",
        state: "disabled",
        enabled: false,
        routeEligible: false,
        nextAction: "enable_binding",
      },
    }),
    (error) => {
      assert.equal(error.code, "whatsapp_binding_not_route_eligible");
      assert.equal(error.details.nextAction, "enable_binding");
      return true;
    },
  );
});

test("real WhatsApp E2E rejects production-looking bindings without explicit opt-in", () => {
  const status = {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "905555154", runtimeAccountId: "responder", state: "ready", ready: true },
    ],
  };
  const bindingPayload = {
    selected: {
      bindingId: "thread:customer-project:whatsapp",
      threadId: "customer-project",
      threadName: "Customer Project",
      chatId: "fixture-group@g.us",
      state: "ready",
      enabled: true,
      routeEligible: true,
    },
  };

  assert.throws(
    () => validateWhatsAppPreflight({
      senderAccountId: "sender",
      responderAccountId: "responder",
      manualSend: false,
      injectInbound: true,
    }, status, {}, bindingPayload),
    /whatsapp_binding_not_isolated_test_target/,
  );

  const preflight = validateWhatsAppPreflight({
    senderAccountId: "sender",
    responderAccountId: "responder",
    manualSend: false,
    injectInbound: true,
    allowProductionBinding: true,
  }, status, {}, bindingPayload);
  assert.equal(preflight.required.responder.runtimeAccountId, "responder");
});

test("real WhatsApp E2E builds desktop-share API URLs from path-based public links", () => {
  const shareUrl = "https://app.example.test/desktop-share/d-123abc/share-1?key=secret";
  const details = extractDesktopShareUrlParts(shareUrl);

  assert.deepEqual(details, {
    origin: "https://app.example.test",
    shareId: "share-1",
    key: "secret",
    subdomain: "d-123abc",
  });
  assert.equal(
    desktopShareApiUrl(shareUrl, "open", details),
    "https://app.example.test/api/desktop-shares/share-1/open?key=secret&subdomain=d-123abc",
  );
  assert.equal(
    desktopShareApiUrl(shareUrl, "status", details),
    "https://app.example.test/api/desktop-shares/share-1/status?key=secret&subdomain=d-123abc",
  );
});

test("real WhatsApp E2E builds desktop-share API URLs from wildcard public links", () => {
  const shareUrl = "https://d-456def.desktop.example.test/desktop-share/share-2?key=secret-2";
  const details = extractDesktopShareUrlParts(shareUrl);

  assert.equal(details.shareId, "share-2");
  assert.equal(details.key, "secret-2");
  assert.equal(details.subdomain, "d-456def");
  assert.equal(
    desktopShareApiUrl(shareUrl, "open", details),
    "https://d-456def.desktop.example.test/api/desktop-shares/share-2/open?key=secret-2&subdomain=d-456def",
  );
});

test("real WhatsApp demo onboarding derives direct chat ids from phone numbers", () => {
  assert.deepEqual(
    normalizeDirectWhatsAppTarget({ phoneNumber: "+49 176 0000000" }),
    {
      chatId: "491760000000@c.us",
      phoneNumber: "+49 176 0000000",
      phoneDigits: "491760000000",
      derivedChatId: "491760000000@c.us",
    },
  );

  assert.deepEqual(
    normalizeDirectWhatsAppTarget({ chatId: "4917600000000@c.us" }),
    {
      chatId: "4917600000000@c.us",
      phoneNumber: "+4917600000000",
      phoneDigits: "",
      derivedChatId: "",
    },
  );
});

test("real WhatsApp demo onboarding sends through broker registered WA router", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-real-wa-demo-broker-"));
  const priorBroker = process.env.ORKESTR_DEMO_BROKER_BASE_URL;
  const priorPublic = process.env.ORKESTR_CONNECT_PUBLIC_BASE_URL;
  const calls = [];
  const instanceId = "11111111-2222-4333-8444-555555555555";
  const chatId = "491760000000@c.us";
  const brokerPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA2IFd3Rdi7NTih5q0Glq82pzgjEycOnu/MpuxJdGzGn4=\n-----END PUBLIC KEY-----\n";
  process.env.ORKESTR_DEMO_BROKER_BASE_URL = "https://broker.example.test";
  process.env.ORKESTR_CONNECT_PUBLIC_BASE_URL = "https://connect.example.test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, request });
    if (parsed.pathname === "/api/broker/instances/register") {
      const body = JSON.parse(String(request.body || "{}"));
      assert.equal(body.whatsappChatHash, crypto.createHash("sha256").update(chatId).digest("hex"));
      return new Response(JSON.stringify({
        ok: true,
        instanceId,
        channelId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        registeredAt: "2026-06-13T00:00:00.000Z",
        broker: { keyId: "broker-key-1", publicKey: brokerPublicKey },
        encryptedWelcome: { alg: "test", iv: "test", ciphertext: "test", tag: "test" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === `/api/broker/instances/${instanceId}/whatsapp/onboarding`) {
      const body = JSON.parse(String(request.body || "{}"));
      assert.equal(body.channelId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      assert.equal(body.envelope?.alg, "X25519-HKDF-SHA256+A256GCM");
      return new Response(JSON.stringify({ ok: true, sent: { ids: ["sent-1"] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === `/api/broker/instances/${instanceId}/whatsapp/history`) {
      return new Response(JSON.stringify({
        ok: true,
        messages: [{ id: "sent-1", fromMe: true, timestamp: new Date().toISOString(), body: "broker sent" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.href === `https://connect.example.test/i/${instanceId}/setup`) {
      return new Response("", {
        status: 302,
        headers: { location: `/setup/pairing?instanceId=${instanceId}&return=%2Fsetup` },
      });
    }
    throw new Error(`unexpected_fetch:${parsed.href}`);
  };

  try {
    const result = await runRealWhatsAppDemoOnboarding({
      execute: true,
      apiBase: "http://oss.example.test",
      orkestrHome: home,
      chatId,
      phoneNumber: "+49 176 000000",
      responderAccountId: "responder",
      setupUrl: "",
      timeoutMs: 10_000,
      pollMs: 250,
      artifactPath: path.join(home, "artifact.json"),
      skipPreflight: false,
      allowLocalSetupUrl: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.preflight.mode, "broker");
    assert.equal(result.preflight.localWhatsAppRequired, false);
    assert.equal(result.setupUrl, `https://connect.example.test/i/${instanceId}/setup`);
    assert.equal(result.sentMessageId, "sent-1");
    assert.equal(result.observedMessageId, "sent-1");
    assert.ok(calls.some((call) => call.url.pathname.endsWith("/whatsapp/onboarding")));
    assert.ok(calls.some((call) => call.url.pathname.endsWith("/whatsapp/history")));
  } finally {
    globalThis.fetch = originalFetch;
    if (priorBroker === undefined) delete process.env.ORKESTR_DEMO_BROKER_BASE_URL;
    else process.env.ORKESTR_DEMO_BROKER_BASE_URL = priorBroker;
    if (priorPublic === undefined) delete process.env.ORKESTR_CONNECT_PUBLIC_BASE_URL;
    else process.env.ORKESTR_CONNECT_PUBLIC_BASE_URL = priorPublic;
  }
});
