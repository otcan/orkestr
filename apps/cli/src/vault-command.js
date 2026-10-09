import { readCodexVaultTurnToken } from "../../../packages/core/src/vault-codex-turn-tokens.js";
import { effectiveCliEnv, requestJson } from "./api-client.js";
import { VAULT_FILL_USAGE, vaultFillCommand } from "./vault-fill-command.js";

// `orkestr vault list|exec|get|totp` (docs/vault.md). Agent-side access to
// vault items granted to the calling thread. `exec` is the preferred way to
// use a credential: values go into the child's environment only and are
// never printed. Secret values are never accepted as argv.

export const VAULT_USAGE = [
  "Usage:",
  "  orkestr vault list [--json]",
  "  orkestr vault exec <item> -- <command> [args...]   (injects VAULT_USERNAME / VAULT_PASSWORD)",
  "  orkestr vault get <item> --field username|password   (prefer exec; prints the value)",
  "  orkestr vault totp <item> [--wait seconds] [--json]  (needs owner approval per code)",
  VAULT_FILL_USAGE,
].join("\n");

const valueFlags = new Set(["--field", "--wait", "--cwd"]);

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? "");
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : "";
}

function positionals(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (valueFlags.has(item)) {
      index += 1;
      continue;
    }
    if (!item.startsWith("--")) values.push(item);
  }
  return values;
}

function assertNoSecretArgv(argv) {
  if (argv.some((item) => /^--(?:password|secret|value|secret-value|totp-secret)(?:=|$)/.test(item))) {
    throw new Error("vault_value_flag_disabled: secret values are never accepted as command-line arguments");
  }
}

/**
 * Per-turn thread token: injected into the environment (Claude Code turns) or
 * read from the calling Codex thread's 0600 token file (CODEX_THREAD_ID).
 */
async function threadToken(ctx) {
  const injected = String(ctx.env?.ORKESTR_VAULT_THREAD_TOKEN || "").trim();
  if (injected) return injected;
  const env = ctx.env || process.env;
  return readCodexVaultTurnToken(env, String(effectiveCliEnv(env).ORKESTR_HOME || "").trim());
}

/** Request context that sends the thread token header (never argv or URL). */
function vaultCtx(ctx, token) {
  return token ? { ...ctx, headers: { "x-orkestr-thread-token": token } } : ctx;
}

/**
 * Thread of the calling agent: "" when a thread token is present (the server
 * derives it), else ORKESTR_THREAD_ID or whereiam by cwd (legacy mode only).
 */
export async function resolveVaultThreadId(argv, ctx, token = "") {
  if (token) return "";
  const fromEnv = ["ORKESTR_THREAD_ID", "ORKESTR_CURRENT_THREAD_ID", "ORKESTR_RUNTIME_THREAD_ID"]
    .map((key) => String(ctx.env?.[key] || "").trim())
    .find(Boolean);
  if (fromEnv) return fromEnv;
  const cwd = flag(argv, "--cwd") || ctx.cwd || ctx.env?.ORKESTR_CALLER_CWD || process.cwd();
  const params = new URLSearchParams({ cwd });
  const where = await requestJson(`/api/whereiam?${params.toString()}`, ctx).catch(() => null);
  const threadId = String(where?.thread?.id || "").trim();
  if (!threadId) throw new Error("vault_thread_unresolved: run inside a managed Orkestr runtime turn (ORKESTR_VAULT_THREAD_TOKEN)");
  return threadId;
}

function formatItems(items = []) {
  if (!items.length) return "No vault items are granted to this thread.\n";
  return `${items.map((item) => [item.id, item.name, item.domain || "-", item.hasPassword ? "password" : "-", item.hasTotp ? "totp" : "-"].join("\t")).join("\n")}\n`;
}

