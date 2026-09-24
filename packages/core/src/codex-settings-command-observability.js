import { parseThreadInputCommand } from "./thread-commands.js";
import { incrementCounter } from "./observability.js";
import { settingsControlAlert } from "./codex-settings-operations.js";

// Detection only; never rewrite or remove historical messages.
export async function observeSettingsHistoryWrite(input, env) {
  if (input?.role !== "user" || !["model", "effort", "fast"].includes(parseThreadInputCommand(input).command)) return;
  const surface = input.connector === "whatsapp" || input.source === "whatsapp_inbound" ? "whatsapp"
    : ["ui", "ui_input"].includes(input.source) ? "webui" : "";
  if (!surface) return;
  incrementCounter("orkestr_settings_history_leak_total", { surface });
  await settingsControlAlert("settings_history_leak", env);
}
