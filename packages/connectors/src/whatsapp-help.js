// `/help` in a WhatsApp chat bound to an Orkestr thread: the live thread status
// followed by the commands that apply to this thread. Command hints used to
// live in the debug footer; they are listed here instead.
import { modelControlsReadOnlyReason } from "../../core/src/codex-model-controls.js";
import { threadQuotaProvider } from "../../core/src/provider-quota-snapshot.js";

function clean(value = "") {
  return String(value || "").trim();
}

export function whatsappHelpCommand(text = "") {
  return /^\/help(?:\s|$)/i.test(clean(text));
}

function claudeThread(thread = {}) {
  return threadQuotaProvider(thread) === "claude";
}

function codexMode(thread = {}) {
  const mode = clean(thread.codexModeLive || thread.runtime?.progress?.codexMode || thread.runtime?.codexMode || thread.codexMode).toLowerCase();
  return mode === "plan" ? "plan" : "code";
}

// Same gate the footer used for its model/effort/fast hints: only advertise
// settings commands that the thread can actually apply.
function settingsCommandsAvailable(thread = {}, claude = false, env = process.env) {
  if (env.ORKESTR_SETTINGS_COMMANDS_ENABLED === "0") return false;
  if (claude) return true;
  return !thread.codexSettingsUncertain && !modelControlsReadOnlyReason(thread, env);
}

export function formatWhatsAppHelp({ thread = {}, statusText = "", env = process.env } = {}) {
  const claude = claudeThread(thread);
  const settings = settingsCommandsAvailable(thread, claude, env);
  const lines = ["*Orkestr help*", ""];
  if (clean(statusText)) lines.push(clean(statusText), "");
  lines.push(
    "*Messages*",
    "Normal messages go to this thread; while it is busy they queue.",
    "/now <message> – interrupt the current run and send this now",
    "/stop – stop the current run",
    "/status – thread status",
    "",
    "*Runtime*",
    "/restart – restart this thread's runtime (alias /reset)",
    "/hard_reset – checkpoint the context, then restart",
    "",
    "*Agent*",
    claude
      ? "/codex – switch this thread to Codex (now: Claude Code)"
      : threadQuotaProvider(thread) === "codex"
        ? "/claude – switch this thread to Claude Code (now: Codex)"
        : "/claude or /codex – switch this thread's agent",
  );
  if (settings) {
    lines.push(
      "/model [name] – show or set the model",
      "/effort [level] – show or set the reasoning effort",
    );
  }
  if (!claude) {
    if (settings) lines.push("/fast – toggle Codex fast mode");
    lines.push(
      `/plan [message] or /code [message] – planning or coding mode (now: ${codexMode(thread)})`,
      "/rt api | /rt terminal – switch the Codex runtime surface",
    );
  }
  lines.push(
    "",
    "*Footer*",
    "Line 1: agent/model, runtime and message type (update or final).",
    "Lines 2–3: remaining Codex and Claude quota with time until reset.",
    "Line 4: queued messages, host load and Orkestr CPU.",
  );
  return lines.join("\n");
}
