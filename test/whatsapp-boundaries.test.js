import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireOutboundDeliveryClaim,
  deliveryTextKey,
  finishOutboundDeliveryClaim,
  outboundDeliveryClaimExpired,
  outboundDeliveryKey,
  pruneOutboundDeliveryClaims,
} from "../packages/connectors/src/whatsapp-delivery-ledger.js";
import { appendWhatsAppDebugFooter, formatWhatsAppOutboundText, stripWhatsAppDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";
import { whatsappInboundThreadMatchesBinding } from "../packages/connectors/src/whatsapp-inbound-routing.js";
import { shouldMirrorWhatsAppProgress, shouldMirrorWhatsAppReply } from "../packages/connectors/src/whatsapp-mirror-policy.js";
import { formatWhatsAppQueueNotice, initialQueueDeliveryState } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
import { createWhatsAppOutboundMirrorWorker } from "../packages/connectors/src/whatsapp-outbound-worker.js";

test("WhatsApp formatting strips plan envelopes and preserves code fences", () => {
  const formatted = formatWhatsAppOutboundText([
    "<proposed_plan>",
    "# Plan",
    "",
    "**Bold** [Docs](https://example.com/docs) `literal **x**`",
    "```js",
    "**do not touch**",
    "```",
    "</proposed_plan>",
  ].join("\n"));

  assert.equal(formatted, [
    "Plan",
    "",
    "*Bold* Docs: https://example.com/docs `literal **x**`",
    "```js",
    "**do not touch**",
    "```",
  ].join("\n"));
});

test("WhatsApp debug footer is gated and marks progress as update", () => {
  const defaultDisabled = appendWhatsAppDebugFooter("Done", {
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.equal(defaultDisabled, "Done");

  const disabled = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "0" },
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.equal(disabled, "Done");

  const aliasEnabled = appendWhatsAppDebugFooter("Done", {
    env: { WA_DEBUG_FOOTER: "1" },
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.match(aliasEnabled, /^Done\n\ndbg: /);

  const appendAliasEnabled = appendWhatsAppDebugFooter("Done", {
    env: { WA_APPEND_DEBUG_FOOTER: "1" },
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.match(appendAliasEnabled, /^Done\n\ndbg: /);

  const callerDisabled = appendWhatsAppDebugFooter("Done", {
    env: { WA_DEBUG_FOOTER: "1" },
    appendDebugFooter: false,
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.equal(callerDisabled, "Done");

  const enabled = appendWhatsAppDebugFooter("Working", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1", ORKESTR_DEFAULT_CODEX_MODEL: "gpt-test" },
    deliveryType: "progress",
    message: { source: "codex-app-server", phase: "commentary" },
    thread: { codexModeLive: "plan", runtimeKind: "codex-tmux", paneId: "%42" },
    messages: [{ id: "u1", role: "user", state: "queued" }],
  });
  assert.match(enabled, /^Working\n\ndbg: /);
  assert.match(enabled, /m:gpt-test/);
  assert.match(enabled, /mode:plan/);
  assert.match(enabled, /rt:tmux/);
  assert.match(enabled, /msg:update/);
  assert.match(enabled, /mode-switch:\/code/);
  assert.match(enabled, /rt-switch:\/switch-api/);

  const apiRuntime = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
    message: { source: "codex-app-server", phase: "final_answer" },
    thread: { runtimeKind: "codex-app-server" },
  });
  assert.match(apiRuntime, /rt:api/);
  assert.match(apiRuntime, /mode-switch:\/plan/);
  assert.match(apiRuntime, /rt-switch:\/switch-terminal/);
});

test("WhatsApp debug footer reports Claude Code model, runtime, and usage without Codex-only controls", () => {
  const thread = {
    runtimeKind: "claude-code",
    runtimeMode: "sleeping",
    claudeModel: "sonnet",
    claudeEffort: "high",
    claudeRateLimits: {
      primary: { used_percent: 20, window_minutes: 300 },
      secondary: { used_percent: 35, window_minutes: 10080 },
    },
    executor: { type: "claude-code", metadata: {} },
  };
  const final = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1", ORKESTR_SETTINGS_COMMANDS_ENABLED: "1" },
    message: { source: "claude-code", phase: "final_answer" },
    thread,
  });

  assert.match(final, /^Done\n\ndbg: m:sonnet\/h · agent:claude-code · rt:claude · msg:final · quota:remaining · 5h:80% · wk:65%/);
  assert.doesNotMatch(final, /fast:|mode:|model:\/model|mode-switch:|rt-switch:/);
  assert.equal(stripWhatsAppDebugFooter(final), "Done");

  const waking = appendWhatsAppDebugFooter("Waking this thread.", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
    deliveryType: "queue_notice",
    message: { source: "whatsapp_inbound", role: "user", state: "queued", deliveryState: "waiting_runtime_start" },
    thread,
    messages: [],
  });
  assert.match(waking, /^Waking this thread\.\n\ndbg: m:sonnet\/h · agent:claude-code · rt:claude · msg:update · quota:remaining · 5h:80% · wk:65% · queue:1 · reason:waking/);
  assert.doesNotMatch(waking, /mode-switch:|rt-switch:/);
});

test("WhatsApp Claude footer replaces stale or unavailable usage with explicit safe states", () => {
  const allowed = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
    message: { source: "claude-code", phase: "final_answer" },
    thread: {
      runtimeKind: "claude-code",
      claudeModel: "sonnet",
      claudeEffort: "medium",
      claudeRateLimits: {
        primary: { status: "allowed", window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary: null,
        plan_type: "claude_subscription",
      },
      executor: { type: "claude-code", metadata: {} },
    },
  });
  assert.match(allowed, / · quota:remaining · 5h:available · 5h-reset:/);
  assert.match(allowed, / · wk:unknown · /);
  assert.doesNotMatch(allowed, / · 5h:0%/);

  const expired = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
    message: { source: "claude-code", phase: "final_answer" },
    thread: {
      runtimeKind: "claude-code",
      claudeModel: "sonnet",
      claudeEffort: "medium",
      claudeRateLimits: {
        primary: { status: "rejected", used_percent: 100, window_minutes: 300, resets_at: 1 },
        secondary: null,
        plan_type: "claude_subscription",
      },
      executor: { type: "claude-code", metadata: {} },
    },
  });
  assert.match(expired, / · 5h:unknown · wk:unknown · /);
  assert.doesNotMatch(expired, /5h-reset:|wk-reset:/);
  assert.doesNotMatch(expired, / · 5h:0%/);
});

