import path from "node:path";
import { createHash } from "node:crypto";
import { appHome } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { incrementCounter } from "./observability.js";
import { recordWatcherAlert } from "./watcher-alerts.js";

// These durable tombstones are independent of conversation and outbox retention.
// Never expire them while the source event could still be replayed.
export function settingsOperationKey(scope) {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function operationPath(key, env) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid_settings_operation_key");
  return path.join(appHome(env), "settings-control-operations", key + ".json");
}

export function withSettingsOperationLock(key, env, operation) {
  return withStorageFileLock(operationPath(key, env), operation, { timeoutMs: 20000 });
}

export function readSettingsOperation(key, env) {
  return readJson(operationPath(key, env), null);
}

export async function recordSettingsReplyState(key, replyState, env) {
  const file = operationPath(key, env);
  const record = await readJson(file, null);
  if (!record?.result) throw new Error("settings_operation_incomplete");
  await writeSecretJson(file, { ...record, replyState });
}

export async function settingsControlAlert(code, env) {
  await recordWatcherAlert({ severity: "warning", source: "settings_control", code,
    message: "Settings control needs operator reconciliation; automatic replay is disabled.",
  }, env).catch(() => {});
}

export async function runSettingsOperation({ key, surface, command, recoverOnly = false }, operation, env) {
  return withSettingsOperationLock(key, env, async () => {
    const file = operationPath(key, env);
    let record = await readJson(file, null);
    if (record?.result) {
      if (!recoverOnly) incrementCounter("orkestr_settings_command_deduplicated_total", { surface, command });
      return { ...record.result, duplicate: true };
    }
    const interrupted = Boolean(record) || recoverOnly;
    record ||= { version: 1, operationKey: key, surface, command, startedAt: new Date().toISOString() };
    // Persist BEFORE any catalog or mutation RPC. A process death cannot cause
    // another process to reissue a possibly accepted mutation.
    await writeSecretJson(file, record);
    const result = interrupted
      ? { ok: false, outcome: "unconfirmed", replyText: "This settings command was interrupted and cannot be confirmed. It will not be replayed. Check settings in the WebUI before issuing a new command." }
      : await operation();
    const stored = { ok: result.ok === true, action: result.action || null,
      outcome: result.outcome || (result.ok ? "completed" : "rejected"),
      replyText: result.replyText || result.error || "Settings were not changed." };
    // The record itself is the single redacted control-operation audit.
    await writeSecretJson(file, { ...record, completedAt: new Date().toISOString(), result: stored });
    incrementCounter("orkestr_settings_commands_total", { surface, command, outcome: stored.outcome });
    if (stored.outcome === "unconfirmed") await settingsControlAlert("settings_operation_unconfirmed", env);
    return stored;
  });
}
