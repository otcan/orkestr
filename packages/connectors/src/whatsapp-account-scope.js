// Account aliases are equivalent only within one unambiguous, active,
// owner-scoped registry identity. Exact selectors retain their existing path.
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { whatsappAccountLookupKeys } from "./whatsapp-account-identity.js";

export function sameOwnedWhatsAppAccount(thread, expected, received, accounts = [], env = process.env) {
  expected = typeof expected === "string" ? expected.trim() : "";
  received = typeof received === "string" ? received.trim() : "";
  if (!expected || !received) return false;
  if (expected === received) return true;
  const matches = selector => accounts.filter(account => !account.deletedAt &&
    !["disabled", "revoked"].includes(account.status) &&
    whatsappAccountLookupKeys(account, env).some(key => key.toLowerCase() === selector.toLowerCase()));
  const left = matches(expected), right = matches(received);
  return left.length === 1 && right.length === 1 && left[0] === right[0] &&
    resourceOwnerUserId(left[0], env) === resourceOwnerUserId(thread, env);
}
