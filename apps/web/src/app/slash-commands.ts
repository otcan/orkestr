export type SlashCommandInfo = {
  command: string;
  aliases: string[];
  label: string;
  detail: string;
  acceptsText: boolean;
};

export type SlashCommandMatch = {
  raw: string;
  commandToken: string;
  argumentText: string;
  info: SlashCommandInfo | null;
  partial: boolean;
};

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    command: "/code",
    aliases: ["/coding"],
    label: "Code mode",
    detail: "Switch Codex to Code mode. Text after the command is sent after switching.",
    acceptsText: true,
  },
  {
    command: "/plan",
    aliases: ["/planning"],
    label: "Plan mode",
    detail: "Switch Codex to Plan mode. Text after the command is sent after switching.",
    acceptsText: true,
  },
  {
    command: "/now",
    aliases: ["/interrupt"],
    label: "Interrupt send",
    detail: "Interrupt the current run and send the remaining text immediately.",
    acceptsText: true,
  },
  {
    command: "/implement",
    aliases: [],
    label: "Implement plan",
    detail: "Answer the visible Codex implementation prompt with option 1.",
    acceptsText: false,
  },
  {
    command: "/stop",
    aliases: [],
    label: "Stop runtime",
    detail: "Stop the active Codex runtime for this thread.",
    acceptsText: false,
  },
  {
    command: "/reset",
    aliases: ["/restart"],
    label: "Reset runtime",
    detail: "Restart the runtime while keeping the thread history.",
    acceptsText: false,
  },
  {
    command: "/hard-reset",
    aliases: ["/hard_reset"],
    label: "Hard reset",
    detail: "Checkpoint context and restart the runtime from a clean session.",
    acceptsText: false,
  },
];

const slashCommandLookup = new Map<string, SlashCommandInfo>(
  SLASH_COMMANDS.flatMap((command) => [command.command, ...command.aliases].map((alias) => [alias, command] as const)),
);

export function parseSlashCommandDraft(value: string): SlashCommandMatch | null {
  const text = String(value || "").trimStart();
  if (!text.startsWith("/")) return null;
  if (text === "/") {
    return {
      raw: "/",
      commandToken: "",
      argumentText: "",
      info: null,
      partial: true,
    };
  }
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:\b|$)([\s:.,-]*)([\s\S]*)$/i);
  if (!match) {
    return {
      raw: text.split(/\s+/)[0] || "/",
      commandToken: text.split(/\s+/)[0]?.toLowerCase() || "",
      argumentText: "",
      info: null,
      partial: false,
    };
  }
  const raw = `/${match[1]}`;
  const commandToken = raw.toLowerCase();
  return {
    raw,
    commandToken,
    argumentText: String(match[3] || "").trimStart(),
    info: slashCommandLookup.get(commandToken) || null,
    partial: false,
  };
}