test("WhatsApp Claude footer validates percentages and classifies both reset windows", () => {
  const final = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
    message: { source: "claude-code", phase: "final_answer" },
    thread: {
      runtimeKind: "claude-code",
      claudeRateLimits: {
        primary: { used_percent: 25, window_minutes: 10080, resets_at: Date.parse("2099-09-26T12:20:00Z") / 1000 },
        secondary: { status: "rejected", used_percent: 100, window_minutes: 300, resets_at: Date.parse("2099-09-25T12:20:00Z") / 1000 },
      },
      executor: { type: "claude-code", metadata: {} },
    },
  });
  assert.match(final, / · 5h:0% · 5h-reset:25 Sept 12:20 UTC · wk:75% · wk-reset:26 Sept 12:20 UTC · /);

  for (const used_percent of [-1, 101, "not-a-number"]) {
    const invalid = appendWhatsAppDebugFooter("Done", {
      env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" },
      message: { source: "claude-code", phase: "final_answer" },
      thread: {
        runtimeKind: "claude-code",
        claudeRateLimits: { primary: { used_percent, window_minutes: 300 }, secondary: null },
        executor: { type: "claude-code", metadata: {} },
      },
    });
    assert.match(invalid, / · 5h:unknown · wk:unknown · /);
  }
});

test("WhatsApp mirror policy forwards Codex final replies and progress updates", () => {
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "final_answer" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "commentary" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "commentary" }), true);
  assert.equal(
    shouldMirrorWhatsAppProgress(
      { source: "codex-app-server", phase: "commentary" },
      { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "0" },
    ),
    true,
  );
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server-import", phase: "final_answer" }), true);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server-import", phase: "commentary" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "claude-code", phase: "final_answer" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "claude-code", phase: "commentary" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "claude-code", phase: "commentary" }), true);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "awaiting_approval" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "context_compaction" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "context_compaction" }), false);
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "future_codex_phase" }), true);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "future_codex_phase" }), false);
  assert.equal(shouldMirrorWhatsAppReply({ source: "manual", phase: "commentary" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "watcher-alert", phase: "final_answer" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "watcher-alert", phase: "commentary" }), false);
  assert.equal(shouldMirrorWhatsAppReply({ source: "watcher-alert-lifecycle", phase: "final_answer" }), false);
});

test("WhatsApp outbound mirror worker serializes delivery and maps app-server queue states", async () => {
  const worker = createWhatsAppOutboundMirrorWorker();
  let runs = 0;
  let release;
  const first = worker.run(() => new Promise((resolve) => {
    runs += 1;
    release = resolve;
  }));
  const second = worker.run(() => {
    runs += 1;
    return "second";
  });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runs, 1);
  release("done");
  assert.equal(await first, "done");
  assert.equal(runs, 1);

  assert.equal(initialQueueDeliveryState({
    state: "sleeping",
    runtimeKind: "codex-app-server",
    promptReady: false,
  }, { text: "hello" }), "waking");
  assert.equal(initialQueueDeliveryState({
    state: "working",
    runtimeKind: "codex-app-server",
    activeTurnId: "turn-1",
  }, { text: "hello" }), "awaiting_active_turn");
});

