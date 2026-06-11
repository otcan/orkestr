import assert from "node:assert/strict";
import test from "node:test";
import {
  assertParentWhatsAppBridgeSendAllowed,
  parentWhatsAppBridgePolicyFromEnv,
} from "../scripts/parent-whatsapp-bridge-proxy.mjs";

test("parent WhatsApp bridge proxy enforces account and recipient allowlists", () => {
  const policy = parentWhatsAppBridgePolicyFromEnv({
    ORKESTR_PARENT_WA_BRIDGE_DEFAULT_ACCOUNT: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_PHONE_NUMBERS: "+4917600000000",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_RECIPIENTS: "66378837028965@lid",
  });

  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "4917600000000@c.us",
  }, policy), true);
  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "66378837028965@lid",
  }, policy), true);

  assert.throws(
    () => assertParentWhatsAppBridgeSendAllowed({ accountId: "other", to: "4917600000000@c.us" }, policy),
    (error) => error.message === "parent_wa_bridge_account_denied" && error.statusCode === 403,
  );
  assert.throws(
    () => assertParentWhatsAppBridgeSendAllowed({ accountId: "responder", to: "4917700000000@c.us" }, policy),
    (error) => error.message === "parent_wa_bridge_recipient_denied" && error.statusCode === 403,
  );
});

test("parent WhatsApp bridge proxy remains permissive when no allowlist is configured", () => {
  const policy = parentWhatsAppBridgePolicyFromEnv({});
  assert.equal(assertParentWhatsAppBridgeSendAllowed({ accountId: "any", to: "4917700000000@c.us" }, policy), true);
});
