import assert from "node:assert/strict";
import test from "node:test";
import { desktopShareApiUrl, extractDesktopShareUrlParts } from "../scripts/real-wa-e2e.mjs";
import { validateWhatsAppPreflight } from "../scripts/real-wa-e2e-preflight.mjs";

test("real WhatsApp E2E preflight fails before sending when sender is not ready", () => {
  const status = {
    mode: "local",
    state: "partial",
    accounts: [
      { accountId: "sender", state: "idle", ready: false, nextAction: "start_or_pair_account" },
      { accountId: "905555154214", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154214" },
    ],
  };

  assert.throws(
    () => validateWhatsAppPreflight({
      senderAccountId: "sender",
      responderAccountId: "responder",
      manualSend: false,
    }, status),
    (error) => {
      assert.equal(error.code, "sender_account_not_ready");
      assert.equal(error.details.account.accountId, "sender");
      assert.equal(error.details.account.nextAction, "start_or_pair_account");
      return true;
    },
  );
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
      { accountId: "905555154214", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154214" },
    ],
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
      { accountId: "905555154214", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154214" },
    ],
  }, {}, {
    selected: {
      bindingId: "thread:onboarding-admin-orkestr-de:whatsapp",
      threadId: "onboarding-admin-orkestr-de",
      chatId: "120363425280218500@g.us",
      displayName: "orkestr.de",
      authorizedContactIds: ["66378837028965@lid", "+4917632400662", "4917632400662@c.us"],
      acl: { send: { mode: "users", users: ["+4917632400662", "4917632400662@c.us"] } },
      responderAccountId: "905555154214",
      runtimeAccountId: "responder",
    },
  });

  assert.equal(preflight.required.sender, null);
  assert.deepEqual(preflight.required.senderContactIds, ["66378837028965@lid", "+4917632400662", "4917632400662@c.us"]);
  assert.equal(preflight.observed.binding.displayName, "orkestr.de");
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
        { accountId: "905555154214", runtimeAccountId: "responder", state: "ready", ready: true, phoneNumber: "+905555154214" },
      ],
    }, {}, {
      selected: {
        bindingId: "thread:onboarding-admin-orkestr-de:whatsapp",
        authorizedContactIds: ["+4917632400662"],
      },
    }),
    /sender_contact_not_authorized/,
  );
});

test("real WhatsApp E2E preflight matches accounts by phone or contact id aliases", () => {
  const preflight = validateWhatsAppPreflight({
    senderAccountId: "+4917600000000",
    responderAccountId: "905555154214@c.us",
    manualSend: false,
  }, {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "sender-runtime", state: "ready", ready: true, phoneNumber: "+4917600000000", contactId: "4917600000000@c.us" },
      { accountId: "responder-runtime", state: "ready", ready: true, phoneNumber: "+905555154214", contactId: "905555154214@c.us" },
    ],
  });

  assert.equal(preflight.required.sender.accountId, "sender-runtime");
  assert.equal(preflight.required.responder.accountId, "responder-runtime");
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
