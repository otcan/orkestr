import { readRuntimeSettings } from "./runtime-settings.js";
import { shellQuote } from "./native-terminal.js";

const CODEX_DISABLED_ON_MACOS = "__orkestr_codex_disabled_on_macos__";

function clean(value) {
  return String(value || "").trim();
}

function firstValue(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function commandFlagValue(command, flag) {
  const tokens = clean(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const index = tokens.indexOf(flag);
  if (index < 0) return "";
  return clean(tokens[index + 1] || "").replace(/^["']|["']$/g, "");
}

function commandHasFlag(command, flag) {
  const tokens = clean(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.includes(flag);
}

function commandWithSkipGitRepoCheck(command) {
  const base = clean(command);
  if (!base || commandHasFlag(base, "--skip-git-repo-check")) return base;
  return `${base} --skip-git-repo-check`;
}

function commandFromBin(bin, settings = {}, env = process.env) {
  const executable = clean(bin);
  if (!executable || executable === CODEX_DISABLED_ON_MACOS) return "";
  const configured = clean(settings?.codex?.command);
  const sandbox = firstValue(env.ORKESTR_CODEX_SANDBOX, settings?.codex?.sandbox, commandFlagValue(configured, "--sandbox")) || "workspace-write";
  const approval = firstValue(env.ORKESTR_CODEX_APPROVAL_POLICY, settings?.codex?.approvalPolicy, commandFlagValue(configured, "--ask-for-approval")) || "on-request";
  if (sandbox === "danger-full-access" && approval === "never") {
    return `${executable} --dangerously-bypass-approvals-and-sandbox`;
  }
  return `${executable} --sandbox ${sandbox} --ask-for-approval ${approval} --no-alt-screen`;
}

export async function codexRuntimeCommand(env = process.env) {
  const configured = clean(env.ORKESTR_RUNTIME_CODEX_COMMAND);
  if (configured) return configured === CODEX_DISABLED_ON_MACOS ? "" : configured;
  const bin = clean(env.ORKESTR_CODEX_BIN);
  if (bin) return commandFromBin(bin, {}, env);
  const settings = await readRuntimeSettings(env).catch(() => ({}));
  const settingsCommand = clean(settings?.codex?.command);
  if (settingsCommand) return settingsCommand === CODEX_DISABLED_ON_MACOS ? "" : settingsCommand;
  return commandFromBin("codex", settings, env);
}

export async function codexResumeCommand(options = {}) {
  const { cwd, codexThreadId, env = process.env } = options;
  const id = clean(codexThreadId);
  if (!id) throw new Error("codex_thread_id_required");
  const command = commandWithSkipGitRepoCheck(await codexRuntimeCommand(env));
  if (!command) throw new Error("codex_runtime_command_disabled");
  const workspace = clean(cwd);
  const workspaceArg = workspace ? ` -C ${shellQuote(workspace)}` : "";
  return `${command} resume${workspaceArg} ${shellQuote(id)}`;
}
