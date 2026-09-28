import { appendEvent } from "../../storage/src/store.js";
import { claudeModelCatalog } from "./claude-model-controls.js";
import { runSettingsOperation } from "./codex-settings-operations.js";
import { updateThread } from "./threads.js";

// `/model` and `/effort` on a Claude Code thread set the Claude model/effort
// used from the next turn on. `/fast` stays Codex-only.

const claudeEfforts = ["low", "medium", "high", "max"];

function clean(value = "") {
  return String(value || "").trim();
}

function configuredModels(env = process.env) {
  return clean(env.ORKESTR_CLAUDE_CODE_MODELS).split(",").map(clean).filter(Boolean);
}

export function validateClaudeModelChoice(model, env = process.env) {
  const value = clean(model);
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(value)) return false;
  const configured = configuredModels(env);
  return !configured.length || configured.includes(value);
}

function currentText(thread, env) {
  const metadata = thread.executor?.metadata || {};
  const model = clean(thread.claudeModel || metadata.claudeModel) || "default";
  const effort = clean(thread.claudeEffort || metadata.claudeEffort) || "high";
  const models = claudeModelCatalog(thread, env).map((entry) => entry.id).join(", ");
  return `Claude Code model: ${model}, effort: ${effort}. Available models: ${models}. Efforts: ${claudeEfforts.join(", ")}.`;
}

async function applyClaudeSetting(thread, parsed, env) {
  const command = parsed.command;
  const value = clean(parsed.text).split(/\s+/)[0] || "";
  if (command === "fast") {
    return { ok: false, outcome: "unsupported", replyText: "/fast is Codex-only. On Claude Code threads use /model or /effort, or /agent codex to switch executors." };
  }
  if (!value) return { ok: true, outcome: "read", action: "read", replyText: currentText(thread, env) };
  const metadata = { ...(thread.executor?.metadata || {}) };
  const patch = { claudeModelUpdatedAt: new Date().toISOString() };
  if (command === "model") {
    if (!validateClaudeModelChoice(value, env)) {
      return { ok: false, outcome: "invalid", replyText: `Claude model "${value.slice(0, 80)}" is not available. ${currentText(thread, env)}` };
    }
    patch.claudeModel = metadata.claudeModel = value;
  } else {
    const effort = value.toLowerCase();
    if (!claudeEfforts.includes(effort)) return { ok: false, outcome: "invalid", replyText: `Claude effort must be one of: ${claudeEfforts.join(", ")}.` };
    patch.claudeEffort = metadata.claudeEffort = effort;
  }
  await updateThread(thread.id, { ...patch, executor: { ...(thread.executor || {}), metadata } }, env);
  await appendEvent({ type: "claude_model_controls", threadId: thread.id, outcome: "completed", source: "chat_command", command }, env).catch(() => {});
  const label = command === "model" ? `model ${patch.claudeModel}` : `effort ${patch.claudeEffort}`;
  return { ok: true, outcome: "completed", action: command, replyText: `Claude Code ${label} applies from the next turn.` };
}

export async function executeClaudeSettingsCommand(thread, parsed, { key, surface, hasAttachments = false } = {}, env = process.env) {
  const operation = async () => hasAttachments
    ? { ok: false, outcome: "invalid", replyText: "Settings commands cannot include attachments. Send attachments separately." }
    : applyClaudeSetting(thread, parsed, env);
  return runSettingsOperation({ key, surface, command: parsed.command }, operation, env);
}
