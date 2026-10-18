import { fileURLToPath } from "node:url";
import { pollingSleepLimit } from "./shell-poll-delay.js";

const hook = fileURLToPath(new URL("./claude-code-polling-hook.js", import.meta.url));
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function claudeCodeToolSettings(options = {}, env = process.env) {
  const settings = {};
  const statusCommand = String(options.statusCaptureCommand || "").trim();
  if (statusCommand) settings.statusLine = { type: "command", command: statusCommand };
  const limit = pollingSleepLimit(env);
  if (limit > 0) settings.hooks = {
    PreToolUse: [{ matcher: "Bash", hooks: [{
      type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(hook)} ${limit}`, timeout: 5,
    }] }],
  };
  return settings;
}
