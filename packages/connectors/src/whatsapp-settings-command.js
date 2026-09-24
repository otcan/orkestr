import { executeSettingsCommand, parseSettingsCommand } from "../../core/src/codex-settings-command-control.js";
import { getThread } from "../../core/src/threads.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { modelControlsReadOnlyReason } from "../../core/src/codex-model-controls.js";
import { resolveWhatsAppBinding } from "./whatsapp-account-bindings.js";
import { settingsOperationKey, withSettingsOperationLock, runSettingsOperation, readSettingsOperation,
  recordSettingsReplyState, settingsControlAlert } from "../../core/src/codex-settings-operations.js";
import { incrementCounter } from "../../core/src/observability.js";
import { ensureConnectorOutboxJob, getConnectorOutboxJob, listConnectorOutboxJobs, claimConnectorOutboxJob,
  markConnectorOutboxJob, connectorOutboxTerminalState } from "./connector-outbox.js";

// Called only after inbound source dedupe, route resolution and participant
// classification. No phone/account heuristic is an authorization mechanism.
export async function handleWhatsAppSettingsCommand({ thread, text, senderEffectiveRole, accountId, chatId,
  canonicalEventId, hasAttachments = false, client = null }, env = process.env) {
  let parsed = parseSettingsCommand(text);
  const ownerUserId = resourceOwnerUserId(thread || {}, env);
  const key = settingsOperationKey(["whatsapp", ownerUserId, accountId, chatId, thread?.id || "", canonicalEventId]);
  return withSettingsOperationLock(key, env, async () => {
    const existing = await getConnectorOutboxJob("settings-control:" + key, env);
    const record = await readSettingsOperation(key, env);
    if (!parsed && !existing && !record) return null;
    // Changed duplicate bodies cannot become prompts, including a crash between
    // intent creation and journal creation. They still pass current authorization.
    if (!parsed) {
      parsed = { command: record?.command || existing.metadata.settingsCommand };
      text = "/" + parsed.command;
    }
    if (existing && !record) {
      await runSettingsOperation({ key, surface: "whatsapp", command: parsed.command, recoverOnly: true }, null, env);
    }
    // Write the intent before the operation. The recovery worker can close an
    // interrupted intent without replaying any provider mutation.
    const { job } = await ensureConnectorOutboxJob({
      connector: "whatsapp", deliveryType: "control_reply", ownerUserId, tenantId: ownerUserId,
      threadId: thread?.id || "", accountId, chatId, sourceMessageId: key, sourceEventId: key,
      idempotencyKey: "settings-control:" + key, payload: {},
      metadata: { settingsOperationKey: key, settingsCommand: parsed.command },
    }, env);
    const result = await executeSettingsCommand({ thread, text, senderEffectiveRole,
      surface: "whatsapp", sourceOperationKey: key, client, hasAttachments }, env);
    if (result.outcome === "denied") {
      // Do not return a previously authorized result to a reclassified sender.
      const record = await readSettingsOperation(key, env);
      if (!record) await runSettingsOperation({ key, surface: "whatsapp", command: parsed.command }, async () => result, env);
    }
    return { controlCommand: parsed.command, ...result, outboxId: job.id, threadId: thread?.id || null };
  });
}