function sleep(ms, ctx) {
  if (typeof ctx.sleepImpl === "function") return ctx.sleepImpl(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function credentials(threadId, item, fields, ctx) {
  return requestJson("/api/vault/agent/credentials", { ...ctx, method: "POST", body: { threadId, item, fields } });
}

async function execCommand(argv, threadId, ctx) {
  const separator = argv.indexOf("--");
  const head = separator >= 0 ? argv.slice(0, separator) : argv;
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const item = positionals(head)[0] || "";
  if (!item || !command.length) throw new Error(VAULT_USAGE);
  const payload = await credentials(threadId, item, ["username", "password"], ctx);
  const env = { ...(ctx.env || process.env), VAULT_USERNAME: String(payload?.username || ""), VAULT_PASSWORD: String(payload?.password || "") };
  delete env.ORKESTR_VAULT_THREAD_TOKEN;
  return new Promise((resolve) => {
    const child = ctx.spawnImpl(command[0], command.slice(1), { stdio: "inherit", env });
    child.on("error", () => {
      ctx.stderr.write("vault_exec_failed: the command could not be started\n");
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : Number(code ?? 1)));
  });
}

async function totpCommand(argv, threadId, ctx, json) {
  const item = positionals(argv)[0] || "";
  if (!item) throw new Error(VAULT_USAGE);
  const waitSeconds = Math.max(0, Math.min(600, Number(flag(argv, "--wait") || 0) || 0));
  const pollMs = Math.max(10, Number(ctx.env?.ORKESTR_VAULT_POLL_MS || 3000) || 3000);
  const deadline = Date.now() + waitSeconds * 1000;
  let payload = await requestJson("/api/vault/agent/totp", { ...ctx, method: "POST", body: { threadId, item } });
  if (payload?.status === "pending") {
    ctx.stderr.write(`Waiting for the owner's approval in the Orkestr vault (approval ${payload.approval?.id}, expires ${payload.approval?.expiresAt}).\n`);
  }
  while (payload?.status === "pending" && waitSeconds > 0 && Date.now() < deadline) {
    await sleep(pollMs, ctx);
    payload = await requestJson("/api/vault/agent/totp", { ...ctx, method: "POST", body: { threadId, item, approvalId: payload.approval?.id } });
  }
  if (payload?.status === "issued") {
    if (json) ctx.stdout.write(`${JSON.stringify({ code: payload.code, expiresInSeconds: payload.expiresInSeconds, period: payload.period, digits: payload.digits })}\n`);
    else ctx.stdout.write(`${payload.code}\n`);
    return 0;
  }
  if (json) ctx.stdout.write(`${JSON.stringify({ status: payload?.status, approval: payload?.approval || null })}\n`);
  if (payload?.status === "pending") {
    if (!json) ctx.stderr.write("vault_totp_pending: rerun `orkestr vault totp` (or use --wait) after the owner approves\n");
    return 3;
  }
  ctx.stderr.write(`vault_totp_${payload?.status || "unavailable"}\n`);
  return 1;
}

export async function vaultCommand(argv = [], ctx) {
  const [subcommand = "", ...rest] = argv;
  const separator = rest.indexOf("--");
  assertNoSecretArgv(separator >= 0 ? rest.slice(0, separator) : rest);
  const json = (separator >= 0 ? rest.slice(0, separator) : rest).includes("--json");
  if (!["list", "ls", "exec", "get", "totp", "fill"].includes(subcommand)) {
    ctx.stderr.write(`${VAULT_USAGE}\n`);
    return subcommand ? 2 : 0;
  }
  const token = await threadToken(ctx);
  const threadId = await resolveVaultThreadId(separator >= 0 ? rest.slice(0, separator) : rest, ctx, token);
  ctx = vaultCtx(ctx, token);
  if (subcommand === "list" || subcommand === "ls") {
    const payload = await requestJson(`/api/vault/agent/items?${new URLSearchParams(threadId ? { threadId } : {}).toString()}`, ctx);
    ctx.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : formatItems(payload?.items || []));
    return 0;
  }
  if (subcommand === "exec") return execCommand(rest, threadId, ctx);
  if (subcommand === "totp") return totpCommand(rest, threadId, ctx, json);
  if (subcommand === "fill") return vaultFillCommand(rest, threadId, ctx, json, VAULT_USAGE);
  const item = positionals(rest)[0] || "";
  const field = flag(rest, "--field");
  if (!item || !["username", "password"].includes(field)) throw new Error(VAULT_USAGE);
  const payload = await credentials(threadId, item, [field], ctx);
  ctx.stdout.write(`${String(payload?.[field] ?? "")}\n`);
  return 0;
}
