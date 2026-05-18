const CONTROL_COMMANDS = new Set(["now", "interrupt", "implement", "stop"]);

export function parseThreadInputCommand(input = {}) {
  const text = String(input.text || "");
  const match = text.trimStart().match(/^\/([a-z][a-z0-9_-]*)(?:\b|$)([\s:.,-]*)([\s\S]*)$/i);
  if (!match) return { command: null, text };

  const command = match[1].toLowerCase();
  if (!CONTROL_COMMANDS.has(command)) return { command: null, text };

  return {
    command: command === "now" ? "interrupt" : command,
    rawCommand: command,
    text: String(match[3] || "").trimStart(),
  };
}