test("WhatsApp treats ready Claude Code as sessionless but immediately available", () => {
  assert.equal(initialQueueDeliveryState({
    state: "ready",
    runtimeKind: "claude-code",
    promptReady: true,
    sessionName: null,
  }, { text: "start the task" }), "");
  assert.equal(initialQueueDeliveryState({
    state: "working",
    runtimeKind: "claude-code",
    promptReady: false,
    sessionName: null,
  }, { text: "queue this" }), "awaiting_runtime_completion");
  assert.equal(initialQueueDeliveryState({
    state: "sleeping",
    runtimeKind: "claude-code",
    promptReady: false,
    sessionName: null,
  }, { text: "wake this" }), "waiting_runtime_start");
  assert.equal(initialQueueDeliveryState({
    state: "ready",
    runtimeKind: "claude-code",
    promptReady: false,
    sessionName: null,
  }, { text: "wait for login" }), "waiting_runtime_ready");
});

test("WhatsApp explains Claude subscription limits without asking for another login", () => {
  const notice = formatWhatsAppQueueNotice({
    text: "Status?",
    routerTraceId: "rt_fixture",
    runtimeBlockReason: "claude_code_rate_limited",
    runtimeBlockWindowMinutes: 300,
    runtimeRetryAt: new Date(Date.now() + 65 * 60_000).toISOString(),
  }, "waiting_runtime_ready");

  assert.match(notice, /^Claude Code hit this subscription’s shared 5-hour usage limit\./);
  assert.match(notice, /Retrying automatically in about 1h 5m; no new login is needed\./);
  assert.match(notice, /Queued: "Status\?"\./);
  assert.match(notice, /Trace: rt_fixture$/);
  assert.doesNotMatch(notice, /handoff|startup/);
});

test("WhatsApp inbound routing requires explicit participants unless a generated group boundary is trusted", () => {
  const baseThread = {
    binding: {
      connector: "whatsapp",
      chatId: "group-1@g.us",
      generated: true,
      senderAccountId: "wa-1",
      responderAccountId: "wa-1",
      outboundAccountId: "wa-1",
      senderContactId: "wa-contact-short@c.us",
      responderContactId: "wa-contact-short-responder@c.us",
      additionalParticipantsEnabled: false,
      additionalParticipantIds: [],
    },
  };

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: baseThread,
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "wa-lid-primary@lid",
    fromMe: false,
  }), true);

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: { binding: { ...baseThread.binding, generated: false } },
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "wa-lid-primary@lid",
    fromMe: false,
  }), false);

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: { binding: { ...baseThread.binding, generated: false, additionalParticipantsEnabled: true, additionalParticipantIds: ["wa-lid-primary@lid"] } },
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "wa-lid-primary@lid",
    fromMe: false,
  }), true);
});

test("WhatsApp delivery ledger claims prevent concurrent duplicate sends", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ledger-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "5000" };
  const state = { outboundDeliveryClaims: [] };
  const persistState = async () => {};
  const textKey = deliveryTextKey("chat-1", "same message");

  const first = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(first.acquired, true);

  const second = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "delivery_claim_active");

  await finishOutboundDeliveryClaim({
    state,
    claim: first.claim,
    filePath: first.filePath,
    status: "delivered",
    delivery: { deliveredAt: new Date().toISOString() },
  }, env, { persistState });

  assert.equal((await fs.stat(first.filePath).catch(() => null)), null);
  assert.equal(outboundDeliveryKey({ kind: "thread", deliveryType: "final", chatId: "chat-1", accountId: "wa-1", messageId: "message-1", textKey }).includes("chat-1"), true);
  assert.equal(outboundDeliveryClaimExpired({ status: "claimed", updatedAt: "2000-01-01T00:00:00.000Z" }, Date.now(), env), true);
  assert.equal(pruneOutboundDeliveryClaims([{ claimKey: "old", updatedAt: "2000-01-01T00:00:00.000Z" }], { env }).length, 0);
});

test("WhatsApp delivery ledger releases failed claim files for retry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ledger-failed-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "60000" };
  const state = { outboundDeliveryClaims: [] };
  const persistState = async () => {};
  const textKey = deliveryTextKey("chat-1", "retry message");

  const first = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(first.acquired, true);

  await finishOutboundDeliveryClaim({
    state,
    claim: first.claim,
    filePath: first.filePath,
    status: "failed",
    error: "temporary bridge failure",
  }, env, { persistState });

  assert.equal((await fs.stat(first.filePath).catch(() => null)), null);

  const retry = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(retry.acquired, true);
});
