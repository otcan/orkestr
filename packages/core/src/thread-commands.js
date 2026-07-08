const CONTROL_COMMANDS = new Set([
  "now",
  "steer",
  "interrupt",
  "implement",
  "stop",
  "reset",
  "restart",
  "hard_reset",
  "hard-reset",
  "safe_reset",
  "safe-reset",
  "plan",
  "planning",
  "code",
  "coding",
  "switch",
  "rt",
  "runtime",
  "agent",
  "api",
  "terminal",
  "term",
  "tmux",
  "attached",
]);

const RUNTIME_ALIAS_COMMANDS = new Set(["agent", "api", "terminal", "term", "tmux", "attached"]);

function switchModeCommand(text = "") {
  const match = String(text || "").trimStart().match(/^([a-z][a-z0-9_-]*)(?:\b|$)([\s:.,-]*)([\s\S]*)$/i);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (token === "plan" || token === "planning") {
    return { command: "plan", text: String(match[3] || "").trimStart() };
  }
  if (token === "code" || token === "coding") {
    return { command: "code", text: String(match[3] || "").trimStart() };
  }
  return null;
}

export function parseThreadInputCommand(input = {}) {
  const text = String(input.text || "");
  const match = text.trimStart().match(/^\/([a-z][a-z0-9_-]*)(?:\b|$)([\s:.,-]*)([\s\S]*)$/i);
  if (!match) return { command: null, text };

  const command = match[1].toLowerCase();
  if (!CONTROL_COMMANDS.has(command)) return { command: null, text };

  const rawText = String(match[3] || "").trimStart();
  if (command === "switch") {
    const mode = switchModeCommand(rawText);
    if (mode) return { command: mode.command, rawCommand: command, text: mode.text };
    return { command: "runtime_type", rawCommand: command, text: rawText };
  }

  const runtimeAlias = RUNTIME_ALIAS_COMMANDS.has(command);
  return {
    command: runtimeAlias || command === "rt" || command === "runtime"
      ? "runtime_type"
      : command === "now"
        ? "steer"
        : command === "restart"
          ? "reset"
          : command === "hard-reset"
            ? "hard_reset"
            : command === "safe-reset"
              ? "safe_reset"
              : command === "planning"
                ? "plan"
                : command === "coding"
                  ? "code"
                  : command,
    rawCommand: command,
    text: runtimeAlias
      ? [command, rawText].filter(Boolean).join(" ").trim()
      : rawText,
  };
}
