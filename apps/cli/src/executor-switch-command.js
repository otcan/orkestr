import { requestJson } from "./api-client.js";

export const SWITCH_USAGE = [
  "Usage: orkestr switch <thread> [codex|claude] [--model m] [--effort e] [--profile id] [--now] [--reason text] [--json]",
  "       orkestr switch --self codex|claude --reason text [--model m] [--json]",
].join("\n");

const valueFlags = new Set(["--model", "--effort", "--profile", "--reason", "--cwd", "--api-session-id"]);

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

function positional(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (valueFlags.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("--")) values.push(argv[index]);
  }
  return values;
}

function callerCwd(argv, ctx) {
  return flagValue(argv, "--cwd") || ctx.cwd || String(ctx.env?.ORKESTR_CALLER_CWD || "").trim() || process.cwd();
}

function callerApiSessionId(argv, ctx) {
  const env = ctx.env || {};
  return flagValue(argv, "--api-session-id") ||
    [env.ORKESTR_API_SESSION_ID, env.CODEX_API_SESSION_ID, env.CODEX_SESSION_ID, env.CODEX_CONVERSATION_ID]
      .map((value) => String(value || "").trim()).find(Boolean) || "";
}

// Same resolution as `orkestr whereiam`: the caller's cwd plus any API
// session id identifies the thread the agent itself is running in.
async function resolveSelfThread(argv, ctx) {
  const params = new URLSearchParams();
  params.set("cwd", callerCwd(argv, ctx));
  const apiSessionId = callerApiSessionId(argv, ctx);
  if (apiSessionId) params.set("apiSessionId", apiSessionId);
  const payload = await requestJson(`/api/whereiam?${params.toString()}`, ctx).catch(() => null);
  const id = String(payload?.thread?.id || "").trim();
  if (!payload?.ok || !id) throw new Error("Could not resolve the current Orkestr thread (see `orkestr whereiam`).");
  return id;
}

function formatExecutor(executor = {}) {
  const label = executor.executor === "claude-code" ? "Claude Code" : executor.executor === "codex" ? "Codex" : executor.executor || "unknown";
  const details = [executor.model && `model ${executor.model}`, executor.effort && `effort ${executor.effort}`].filter(Boolean).join(", ");
  const pending = executor.pendingExecutorSwitch ? `\nPending switch: ${executor.pendingExecutorSwitch.target} (after the current turn)` : "";
  return `Executor: ${label}${details ? ` (${details})` : ""}${pending}`;
}

export async function executorSwitchCommand(argv, ctx) {
  const json = argv.includes("--json");
  const self = argv.includes("--self");
  const values = positional(argv);
  const threadId = self ? await resolveSelfThread(argv, ctx) : values[0];
  const target = self ? values[0] : values[1];
  if (!threadId) throw new Error(SWITCH_USAGE);
  const route = `/api/threads/${encodeURIComponent(threadId)}/executor`;
  if (!target) {
    if (self) throw new Error(SWITCH_USAGE);
    const payload = await requestJson(route, ctx);
    ctx.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatExecutor(payload.executor)}\n`);
    return 0;
  }
  const reason = flagValue(argv, "--reason");
  if (self && !reason) throw new Error("orkestr switch --self requires --reason text");
  const body = {
    executor: target,
    ...(flagValue(argv, "--model") ? { model: flagValue(argv, "--model") } : {}),
    ...(flagValue(argv, "--effort") ? { effort: flagValue(argv, "--effort") } : {}),
    ...(flagValue(argv, "--profile") ? { profileId: flagValue(argv, "--profile") } : {}),
    ...(reason ? { reason } : {}),
    when: argv.includes("--now") && !self ? "now" : "after_turn",
    ...(self ? { actor: "self" } : {}),
  };
  const payload = await requestJson(route, { ...ctx, method: "PUT", body });
  ctx.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.replyText || formatExecutor(payload.executor)}\n`);
  return payload?.ok === false ? 1 : 0;
}
