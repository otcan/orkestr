const CONTROL_COMMANDS = new Set([
  "now",
  "interrupt",
  "cancel",
  "quit",
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
  "model",
  "effort",
  "fast",
  "switch",
  "rt",
  "runtime",
  "agent",
  "claude",
  "codex",
  "api",
  "terminal",
  "term",
  "tmux",
  "attached",
]);

const RUNTIME_ALIAS_COMMANDS = new Set(["api", "terminal", "term", "tmux", "attached"]);
// `/agent api|terminal` keeps its legacy runtime-surface meaning; bare `/agent`
// and `/agent <executor>` address the executor switch (Codex <-> Claude Code).
const LEGACY_AGENT_RUNTIME_TOKENS = new Set(["api", "app", "app-server", "structured", "terminal", "term", "tmux", "attached", "attach", "raw", "raw-terminal"]);

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

// Messages a connected assistant sent over MCP (send_message). By source they
// are always passive, plain text: never a control/settings command, never a
// steer or forced interrupt, whatever flags an older queued record carries
// (e.g. a "/now" rewritten into instant_steer before this rule existed).
export function delegatedAssistantInput(input = {}) {
  return String(input?.source || "").trim() === "thread_bridge_message";
}

// Inputs whose text must never be read as an Orkestr control command. MCP
// messages qualify by source, so inputs queued before they carried
// commandProcessing metadata are covered too.
export function commandInterpretationDisabled(input = {}) {
  return String(input.commandProcessing || "").trim().toLowerCase() === "disabled" ||
    delegatedAssistantInput(input);
}

export function parseThreadInputCommand(input = {}) {
  const text = String(input.text || "");
  if (commandInterpretationDisabled(input)) {
    return { command: null, text };
  }
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

  if (command === "claude" || command === "codex") {
    return { command: "executor", rawCommand: command, text: [command, rawText].filter(Boolean).join(" ").trim() };
  }
  if (command === "agent") {
    const token = rawText.split(/\s+/)[0].toLowerCase();
    if (!LEGACY_AGENT_RUNTIME_TOKENS.has(token)) return { command: "executor", rawCommand: command, text: rawText };
    return { command: "runtime_type", rawCommand: command, text: rawText };
  }

  const runtimeAlias = RUNTIME_ALIAS_COMMANDS.has(command);
  return {
    // `/now <text>` interrupts the active turn and sends <text> immediately;
    // `/interrupt` stays an alias of the preemptive `/stop`.
    command: runtimeAlias || command === "rt" || command === "runtime"
      ? "runtime_type"
      : command === "now"
        ? "interrupt"
      : command === "interrupt" || command === "cancel" || command === "quit"
        ? "stop"
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
