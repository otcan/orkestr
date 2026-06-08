import assert from "node:assert/strict";
import test from "node:test";
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
