import test from "node:test";
import assert from "node:assert/strict";
import { capacityResetDate, capacityResetLabel, withWhatsAppOwnerTimezone } from "../packages/connectors/src/whatsapp-capacity-reset.js";
import { appendWhatsAppDebugFooter, whatsappDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";

const epochMs = Date.parse("2026-09-20T12:00:00Z");
// Reset windows in the past no longer describe current usage, so footer
// fixtures use a far-future reset with the same calendar label.
const futureResetMs = Date.parse("2099-09-20T12:00:00Z");
const thread = {
  id: "capacity-fixture", ownerUserId: "owner-a",
  codexRateLimits: { primary: { used_percent: 20, window_minutes: 300 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: futureResetMs / 1000 } },
};

test("capacity reset accepts seconds, milliseconds and numeric strings with explicit timezone", () => {
  for (const value of [epochMs, epochMs / 1000, String(epochMs), String(epochMs / 1000)]) {
    assert.equal(capacityResetDate(value).toISOString(), "2026-09-20T12:00:00.000Z");
    assert.equal(capacityResetLabel(value, "Europe/Berlin"), "20 Sept 14:00 Europe/Berlin");
    assert.equal(capacityResetLabel(value), "20 Sept 12:00 UTC");
  }
  assert.equal(capacityResetLabel(epochMs, "invalid/not-a-zone"), "20 Sept 12:00 UTC");
  assert.equal(capacityResetLabel(epochMs, "America/New_York"), "20 Sept 08:00 America/New_York");
});

test("capacity reset omits missing, malformed, implausible and non-scalar values", () => {
  for (const value of [undefined, null, "", " ", "tomorrow", NaN, Infinity, -1, 0, 1, 1.5, true, false, [], [epochMs], {}, epochMs * 1000000]) {
    assert.equal(capacityResetDate(value), null, String(value));
    assert.equal(capacityResetLabel(value), "");
  }
});

test("weekly reset follows window classification, not primary/secondary position", () => {
  const swapped = { ...thread, codexRateLimits: { primary: thread.codexRateLimits.secondary, secondary: thread.codexRateLimits.primary }, whatsAppDebugOwnerTimezone: "Europe/Berlin" };
  // Only the weekly window carries a reset, so only it shows a countdown.
  assert.match(whatsappDebugFooter({ thread: swapped }), /\ncodex 5h: 80% wk: 60% \(\d+d\d+h\)\nclaude: no data\n/);
  const missing = { ...thread, codexRateLimits: { primary: { ...thread.codexRateLimits.primary, resets_at: epochMs } } };
  assert.doesNotMatch(whatsappDebugFooter({ thread: missing }), /\(\d+[dhm][^)]*\)|reset:/);
  const invalid = { ...thread, codexRateLimits: { secondary: { ...thread.codexRateLimits.secondary, resets_at: "bad" } } };
  const invalidFooter = whatsappDebugFooter({ thread: invalid });
  assert.match(invalidFooter, /\ncodex wk: 60%\n/);
  assert.doesNotMatch(invalidFooter, /\(\d+[dhm][^)]*\)|reset:/);
});

test("footer reset respects existing suppression and replaces rather than duplicates footer", () => {
  const options = { thread, message: { source: "codex-app-server", role: "assistant" }, env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1", ORKESTR_ADMIN_USER_ID: "owner-a" } };
  const once = appendWhatsAppDebugFooter("Reply.", options);
  assert.match(once, /\ncodex 5h: 80% wk: 60% \(\d+d\d+h\)\n/);
  const twice = appendWhatsAppDebugFooter(once, options);
  assert.equal((twice.match(/^dbg: /gm) || []).length, 1);
  assert.equal((twice.match(/^codex /gm) || []).length, 1);
  assert.equal((twice.match(/\(\d+d\d+h\)/g) || []).length, 1);
  assert.equal(appendWhatsAppDebugFooter(once, { ...options, appendDebugFooter: false }), "Reply.");
  assert.equal(appendWhatsAppDebugFooter("Reply.", { ...options, env: { ...options.env, ORKESTR_WHATSAPP_DEBUG_FOOTER: "0" } }), "Reply.");
  assert.equal(appendWhatsAppDebugFooter("Reply.", { ...options, thread: { ...thread, binding: { suppressWhatsAppDebugFooter: true } } }), "Reply.");
  assert.equal(appendWhatsAppDebugFooter("Reply.", { ...options, thread: { ...thread, ownerUserId: "contained-user" } }), "Reply.");
});

test("owner timezone lookup is owner scoped, transient, bounded and safely falls back", async () => {
  const seen = [];
  const enriched = await withWhatsAppOwnerTimezone(thread, {}, async owner => { seen.push(owner); return { profile: { timezone: "Europe/Berlin" } }; });
  assert.deepEqual(seen, ["owner-a"]);
  assert.equal(enriched.whatsAppDebugOwnerTimezone, "Europe/Berlin");
  assert.equal(thread.whatsAppDebugOwnerTimezone, undefined);
  assert.equal((await withWhatsAppOwnerTimezone(thread, {}, async () => { throw Error("offline"); })).whatsAppDebugOwnerTimezone, "UTC");
  assert.equal((await withWhatsAppOwnerTimezone(thread, {}, () => new Promise(() => {}))).whatsAppDebugOwnerTimezone, "UTC");
  assert.equal(await withWhatsAppOwnerTimezone(null), null);
});
