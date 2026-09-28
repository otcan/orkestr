export type SlashCommandInfo = {
  command: string;
  aliases: string[];
  label: string;
  detail: string;
  acceptsText: boolean;
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
    command: "/model",
    aliases: [],
    label: "Thread model",
    detail: "Show or set the Codex model and reasoning effort for this thread.",
    acceptsText: true,
  },
  {
    command: "/fast",
    aliases: [],
    label: "Fast mode",
    detail: "Show fast status. Use /fast enable, disable, or toggle to change it.",
    acceptsText: true,
  },
  {
    command: "/effort",
    aliases: [],
    label: "Reasoning effort",
    detail: "Show current and supported efforts, or use /effort <level> to change it.",
    acceptsText: true,
  },
  {
    command: "/now",
    aliases: [],
    label: "Interrupt send",
    detail: "Interrupt the current turn and send the remaining text immediately. Claude Code resumes the same session with it.",
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
    aliases: ["/interrupt", "/cancel", "/quit"],
    label: "Stop runtime",
    detail: "Interrupt the active turn for this thread. Text after the command is not sent.",
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
    detail: "Checkpoint context when possible, then restart the current runtime.",
    acceptsText: false,
  },
  {
    command: "/safe-reset",
    aliases: ["/safe_reset"],
    label: "Safe reset",
    detail: "Save recent Orkestr context and start a fresh Codex session for this thread.",
    acceptsText: false,
  },
];
