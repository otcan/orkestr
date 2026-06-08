const CONTROL_COMMANDS = new Set([
  "now",
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
  "rt",
  "runtime",
  "agent",
  "api",
  "terminal",
  "tmux",
  "attached",
]);

export function parseThreadInputCommand(input = {}) {
  const text = String(input.text || "");
  const match = text.trimStart().match(/^\/([a-z][a-z0-9_-]*)(?:\b|$)([\s:.,-]*)([\s\S]*)$/i);
  if (!match) return { command: null, text };

  const command = match[1].toLowerCase();
  if (!CONTROL_COMMANDS.has(command)) return { command: null, text };

  const runtimeAlias = ["agent", "api", "terminal", "tmux", "attached"].includes(command);
  return {
    command: runtimeAlias || command === "rt" || command === "runtime"
      ? "runtime_type"
      : command === "now"
        ? "interrupt"
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
      ? [command, String(match[3] || "").trimStart()].filter(Boolean).join(" ").trim()
      : String(match[3] || "").trimStart(),
  };
}