export async function deliverWhatsAppSettingsReplies(env, send) {
  const { jobs } = await listConnectorOutboxJobs({ connector: "whatsapp", deliveryType: "control_reply",
    state: "pending,claimed,sent_to_broker,failed_retryable", limit: 100 }, env);
  const results = [];
  for (const job of jobs) {
    if (connectorOutboxTerminalState(job.state)) continue;
    const key = job.metadata?.settingsOperationKey;
    if (!/^[a-f0-9]{64}$/.test(key || "")) continue;
    await withSettingsOperationLock(key, env, async () => {
      const result = await runSettingsOperation({ key, surface: "whatsapp",
        command: job.metadata.settingsCommand, recoverOnly: true }, null, env);
      const record = await readSettingsOperation(key, env);
      if (record.replyState) {
        await markConnectorOutboxJob(job.id, {
          state: record.replyState === "delivered" ? "delivered" : record.replyState === "suppressed" ? "suppressed" : "delivery_uncertain",
          metadata: { ...job.metadata, controlReplyOutcome: record.replyState },
        }, env);
        if (record.replyState === "delivery_unknown") {
          incrementCounter("orkestr_settings_control_replies_total", { outcome: "delivery_unknown" });
          await settingsControlAlert("settings_reply_delivery_unknown", env);
        }
        return;
      }
      // Never deliver a stored catalog/result after the owner or route changed.
      const current = job.threadId ? await getThread(job.threadId, env) : null;
      const binding = current ? await resolveWhatsAppBinding({
        thread: current.id, chatId: job.chatId, accountId: job.accountId, ownerUserId: job.ownerUserId,
      }, { env, threads: [current], status: { state: "not_probed" } }) : null;
      if (!current || resourceOwnerUserId(current, env) !== job.ownerUserId || current.deletedAt ||
          !binding?.selected?.enabled || !binding.selected.routeEligible || binding.selected.ownerUserId !== job.ownerUserId ||
          String(binding.selected?.chatId || "") !== job.chatId ||
          (modelControlsReadOnlyReason(current, env) && result.ok)) {
        await recordSettingsReplyState(key, "suppressed", env);
        await markConnectorOutboxJob(job.id, { state: "suppressed", error: "settings_reply_scope_changed" }, env);
        return;
      }
      const claim = await claimConnectorOutboxJob(job.id, { claimant: "settings-control" }, env);
      if (!claim.acquired) {
        if (claim.job?.state === "delivery_uncertain") {
          await recordSettingsReplyState(key, "delivery_unknown", env);
          incrementCounter("orkestr_settings_control_replies_total", { outcome: "delivery_unknown" });
          await settingsControlAlert("settings_reply_delivery_unknown", env);
        }
        return;
      }
      // Durable send-attempt fence survives outbox pruning and process death.
      await recordSettingsReplyState(key, "delivery_unknown", env);
      await markConnectorOutboxJob(job.id, { payload: { text: result.replyText },
        metadata: { ...job.metadata, controlReplyOutcome: "delivery_unknown" } }, env);
      try {
        const ack = await send({ accountId: job.accountId, chatId: job.chatId, text: result.replyText,
          requestId: job.id, routeSentMessage: false });
        const receipt = ack?.id?._serialized || ack?.id || ack?.ids?.[0] || ack?.sent?.[0]?.id ||
          ack?.messageId || ack?.message?.id?._serialized || ack?.message?.id;
        const id = typeof receipt === "string" ? receipt : "";
        if (!id || ack?.ok === false) throw new Error("settings_reply_ack_missing");
        await recordSettingsReplyState(key, "delivered", env);
        await markConnectorOutboxJob(job.id, { state: "delivered", brokerAck: { id },
          metadata: { ...job.metadata, controlReplyOutcome: "delivered" } }, env);
        incrementCounter("orkestr_settings_control_replies_total", { outcome: "delivered" });
        results.push({ outboxId: job.id, state: "delivered" });
      } catch {
        await markConnectorOutboxJob(job.id, { state: "delivery_uncertain", error: "settings_reply_delivery_unknown",
          metadata: { ...job.metadata, controlReplyOutcome: "delivery_unknown", deliveryUncertain: true } }, env);
        incrementCounter("orkestr_settings_control_replies_total", { outcome: "delivery_unknown" });
        await settingsControlAlert("settings_reply_delivery_unknown", env);
        results.push({ outboxId: job.id, state: "delivery_unknown" });
      }
    }).catch(async () => {
      // A bad/locked control record must not stop normal conversation delivery.
      await settingsControlAlert("settings_reply_processing_failed", env);
    });
  }
  return results;
}
