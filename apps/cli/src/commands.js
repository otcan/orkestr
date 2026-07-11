import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startServer } from "../../server/src/server.js";
import {
  approvePairingChallenge,
  listPairingChallenges,
  listSecuritySessions,
  rejectPairingChallenge,
  revokeAllSecuritySessions,
  revokeSecuritySession,
} from "../../../packages/core/src/security.js";
import { readRuntimeSettings } from "../../../packages/core/src/runtime-settings.js";
import { getThread } from "../../../packages/core/src/threads.js";
import { adminPrincipal, userPrincipal } from "../../../packages/core/src/principal.js";
import { createGoogleWorkspaceConnectLink } from "../../../packages/connectors/src/google-workspace.js";
import { closeThreadRegistryCache } from "../../../packages/storage/src/thread-registry.js";
import { rawAttachWatchText } from "../../../packages/core/src/raw-terminal-watch.js";
import { defaultApiBase, requestJson } from "./api-client.js";
import { createCommand } from "./create-command.js";
import { desktopCommand } from "./desktop-command.js";
import { formatRuntimeResources, formatSystemDoctor, formatThreadTable, formatTimerDoctor, formatTimerTable, threadName } from "./format.js";
import { jiraCommand } from "./jira-command.js";
import { pickThread as defaultPickThread } from "./thread-picker.js";

export async function runCli(argv = process.argv.slice(2), context = {}) {
  const global = parseGlobalFlags(argv);
  const command = global.argv[0] || "serve";
  const args = global.argv.slice(1);
  const ctx = {
    env: process.env,
    fetchImpl: globalThis.fetch,
    spawnImpl: spawn,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    pickThread: defaultPickThread,
    ...context,
    baseUrl: global.apiBase || context.baseUrl || defaultApiBase(context.env || process.env),
  };

  try {
    if (global.help || command === "help") return await writeHelp(ctx);
    if (command === "serve" || command.startsWith("--")) return await serve(command.startsWith("--") ? global.argv : args, ctx);
    if (command === "list") return await list(args, ctx);
    if (command === "status") return await statusCommand(args, ctx);
    if (command === "version") return await versionCommand(args, ctx);
    if (command === "instances" || command === "instance") return await releaseInstancesCommand(args, ctx);
    if (command === "whereiam" || command === "whereami") return await whereiamCommand(args, ctx);
    if (command === "settings") return await settingsCommand(args, ctx);
    if (command === "secret" || command === "secrets") return await secretCommand(args, ctx);
    if (command === "doctor") return await doctorCommand(args, ctx);
    if (command === "sanitizer" || command === "sanitize") return await sanitizerCommand(args, ctx);
    if (command === "api-session" || command === "api") return await apiSessionCommand(args, ctx);
    if (command === "whatsapp" || command === "wa") return await whatsappCommand(args, ctx);
    if (command === "timers" || command === "timer") return await timersCommand(args, ctx);
    if (command === "jobs" || command === "job") return await jobsCommand(args, ctx);
    if (command === "connect") return await connectCommand(args, ctx);
    if (command === "security") return await securityCommand(args, ctx);
    if (command === "desktop" || command === "desktops") return await desktopCommand(args, ctx);
    if (command === "jira") return await jiraCommand(args, ctx);
    if (command === "codex") return await codexCommand(args, ctx);
    if (command === "service" || command === "services") return await serviceCommand(args, ctx);
    if (command === "start" || command === "stop" || command === "restart") return await serviceCommand([command, ...args], ctx);
    if (command === "update") return await updateCommand(args, ctx);
    if (command === "rollback") return await updateRollbackCommand(args, ctx);
    if (command === "logs") return await serviceCommand(["logs", ...args], ctx);
    if (command === "thread") return await threadCommand(args, ctx);
    if (command === "create") return await createCommand(args, ctx);
    if (command === "worker") return await workerCommand(args, ctx);
    if (command === "attach") return await attach(args, ctx);
    if (command === "send") return await send(args, ctx);
    if (command === "wake") return await postThreadAction("wake", args, ctx);
    if (command === "sleep") return await postThreadAction("sleep", args, ctx);
    if (command === "reset") return await postThreadAction("reset", args, ctx);
    if (command === "hard-reset" || command === "hard_reset") return await postThreadAction("hard-reset", args, ctx);
    if (command === "safe-reset" || command === "safe_reset") return await postThreadAction("safe-reset", args, ctx);
    ctx.stderr.write(`Unknown command: ${command}\n\n`);
    writeUsage(ctx.stderr);
    return 2;
  } catch (error) {
    ctx.stderr.write(`${error?.message || String(error)}\n`);
    return error?.status === 404 ? 4 : 1;
  }
}

function parseGlobalFlags(argv) {
  const rest = [];
  let apiBase = "";
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--api") {
      apiBase = argv[index + 1] || "";
      index += 1;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else {
      rest.push(value);
    }
  }
  return { apiBase: apiBase.replace(/\/+$/g, ""), argv: rest, help };
}

async function serve(argv, ctx) {
  const port = Number(flagValue(argv, "--port") || ctx.env.PORT || ctx.env.ORKESTR_PORT || 19812);
  const host = flagValue(argv, "--host") || ctx.env.ORKESTR_HOST || "127.0.0.1";
  const server = await startServer({ port, host, openBrowser: argv.includes("--open") });
  return waitForServeShutdown(server);
}

function waitForServeShutdown(server) {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const forceExit = setTimeout(() => {
        resolve(0);
        process.exit(0);
      }, serveShutdownTimeoutMs());
      if (typeof forceExit.unref === "function") forceExit.unref();
      server.close(() => {
        clearTimeout(forceExit);
        resolve(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function serveShutdownTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_SERVE_SHUTDOWN_TIMEOUT_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 10_000;
}

async function list(argv, ctx) {
  const payload = await requestJson("/api/threads/summary", ctx);
  const threads = payload?.threads || [];
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatThreadTable(threads)}\n`);
  return 0;
}

async function statusCommand(argv, ctx) {
  const json = argv.includes("--json");
  const [version, setup, doctor] = await Promise.all([
    settleRequest("/api/version", ctx),
    settleRequest("/api/setup/status", ctx),
    settleRequest("/api/system/doctor", ctx),
  ]);
  const payload = {
    ok: version.ok && setup.ok && (!doctor.ok || doctor.value?.status !== "broken"),
    baseUrl: ctx.baseUrl,
    version: version.value || null,
    setup: setup.value || null,
    doctor: doctor.value || null,
    errors: {
      version: version.error || null,
      setup: setup.error || null,
      doctor: doctor.error || null,
    },
    generatedAt: new Date().toISOString(),
  };
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatStatus(payload)}\n`);
  return payload.ok ? 0 : 1;
}

async function versionCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/version", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatVersion(payload)}\n`);
  return 0;
}

async function releaseInstancesCommand(argv, ctx) {
  const json = argv.includes("--json");
  const params = new URLSearchParams();
  if (argv.includes("--probe")) params.set("probe", "1");
  const payload = await requestJson(`/api/release/instances${params.size ? `?${params.toString()}` : ""}`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatReleaseInstanceTable(payload.instances || [])}\n`);
  return 0;
}

async function secretCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = argv.includes("--json") || rest.includes("--json");
  if (subcommand === "list" || subcommand === "ls") {
    const params = secretParams(rest);
    const payload = await requestJson(`/api/secure-input/secrets${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatSecretTable(payload.secrets || []));
    return 0;
  }
  if (subcommand === "set" || subcommand === "put") {
    const name = positional(rest)[0] || flagValue(rest, "--name") || flagValue(rest, "--secret");
    const inlineValue = flagValue(rest, "--value") || flagValue(rest, "--secret-value");
    if (inlineValue) throw new Error("secret_value_flag_disabled: use interactive TTY input or --stdin so values are not written to shell history");
    const value = await secretValueFromInput(rest, ctx);
    if (!name) throw new Error("Usage: orkestr secret set <name> [--global|--user user-id] [--stdin] [--json]");
    if (!value) throw new Error("secret_value_required");
    const payload = await requestJson("/api/secure-input/secrets", {
      ...ctx,
      method: "POST",
      body: {
        ...secretBodyTarget(rest),
        name,
        value,
      },
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatSecretStatus(payload.secret || {}));
    return 0;
  }
  if (subcommand === "delete" || subcommand === "remove" || subcommand === "rm") {
    const name = positional(rest)[0] || flagValue(rest, "--name") || flagValue(rest, "--secret");
    if (!name) throw new Error("Usage: orkestr secret delete <name> [--global|--user user-id] [--json]");
    const params = secretParams(rest);
    const payload = await requestJson(`/api/secure-input/secrets/${encodeURIComponent(name)}${params.size ? `?${params.toString()}` : ""}`, {
      ...ctx,
      method: "DELETE",
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`Deleted secret ${payload.secret?.handle || name}\n`);
    return 0;
  }
  throw new Error("Usage: orkestr secret [list|set|delete] [--global|--user user-id] [--json]");
}

function secretBodyTarget(argv = []) {
  const body = {};
  const userId = flagValue(argv, "--user") || flagValue(argv, "--user-id") || flagValue(argv, "--owner") || flagValue(argv, "--owner-user-id");
  if (argv.includes("--global")) body.scope = "global";
  else body.scope = "user";
  if (userId) body.userId = userId;
  return body;
}

function secretParams(argv = []) {
  const params = new URLSearchParams();
  const target = secretBodyTarget(argv);
  if (target.scope) params.set("scope", target.scope);
  if (target.userId) params.set("userId", target.userId);
  return params;
}

async function secretValueFromInput(argv = [], ctx = {}) {
  if (argv.includes("--stdin")) return readStdin(ctx.stdin);
  if (typeof ctx.readSecretValue === "function") return String(await ctx.readSecretValue() || "");
  return readHiddenSecretFromTty(ctx);
}

async function readHiddenSecretFromTty(ctx = {}) {
  if (!ctx.stdin?.isTTY) throw new Error("secret_value_required: pass --stdin or run from an interactive TTY");
  ctx.stderr.write("Secret value: ");
  await setTtyEcho(ctx, false);
  try {
    return await readLine(ctx.stdin);
  } finally {
    await setTtyEcho(ctx, true);
    ctx.stderr.write("\n");
  }
}

function setTtyEcho(ctx = {}, enabled = true) {
  const ttyPath = String(ctx.env?.ORKESTR_SECRET_TTY || "/dev/tty");
  const command = `stty ${enabled ? "echo" : "-echo"} < ${shellToken(ttyPath)}`;
  return new Promise((resolve) => {
    const child = ctx.spawnImpl("sh", ["-c", command], { stdio: ["ignore", "ignore", "ignore"] });
    child.on?.("close", () => resolve());
    child.on?.("error", () => resolve());
  });
}

function readLine(stdin) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stdin, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(String(line || "").trim());
    });
    rl.once("error", reject);
  });
}

function formatSecretTable(secrets = []) {
  if (!secrets.length) return "No secrets.\n";
  return [
    "HANDLE\tSCOPE\tOWNER\tSTATUS\tUPDATED",
    ...secrets.map((secret) => [
      secret.handle || "-",
      secret.scope || "-",
      secret.ownerUserId || "-",
      secret.status || "-",
      secret.updatedAt || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatSecretStatus(secret = {}) {
  return [
    `Secret: ${secret.handle || "-"}`,
    `Scope: ${secret.scope || "-"}`,
    `Owner: ${secret.ownerUserId || "-"}`,
    `Status: ${secret.status || "-"}`,
    `Updated: ${secret.updatedAt || "-"}`,
  ].join("\n") + "\n";
}

async function whereiamCommand(argv, ctx) {
  const json = argv.includes("--json");
  const cwd = flagValue(argv, "--cwd") || ctx.cwd || process.cwd();
  const apiSessionId = resolveApiSessionId(argv, ctx);
  const bind = argv.includes("--bind");
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (apiSessionId) params.set("apiSessionId", apiSessionId);
  if (bind) params.set("bind", "1");
  const payload = await requestJson(`/api/whereiam?${params.toString()}`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatWhereAmI(payload)}\n`);
  return payload?.ok === false ? 1 : 0;
}

async function sanitizerCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "check" : argv[0] || "check";
  const rest = subcommand === "check" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "check" || subcommand === "allow") return sanitizerCheckCommand(rest, ctx);
  throw new Error("Usage: orkestr sanitizer check --action action --text text [--url url] [--cwd path] [--json]");
}

async function sanitizerCheckCommand(argv, ctx) {
  const json = argv.includes("--json");
  const text = await sanitizerCheckText(argv, ctx);
  const body = {
    action: flagValue(argv, "--action") || "external.action",
    cwd: flagValue(argv, "--cwd") || ctx.cwd || process.cwd(),
    threadId: flagValue(argv, "--thread") || flagValue(argv, "--thread-id") || resolveThreadId(argv, ctx),
    apiSessionId: resolveApiSessionId(argv, ctx),
    text,
    reason: flagValue(argv, "--reason"),
    url: flagValue(argv, "--url"),
    href: flagValue(argv, "--href"),
    domain: flagValue(argv, "--domain"),
    source: flagValue(argv, "--source") || "orkestr-sanitizer-cli",
  };
  const payload = await requestJson("/api/sanitizer/check", {
    ...ctx,
    method: "POST",
    body,
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const decision = payload?.decision || {};
    const label = payload?.allow === true ? "allowed" : "blocked";
    const reason = decision.reason || payload?.error || "";
    ctx.stdout.write(`Sanitizer: ${label}${reason ? ` (${reason})` : ""}\n`);
  }
  if (payload?.allow === true) return 0;
  return payload?.decision?.unavailable === true ? 2 : 1;
}

async function sanitizerCheckText(argv, ctx) {
  const explicit = flagValue(argv, "--text") || flagValue(argv, "--message");
  if (explicit) return explicit;
  const text = positional(argv).join(" ").trim();
  if (text) return text;
  if (argv.includes("--stdin")) return readStdin(ctx.stdin);
  throw new Error("Usage: orkestr sanitizer check --action action --text text [--url url] [--cwd path] [--json]");
}

async function apiSessionCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "status" : argv[0] || "status";
  const rest = subcommand === "status" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "bind") return apiSessionBindCommand(rest, ctx);
  if (subcommand === "message" || subcommand === "msg" || subcommand === "append") return apiSessionMessageCommand(rest, ctx);
  if (subcommand === "status" || subcommand === "show") return apiSessionStatusCommand(rest, ctx);
  throw new Error("Usage: orkestr api-session [bind|message|status] --api-session-id id [--json]");
}

async function apiSessionBindCommand(argv, ctx) {
  const json = argv.includes("--json");
  const apiSessionId = requireApiSessionId(argv, ctx);
  const cwd = flagValue(argv, "--cwd") || ctx.cwd || process.cwd();
  const body = {
    apiSessionId,
    cwd,
    threadId: flagValue(argv, "--thread") || flagValue(argv, "--thread-id"),
    sessionName: flagValue(argv, "--session-name"),
    paneId: flagValue(argv, "--pane-id"),
    source: flagValue(argv, "--source") || "orkestr-cli",
    metadata: {
      client: "orkestr-cli",
    },
  };
  const payload = await requestJson("/api/session-bindings", {
    ...ctx,
    method: "POST",
    body,
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Bound API session ${payload.binding?.apiSessionId || apiSessionId} to ${payload.thread?.name || payload.binding?.threadId || "thread"}\n`);
  return 0;
}

async function apiSessionMessageCommand(argv, ctx) {
  const json = argv.includes("--json");
  const apiSessionId = requireApiSessionId(argv, ctx);
  const cwd = flagValue(argv, "--cwd") || ctx.cwd || process.cwd();
  if (!argv.includes("--no-bind")) {
    await requestJson(`/api/whereiam?${apiSessionBindQuery({ argv, ctx, apiSessionId, cwd }).toString()}`, ctx);
  }
  const text = await apiSessionMessageText(argv, ctx);
  const body = {
    role: flagValue(argv, "--role") || "assistant",
    phase: flagValue(argv, "--phase") || "final_answer",
    state: flagValue(argv, "--state") || "completed",
    source: flagValue(argv, "--source") || "api-session",
    text,
  };
  const payload = await requestJson(`/api/session-bindings/${encodeURIComponent(apiSessionId)}/messages`, {
    ...ctx,
    method: "POST",
    body,
  }).catch((error) => {
    throw enrichApiSessionMessageError(error);
  });
  if (json) ctx.stdout.write(`${JSON.stringify(compactApiSessionMessagePayload(payload), null, 2)}\n`);
  else {
    const delivery = payload.deliveryState?.state || (payload.deliveryExpected ? "delivered" : "stored");
    ctx.stdout.write(`Recorded ${payload.message?.role || body.role} API session message: ${delivery}\n`);
  }
  return 0;
}

async function apiSessionStatusCommand(argv, ctx) {
  const json = argv.includes("--json");
  const apiSessionId = requireApiSessionId(argv, ctx);
  const payload = await requestJson(`/api/session-bindings/${encodeURIComponent(apiSessionId)}`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const binding = payload.binding || {};
    ctx.stdout.write(`API session ${binding.apiSessionId || apiSessionId}: ${binding.threadId || "unbound"}\n`);
    if (binding.cwd) ctx.stdout.write(`CWD: ${binding.cwd}\n`);
    if (binding.lastMessageAt) ctx.stdout.write(`Last message: ${binding.lastMessageRole || "-"} at ${binding.lastMessageAt}\n`);
  }
  return 0;
}

function apiSessionBindQuery({ argv, apiSessionId, cwd }) {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  const threadId = flagValue(argv, "--thread") || flagValue(argv, "--thread-id");
  if (threadId) params.set("threadId", threadId);
  const sessionName = flagValue(argv, "--session-name");
  if (sessionName) params.set("sessionName", sessionName);
  const paneId = flagValue(argv, "--pane-id");
  if (paneId) params.set("paneId", paneId);
  params.set("apiSessionId", apiSessionId);
  params.set("bind", "1");
  return params;
}

async function apiSessionMessageText(argv, ctx) {
  const explicit = flagValue(argv, "--text") || flagValue(argv, "--message");
  if (explicit) return explicit;
  const text = positional(argv).join(" ").trim();
  if (text) return text;
  if (argv.includes("--stdin")) return readStdin(ctx.stdin);
  throw new Error("Usage: orkestr api-session message <text> --api-session-id id [--role assistant|user] [--phase final_answer]");
}

function resolveApiSessionId(argv, ctx) {
  return flagValue(argv, "--api-session-id") ||
    flagValue(argv, "--api-session") ||
    String(ctx.env?.ORKESTR_API_SESSION_ID || "").trim() ||
    String(ctx.env?.CODEX_API_SESSION_ID || "").trim() ||
    String(ctx.env?.CODEX_SESSION_ID || "").trim() ||
    String(ctx.env?.CODEX_CONVERSATION_ID || "").trim() ||
    String(ctx.env?.OPENAI_SESSION_ID || "").trim();
}

function resolveThreadId(argv, ctx) {
  return String(ctx.env?.ORKESTR_THREAD_ID || "").trim() ||
    String(ctx.env?.ORKESTR_CURRENT_THREAD_ID || "").trim() ||
    String(ctx.env?.ORKESTR_RUNTIME_THREAD_ID || "").trim();
}

function requireApiSessionId(argv, ctx) {
  const id = resolveApiSessionId(argv, ctx);
  if (!id) throw new Error("api_session_id_required: pass --api-session-id or set ORKESTR_API_SESSION_ID");
  return id;
}

function enrichApiSessionMessageError(error) {
  const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
  if (!payload) return error;
  const parts = [
    payload.error || payload.message || error.message || "api_session_message_failed",
    payload.deliveryState ? `delivery=${payload.deliveryState}` : "",
    payload.reason ? `reason=${payload.reason}` : "",
    payload.pending === true ? "pending=true" : "",
    payload.message?.threadId ? `thread=${payload.message.threadId}` : "",
    payload.message?.chatId ? `chat=${payload.message.chatId}` : "",
  ].filter(Boolean);
  const next = new Error(parts.join(" "));
  next.status = error.status;
  next.payload = payload;
  return next;
}

function compactApiSessionMessagePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...payload };
  if (payload.delivery && typeof payload.delivery === "object" && !Array.isArray(payload.delivery)) {
    const delivery = { ...payload.delivery };
    if (Array.isArray(delivery.skipped)) {
      delivery.skippedSummary = delivery.skippedSummary || summarizeDeliveryItems(delivery.skipped);
      delivery.skippedSample = delivery.skippedSample || delivery.skipped.slice(0, 5).map(compactDeliveryItem);
      delete delivery.skipped;
    }
    next.delivery = delivery;
  }
  return next;
}

function summarizeDeliveryItems(items = []) {
  const reasons = {};
  for (const item of items) {
    const reason = String(item?.reason || item?.status || item?.error || "unknown");
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    count: items.length,
    reasons: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function compactDeliveryItem(item) {
  if (!item || typeof item !== "object") return item;
  return {
    id: item.id || item.messageId || item.outboxId || null,
    reason: item.reason || "",
    status: item.status || "",
    threadId: item.threadId || item.thread || "",
    chatId: item.chatId || item.chat || "",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
  };
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let text = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      text += String(chunk || "");
    });
    stdin.on("end", () => resolve(text.trim()));
    stdin.on("error", reject);
    stdin.resume?.();
  });
}

async function settingsCommand(argv, ctx) {
  const json = argv.includes("--json");
  const settings = await readRuntimeSettings(ctx.env);
  if (json) ctx.stdout.write(`${JSON.stringify({ settings }, null, 2)}\n`);
  else ctx.stdout.write(`${formatSettings(settings)}\n`);
  return 0;
}

async function doctorCommand(argv, ctx) {
  const subject = positional(argv)[0] || "system";
  if (subject === "system" || subject === "host") return doctorSystemCommand(argv, ctx);
  if (subject === "timers" || subject === "timer") return doctorTimersCommand(argv, ctx);
  if (subject === "resources" || subject === "resource" || subject === "runtimes") return doctorResourcesCommand(argv, ctx);
  if (subject === "whatsapp" || subject === "wa") return doctorWhatsAppRouterCommand(argv.slice(1), ctx);
  if (subject === "router") return doctorRouterCommand(argv.slice(1), ctx);
  throw new Error("Usage: orkestr doctor [system|timers|resources|whatsapp|router] [--repair] [--json]");
}

async function doctorWhatsAppRouterCommand(argv, ctx) {
  const json = argv.includes("--json");
  const params = new URLSearchParams();
  const thread = flagValue(argv, "--thread") || flagValue(argv, "--thread-id") || "";
  const trace = flagValue(argv, "--trace") || flagValue(argv, "--router-trace") || flagValue(argv, "--router-trace-id") || "";
  const staleMs = flagValue(argv, "--stale-ms") || flagValue(argv, "--stale");
  if (thread) params.set("thread", thread);
  if (trace) params.set("trace", trace);
  if (argv.includes("--repair") || argv.includes("--repair-safe")) params.set("repair", "1");
  if (argv.includes("--unsafe")) params.set("unsafe", "1");
  if (staleMs) params.set("staleMs", staleMs);
  if (argv.includes("--watch")) {
    throw new Error("orkestr doctor whatsapp --watch is planned in ORK-290; run the command repeatedly or via a service timer for now.");
  }
  const payload = await requestJson(`/api/router-traces/doctor/whatsapp${params.size ? `?${params.toString()}` : ""}`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatRouterDoctor(payload));
  return payload.ok ? 0 : 1;
}

async function doctorRouterCommand(argv, ctx) {
  const trace = flagValue(argv, "--trace") || flagValue(argv, "--router-trace") || flagValue(argv, "--router-trace-id") || positional(argv)[0] || "";
  if (!trace) throw new Error("Usage: orkestr doctor router --trace <routerTraceId> [--repair] [--json]");
  return doctorWhatsAppRouterCommand(["--trace", trace, ...argv.filter((item) => item !== trace)], ctx);
}

function formatRouterDoctor(payload = {}) {
  const lines = [
    `Doctor: ${payload.status || (payload.ok ? "ok" : "broken")} - ${payload.summary || ""}`,
  ];
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  for (const check of checks.slice(0, 20)) {
    lines.push(`- ${check.severity || "info"} ${check.code || "check"}${check.threadId ? ` thread=${check.threadId}` : ""}${check.messageId ? ` message=${check.messageId}` : ""}${check.routerTraceId ? ` trace=${check.routerTraceId}` : ""}: ${check.summary || ""}`);
  }
  const repairs = Array.isArray(payload.repairs) ? payload.repairs : [];
  for (const repair of repairs.slice(0, 20)) {
    lines.push(`repair ${repair.ok === false ? "failed" : "ok"} ${repair.code || "repair"}${repair.threadId ? ` thread=${repair.threadId}` : ""}${repair.messageId ? ` message=${repair.messageId}` : ""}${repair.outboxJobId ? ` outbox=${repair.outboxJobId}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

async function timersCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "list") return listTimersCommand(rest, ctx);
  if (subcommand === "doctor") return doctorTimersCommand(rest, ctx);
  if (subcommand === "run") return runTimerCommand(rest, ctx);
  throw new Error("Usage: orkestr timers [list|doctor|run <timer-id>] [--json]");
}

async function jobsCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "run" : argv[0] || "run";
  const rest = subcommand === "run" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "run" || subcommand === "poll") return runJobsCommand(rest, ctx);
  throw new Error("Usage: orkestr jobs run [--owner-user-id user] [--target-thread thread] [--max-results N] [--json]");
}

async function whatsappCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  const rest = argv.slice(1);
  if (subcommand === "accounts" || subcommand === "account") return whatsappAccountsCommand(rest, ctx);
  if (subcommand === "bindings" || subcommand === "binding") return whatsappBindingsCommand(rest, ctx);
  if (subcommand === "outbox") return whatsappOutboxCommand(rest, ctx);
  if (subcommand === "codex") return whatsappCodexCommand(rest, ctx);
  if (subcommand === "migrate") return whatsappMigrateCommand(rest, ctx);
  if (subcommand === "doctor") return whatsappAccountsCommand(["doctor", ...rest], ctx);
  if (subcommand === "bind-thread" || subcommand === "thread-group") return whatsappBindThreadCommand(rest, ctx);
  throw new Error(whatsappUsage());
}

function whatsappUsage() {
  return [
    "Usage:",
    "  orkestr whatsapp accounts [list] [--json]",
    "  orkestr whatsapp accounts add [--id id] [--display-name name] [--owner user] [--json]",
    "  orkestr whatsapp accounts status <account-id> [--json]",
    "  orkestr whatsapp accounts update <account-id> [--display-name name] [--owner user] [--json]",
    "  orkestr whatsapp accounts pair <account-id> [--phone number] [--json]",
    "  orkestr whatsapp accounts reconnect <account-id> [--json]",
    "  orkestr whatsapp accounts disconnect <account-id> [--json]",
    "  orkestr whatsapp accounts remove <account-id> [--json]",
    "  orkestr whatsapp doctor [--account <account-id>] [--json]",
    "  orkestr whatsapp migrate [--dry-run] [--json]",
    "  orkestr whatsapp outbox [list] [--state state] [--tenant id] [--account id] [--chat-id id] [--thread id] [--limit n] [--json]",
    "  orkestr whatsapp outbox <retry|suppress|mark-delivered|replay|dead-letter> <job-id>... [--reason text] [--json]",
    "  orkestr whatsapp bindings [list] [--json]",
    "  orkestr whatsapp bindings create --level <chat|thread|instance|user|account-default> --reply-account id [--thread id] [--chat-id id] [--instance id] [--user id] [--target-account id] [--send-acl mode] [--json]",
    "  orkestr whatsapp bindings status <binding-id|thread-id|chat-id> [--json]",
    "  orkestr whatsapp bindings resolve [--thread id] [--chat-id id] [--account id] [--json]",
    "  orkestr whatsapp bindings update <binding-id|thread-id|chat-id> [--reply-account id] [--send-acl mode] [--json]",
    "  orkestr whatsapp bindings delete <binding-id|thread-id|chat-id> [--json]",
    "  orkestr whatsapp codex connect --thread <thread> --account <account-id> [--chat-id id] [--json]",
    "  orkestr whatsapp codex status --thread <thread> [--chat-id id] [--json]",
    "  orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--receiving-account id] [--reply-account id] [--force-new] [--json]",
  ].join("\n");
}

async function whatsappMigrateCommand(argv, ctx) {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run") || argv.includes("--check");
  const payload = await requestJson("/api/connectors/whatsapp/migrate", {
    ...ctx,
    method: "POST",
    body: { dryRun },
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatWhatsAppMigration(payload));
  return payload.ok === false ? 1 : 0;
}

async function whatsappAccountsCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  if (subcommand === "list") {
    const payload = await requestJson("/api/connectors/whatsapp/accounts", ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccounts(payload.accounts || []));
    return 0;
  }
  if (subcommand === "add" || subcommand === "create") {
    const body = whatsappAccountBody(rest);
    const positionalId = positional(rest)[0];
    if (positionalId && !body.accountId) body.accountId = positionalId;
    const payload = await requestJson("/api/connectors/whatsapp/accounts", {
      ...ctx,
      method: "POST",
      body,
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccountStatus(payload.account || {}));
    return 0;
  }
  if (subcommand === "status") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts status <account-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}/status`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccountStatus(payload.account || {}));
    return payload.account?.ready === false ? 1 : 0;
  }
  if (subcommand === "update") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts update <account-id> [--display-name name] [--owner user] [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}`, {
      ...ctx,
      method: "PUT",
      body: whatsappAccountBody(rest),
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccountStatus(payload.account || {}));
    return 0;
  }
  if (subcommand === "pair" || subcommand === "start") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts pair <account-id> [--phone number] [--json]");
    const body = {};
    const phone = flagValue(rest, "--phone") || flagValue(rest, "--phone-number");
    if (phone) body.phoneNumber = phone;
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}/pairing-session`, {
      ...ctx,
      method: "POST",
      body,
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppPairing(payload));
    return 0;
  }
  if (subcommand === "reconnect") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts reconnect <account-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}/reconnect`, {
      ...ctx,
      method: "POST",
      body: {},
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccountStatus(payload.account || {}));
    return 0;
  }
  if (subcommand === "disconnect") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts disconnect <account-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}/disconnect`, {
      ...ctx,
      method: "POST",
      body: {},
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppAccountStatus(payload.account || {}));
    return 0;
  }
  if (subcommand === "delete" || subcommand === "remove") {
    const accountId = positional(rest)[0];
    if (!accountId) throw new Error("Usage: orkestr whatsapp accounts delete <account-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/accounts/${encodeURIComponent(accountId)}`, {
      ...ctx,
      method: "DELETE",
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`Deleted WhatsApp account ${payload.account?.accountId || payload.account?.id || accountId}\n`);
    return 0;
  }
  if (subcommand === "doctor") {
    const params = new URLSearchParams();
    const accountId = flagValue(rest, "--account") || flagValue(rest, "--account-id") || positional(rest)[0] || "";
    if (accountId) params.set("account", accountId);
    const payload = await requestJson(`/api/connectors/whatsapp/doctor${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      ctx.stdout.write(formatWhatsAppAccounts(payload.accounts));
      ctx.stdout.write(formatWhatsAppBindings(payload.bindings));
      ctx.stdout.write(`Doctor: ${payload.status || (payload.ok ? "ok" : "broken")} - ${payload.summary || ""}\n`);
    }
    return payload.ok ? 0 : 1;
  }
  throw new Error(whatsappUsage());
}

function whatsappAccountBody(argv = []) {
  const body = {};
  const id = flagValue(argv, "--id") || flagValue(argv, "--account-id") || flagValue(argv, "--account");
  const displayName = flagValue(argv, "--display-name") || flagValue(argv, "--name") || flagValue(argv, "--label");
  const ownerUserId = flagValue(argv, "--owner") || flagValue(argv, "--owner-user") || flagValue(argv, "--owner-user-id");
  const runtimeAccountId = flagValue(argv, "--runtime-account") || flagValue(argv, "--runtime-account-id");
  if (id) body.accountId = id;
  if (displayName) body.displayName = displayName;
  if (ownerUserId) body.ownerUserId = ownerUserId;
  if (runtimeAccountId) body.runtimeAccountId = runtimeAccountId;
  if (argv.includes("--autostart")) body.autostart = true;
  if (argv.includes("--no-autostart")) body.autostart = false;
  return body;
}

const whatsappOutboxActions = new Set(["retry", "suppress", "mark-delivered", "mark_delivered", "replay", "dead-letter", "dead_letter"]);

async function whatsappOutboxCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  if (subcommand === "list") {
    const params = new URLSearchParams();
    const state = flagValue(rest, "--state") || flagValue(rest, "--status");
    const tenant = flagValue(rest, "--tenant") || flagValue(rest, "--tenant-id") || flagValue(rest, "--owner") || flagValue(rest, "--user");
    const account = flagValue(rest, "--account") || flagValue(rest, "--account-id");
    const chatId = flagValue(rest, "--chat-id") || flagValue(rest, "--chat");
    const thread = flagValue(rest, "--thread") || flagValue(rest, "--thread-id");
    const deliveryType = flagValue(rest, "--delivery-type") || flagValue(rest, "--type");
    const limit = flagValue(rest, "--limit");
    if (state) params.set("state", state);
    if (tenant) params.set("tenantId", tenant);
    if (account) params.set("accountId", account);
    if (chatId) params.set("chatId", chatId);
    if (thread) params.set("threadId", thread);
    if (deliveryType) params.set("deliveryType", deliveryType);
    if (limit) params.set("limit", limit);
    const payload = await requestJson(`/api/connectors/whatsapp/outbox${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppOutboxJobs(payload));
    return 0;
  }
  if (whatsappOutboxActions.has(subcommand)) {
    const jobIds = positional(rest);
    if (!jobIds.length) throw new Error("Usage: orkestr whatsapp outbox <retry|suppress|mark-delivered|replay|dead-letter> <job-id>... [--reason text] [--json]");
    const body = {
      reason: flagValue(rest, "--reason") || "",
    };
    const action = subcommand.replace(/_/g, "-");
    const payload = jobIds.length === 1
      ? await requestJson(`/api/connectors/whatsapp/outbox/${encodeURIComponent(jobIds[0])}/${encodeURIComponent(action)}`, {
          ...ctx,
          method: "POST",
          body,
        })
      : await requestJson("/api/connectors/whatsapp/outbox/actions", {
          ...ctx,
          method: "POST",
          body: {
            ...body,
            action,
            jobIds,
          },
        });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppOutboxAction(payload));
    return payload.ok === false ? 1 : 0;
  }
  throw new Error("Usage: orkestr whatsapp outbox [list|retry|suppress|mark-delivered|replay|dead-letter] [--json]");
}

async function whatsappBindingsCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  if (subcommand === "list") {
    const params = new URLSearchParams();
    const thread = flagValue(rest, "--thread") || flagValue(rest, "--thread-id") || "";
    const chatId = flagValue(rest, "--chat-id") || flagValue(rest, "--chat") || "";
    const user = flagValue(rest, "--user") || flagValue(rest, "--user-id") || flagValue(rest, "--owner") || "";
    if (thread) params.set("thread", thread);
    if (chatId) params.set("chatId", chatId);
    if (user) params.set("user", user);
    const payload = await requestJson(`/api/connectors/whatsapp/bindings${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindings(payload.bindings || []));
    return 0;
  }
  if (subcommand === "create" || subcommand === "add") {
    const body = whatsappBindingBody(rest);
    if (!body.threadId) {
      const positionalThread = positional(rest)[0];
      if (positionalThread) body.threadId = positionalThread;
    }
    const payload = await requestJson("/api/connectors/whatsapp/bindings", {
      ...ctx,
      method: "POST",
      body,
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingStatus(payload.binding || {}));
    return 0;
  }
  if (subcommand === "status") {
    const bindingId = positional(rest)[0];
    if (!bindingId) throw new Error("Usage: orkestr whatsapp bindings status <binding-id|thread-id|chat-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/bindings/${encodeURIComponent(bindingId)}/status`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingStatus(payload.binding || {}));
    return payload.binding?.state === "ready" ? 0 : 1;
  }
  if (subcommand === "resolve") {
    const params = new URLSearchParams();
    const thread = flagValue(rest, "--thread") || flagValue(rest, "--thread-id") || positional(rest)[0] || "";
    const chatId = flagValue(rest, "--chat-id") || flagValue(rest, "--chat") || "";
    const accountId = flagValue(rest, "--account") || flagValue(rest, "--account-id") || "";
    if (thread) params.set("thread", thread);
    if (chatId) params.set("chatId", chatId);
    if (accountId) params.set("accountId", accountId);
    const payload = await requestJson(`/api/connectors/whatsapp/bindings/resolve${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingResolution(payload));
    return payload.ok ? 0 : 1;
  }
  if (subcommand === "update") {
    const bindingId = positional(rest)[0];
    if (!bindingId) throw new Error("Usage: orkestr whatsapp bindings update <binding-id|thread-id|chat-id> [--reply-account id] [--send-acl mode] [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/bindings/${encodeURIComponent(bindingId)}`, {
      ...ctx,
      method: "PUT",
      body: whatsappBindingBody(rest),
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingStatus(payload.binding || {}));
    return 0;
  }
  if (subcommand === "delete" || subcommand === "remove") {
    const bindingId = positional(rest)[0];
    if (!bindingId) throw new Error("Usage: orkestr whatsapp bindings delete <binding-id|thread-id|chat-id> [--json]");
    const payload = await requestJson(`/api/connectors/whatsapp/bindings/${encodeURIComponent(bindingId)}`, {
      ...ctx,
      method: "DELETE",
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingStatus(payload.binding || {}));
    return 0;
  }
  throw new Error(whatsappUsage());
}

function whatsappBindingBody(argv = []) {
  const body = {};
  const level = flagValue(argv, "--level");
  const threadId = flagValue(argv, "--thread") || flagValue(argv, "--thread-id");
  const chatId = flagValue(argv, "--chat-id") || flagValue(argv, "--chat");
  const instanceId = flagValue(argv, "--instance") || flagValue(argv, "--instance-id");
  const ownerUserId = flagValue(argv, "--user") || flagValue(argv, "--user-id") || flagValue(argv, "--owner") || flagValue(argv, "--owner-user") || flagValue(argv, "--owner-user-id");
  const targetAccountId = flagValue(argv, "--target-account") || flagValue(argv, "--target-account-id");
  const accountId = flagValue(argv, "--reply-account") || flagValue(argv, "--bridge-account") || flagValue(argv, "--responder-account") || flagValue(argv, "--account") || flagValue(argv, "--account-id") || flagValue(argv, "--outbound-account");
  const sendAcl = flagValue(argv, "--send-acl") || flagValue(argv, "--send");
  const displayName = flagValue(argv, "--display-name") || flagValue(argv, "--name");
  const replyPrefix = flagValue(argv, "--reply-prefix");
  const ownerContactId = flagValue(argv, "--owner-contact") || flagValue(argv, "--owner-contact-id");
  const authorizedContactId = flagValue(argv, "--authorized-contact") || flagValue(argv, "--authorized-contact-id");
  const senderContactId = flagValue(argv, "--sender-contact") || flagValue(argv, "--sender-contact-id");
  const additionalParticipantIds = repeatedFlagValues(argv, ["--participant", "--wa-participant", "--additional-participant", "--additional-participant-id"]);
  const ownerContactIds = repeatedFlagValues(argv, ["--owner-contact-id", "--owner-contact"]);
  const ownerContactAliases = repeatedFlagValues(argv, ["--owner-contact-alias", "--owner-alias"]);
  const authorizedContactIds = repeatedFlagValues(argv, ["--authorized-contact-id", "--authorized-contact"]);
  const authorizedContactAliases = repeatedFlagValues(argv, ["--authorized-contact-alias", "--authorized-alias"]);
  if (level) body.level = level;
  if (threadId) body.threadId = threadId;
  if (chatId) body.chatId = chatId;
  if (instanceId) body.instanceId = instanceId;
  if (ownerUserId) body.ownerUserId = ownerUserId;
  if (targetAccountId) body.targetAccountId = targetAccountId;
  if (accountId) {
    body.replyAccountId = accountId;
    body.bridgeAccountId = accountId;
    body.responderConnectorAccountId = accountId;
    body.responderAccountId = accountId;
  }
  if (sendAcl) body.acl = { send: { mode: sendAcl } };
  if (displayName) body.displayName = displayName;
  if (replyPrefix) body.replyPrefix = replyPrefix;
  if (senderContactId) body.senderContactId = senderContactId;
  if (ownerContactId) body.ownerContactId = ownerContactId;
  if (ownerContactIds.length) body.ownerContactIds = ownerContactIds;
  if (ownerContactAliases.length) body.ownerContactAliases = ownerContactAliases;
  if (authorizedContactId) body.authorizedContactId = authorizedContactId;
  if (authorizedContactIds.length) body.authorizedContactIds = authorizedContactIds;
  if (authorizedContactAliases.length) body.authorizedContactAliases = authorizedContactAliases;
  if (additionalParticipantIds.length) {
    body.additionalParticipantsEnabled = true;
    body.additionalParticipantIds = additionalParticipantIds;
  }
  if (argv.includes("--no-mirror")) body.mirrorToWhatsApp = false;
  if (argv.includes("--mirror")) body.mirrorToWhatsApp = true;
  if (argv.includes("--suppress-updates")) body.suppressWhatsAppUpdates = true;
  if (argv.includes("--mirror-updates")) body.suppressWhatsAppUpdates = false;
  if (argv.includes("--suppress-debug-footer")) body.suppressWhatsAppDebugFooter = true;
  if (argv.includes("--debug-footer")) body.suppressWhatsAppDebugFooter = false;
  if (argv.includes("--disabled")) body.enabled = false;
  if (argv.includes("--enabled")) body.enabled = true;
  return body;
}

async function whatsappCodexCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "status" : argv[0] || "status";
  const rest = subcommand === "status" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  const thread = flagValue(rest, "--thread") || flagValue(rest, "--thread-id") || positional(rest)[0] || "";
  const chatId = flagValue(rest, "--chat-id") || flagValue(rest, "--chat") || "";
  const accountId = flagValue(rest, "--account") || flagValue(rest, "--account-id") || "";
  if (subcommand === "connect") {
    if (!thread || !accountId) throw new Error("Usage: orkestr whatsapp codex connect --thread <thread> --account <account-id> [--chat-id id] [--json]");
    const payload = await requestJson("/api/connectors/whatsapp/codex/connect", {
      ...ctx,
      method: "POST",
      body: {
        thread,
        accountId,
        ...(chatId ? { chatId } : {}),
      },
    });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingResolution(payload.resolution || {}));
    return payload.ok ? 0 : 1;
  }
  if (subcommand === "status") {
    const params = new URLSearchParams();
    if (thread) params.set("thread", thread);
    if (chatId) params.set("chatId", chatId);
    if (accountId) params.set("accountId", accountId);
    const payload = await requestJson(`/api/connectors/whatsapp/codex/status${params.size ? `?${params.toString()}` : ""}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatWhatsAppBindingResolution(payload.resolution || {}));
    return payload.ok ? 0 : 1;
  }
  throw new Error("Usage: orkestr whatsapp codex [status|connect] --thread <thread> [--account id] [--chat-id id] [--json]");
}

async function whatsappBindThreadCommand(argv, ctx) {
  const json = argv.includes("--json");
  const threadId = positional(argv)[0];
  const name = flagValue(argv, "--name") || flagValue(argv, "--wa-title") || flagValue(argv, "--title");
  if (!threadId || !name) {
    throw new Error("Usage: orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--receiving-account id] [--reply-account id] [--force-new] [--json]");
  }
  const body = {
    threadId,
    name,
    participantIds: repeatedFlagValues(argv, ["--wa-participant", "--participant"]),
    adminParticipantIds: repeatedFlagValues(argv, ["--wa-admin", "--admin-participant"]),
    promoteParticipantsAsAdmins: !argv.includes("--no-wa-admin") && !argv.includes("--no-admin"),
    generatePicture: !argv.includes("--no-picture"),
    mirrorToWhatsApp: !argv.includes("--no-mirror"),
    forceNew: argv.includes("--force-new"),
  };
  const senderAccountId = flagValue(argv, "--receiving-account") || flagValue(argv, "--sender-account") || flagValue(argv, "--inbound-account");
  const responderAccountId = flagValue(argv, "--reply-account") || flagValue(argv, "--bridge-account") || flagValue(argv, "--outbound-account") || flagValue(argv, "--responder-account");
  const replyPrefix = flagValue(argv, "--reply-prefix");
  if (senderAccountId) {
    body.receivingAccountId = senderAccountId;
    body.senderAccountId = senderAccountId;
  }
  if (responderAccountId) {
    body.replyAccountId = responderAccountId;
    body.bridgeAccountId = responderAccountId;
    body.responderAccountId = responderAccountId;
    body.outboundAccountId = responderAccountId;
  }
  if (replyPrefix) body.replyPrefix = replyPrefix;
  const payload = await requestJson("/api/connectors/whatsapp/thread-groups", {
    ...ctx,
    method: "POST",
    body,
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const chat = payload.chat || {};
    ctx.stdout.write(`${payload.reused ? "Reused" : "Created"} WhatsApp chat: ${chat.name || name}\t${chat.id || payload.binding?.chatId || "unbound"}\n`);
    ctx.stdout.write(`Thread binding: ${payload.binding?.displayName || name}\t${payload.thread?.id || threadId}\n`);
  }
  return 0;
}

function formatWhatsAppAccounts(accounts = []) {
  if (!accounts.length) return "No visible WhatsApp accounts.\n";
  return [
    "ACCOUNT\tSTATE\tREADY\tALIASES\tNEXT",
    ...accounts.map((account) => [
      account.accountId || account.id || "-",
      account.state || "-",
      account.ready ? "yes" : "no",
      account.legacyRoleAliases?.length ? account.legacyRoleAliases.join(",") : "-",
      account.nextAction || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatWhatsAppAccountStatus(account = {}) {
  return [
    `WhatsApp account: ${account.accountId || account.id || "-"}`,
    account.displayName || account.label ? `Name: ${account.displayName || account.label}` : "",
    `State: ${account.state || "-"}`,
    `Ready: ${account.ready ? "yes" : "no"}`,
    `Authenticated: ${account.authenticated ? "yes" : "no"}`,
    `QR: ${account.qrAvailable ? account.qrUrl || "available" : "not available"}`,
    `Next: ${account.nextAction || "-"}`,
    account.legacyRoleAliases?.length ? `Legacy aliases: ${account.legacyRoleAliases.join(", ")}` : "",
  ].filter(Boolean).join("\n") + "\n";
}

function formatWhatsAppPairing(payload = {}) {
  const account = payload.account || {};
  const pairing = payload.pairing || {};
  return [
    `WhatsApp account: ${account.accountId || account.id || "-"}`,
    `State: ${pairing.state || account.state || "-"}`,
    pairing.pairingCode || account.pairingCode ? `Code: ${pairing.pairingCode || account.pairingCode}` : "",
    pairing.pairingPhoneNumber || account.pairingPhoneNumber ? `Phone: ${pairing.pairingPhoneNumber || account.pairingPhoneNumber}` : "",
    `QR: ${pairing.qrAvailable || pairing.qrRequired ? pairing.qrUrl || "available" : "not available"}`,
    `Next: ${pairing.nextAction || account.nextAction || "-"}`,
  ].filter(Boolean).join("\n") + "\n";
}

function formatWhatsAppOutboxJobs(payload = {}) {
  const jobs = payload.jobs || [];
  if (!jobs.length) return "No WhatsApp outbox jobs matched.\n";
  return [
    "JOB\tSTATE\tTENANT\tACCOUNT\tCHAT\tTHREAD\tTYPE\tUPDATED\tERROR",
    ...jobs.map((job) => [
      job.id || "-",
      job.state || "-",
      job.tenantId || job.ownerUserId || "-",
      job.accountId || "-",
      job.chatId || "-",
      job.threadId || "-",
      job.deliveryType || "-",
      job.updatedAt || job.createdAt || "-",
      job.error || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatWhatsAppOutboxAction(payload = {}) {
  const results = payload.results || (payload.job ? [payload] : []);
  if (!results.length) return `Outbox action: ${payload.ok ? "ok" : "failed"}\n`;
  return results.map((result) => [
    `Outbox job: ${result.job?.id || "-"}`,
    `Action: ${result.action || payload.action || "-"}`,
    `State: ${result.previousState || "-"} -> ${result.job?.state || "-"}`,
    result.whatsapp ? `WhatsApp state: intents=${result.whatsapp.matchedIntents || 0} removedDeliveries=${result.whatsapp.removedDeliveries || 0}` : "",
  ].filter(Boolean).join("\n")).join("\n\n") + "\n";
}

function formatWhatsAppMigration(payload = {}) {
  const counts = payload.counts || {};
  const lines = [
    `WhatsApp migration: ${payload.dryRun ? "dry run" : "applied"}`,
    `Migrated: ${Number(payload.migrated || 0)}`,
    `Accounts: created=${Number(counts.accountsCreated || 0)} updated=${Number(counts.accountsUpdated || 0)} unchanged=${Number(counts.accountsUnchanged || 0)}`,
    `Thread bindings: updated=${Number(counts.threadBindingsUpdated || 0)} skipped=${Number(counts.threadBindingsSkipped || 0)} unchanged=${Number(counts.threadBindingsUnchanged || 0)}`,
    `Token plans: configured=${Number(counts.tokenPlansConfigured || 0)} missing=${Number(counts.tokenPlansMissing || 0)} total=${Number(counts.tokenPlansTotal || 0)}`,
  ];
  if (Array.isArray(payload.accounts) && payload.accounts.length) {
    lines.push("", "Account plans:");
    for (const account of payload.accounts) {
      lines.push(`- ${account.action || "-"} ${account.accountId || "-"} runtime=${account.runtimeAccountId || "-"} autostart=${account.autostart ? "yes" : "no"}`);
    }
  }
  if (Array.isArray(payload.threadBindings) && payload.threadBindings.length) {
    lines.push("", "Binding plans:");
    for (const binding of payload.threadBindings) {
      const acl = binding.acl || {};
      lines.push(`- ${binding.action || "-"} ${binding.bindingId || "-"} thread=${binding.threadName || binding.threadId || "-"} replyIdentity=${binding.replyAccountId || binding.responderAccountId || "-"} acl(send=${acl.send?.mode || "-"} receive=${acl.receive?.mode || "-"})`);
    }
  }
  if (Array.isArray(payload.tokenPlans) && payload.tokenPlans.length) {
    lines.push("", "Scoped token plans:");
    for (const token of payload.tokenPlans) {
      lines.push(`- ${token.tokenId || "-"} ${token.requiredScope || "-"} account=${token.accountId || "-"} chat=${token.chatId || "-"} ${token.tokenConfigured ? "configured" : "missing"} token=${token.token || "[redacted]"}`);
    }
  }
  if (Array.isArray(payload.warnings) && payload.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of payload.warnings) {
      lines.push(`- ${warning.code || "warning"} ${warning.message || ""}`.trim());
    }
  }
  if (payload.rollback?.instructions?.length) {
    lines.push("", "Rollback:");
    for (const instruction of payload.rollback.instructions) lines.push(`- ${instruction}`);
  }
  return lines.join("\n") + "\n";
}

function formatWhatsAppBindings(bindings = []) {
  if (!bindings.length) return "No visible WhatsApp bindings.\n";
  return [
    "BINDING\tLEVEL\tSTATE\tTHREAD\tCHAT\tRESPONDER\tNEXT",
    ...bindings.map((binding) => [
      binding.id || "-",
      binding.level || "-",
      binding.state || "-",
      binding.threadName || binding.threadId || "-",
      binding.chatId || "-",
      binding.responderAccountId || "-",
      binding.nextAction || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatWhatsAppBindingStatus(binding = {}) {
  return [
    `WhatsApp binding: ${binding.id || "-"}`,
    `Level: ${binding.level || "-"}`,
    `State: ${binding.state || "-"}`,
    `Reason: ${binding.reason || "-"}`,
    `Thread: ${binding.threadName || binding.threadId || "-"}`,
    `Chat: ${binding.chatId || "-"}`,
    `Reply identity: ${binding.replyAccountId || binding.responderAccountId || "-"}`,
    `Send ACL: ${binding.acl?.send?.mode || "-"}`,
    `Next: ${binding.nextAction || "-"}`,
  ].join("\n") + "\n";
}

function formatWhatsAppBindingResolution(payload = {}) {
  if (!payload.selected) {
    return [
      `WhatsApp binding: ${payload.ok ? "ready" : "not resolved"}`,
      `Reason: ${payload.error || payload.reason || "-"}`,
    ].join("\n") + "\n";
  }
  return formatWhatsAppBindingStatus(payload.selected);
}

async function listTimersCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/timers", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatTimerTable(payload?.timers || [])}\n`);
  return 0;
}

async function doctorTimersCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/timers/doctor", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatTimerDoctor(payload)}\n`);
  return payload?.ok === false || payload?.status === "broken" ? 1 : 0;
}

async function doctorSystemCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/system/doctor", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatSystemDoctor(payload)}\n`);
  return payload?.ok === false || payload?.status === "broken" ? 1 : 0;
}

async function doctorResourcesCommand(argv, ctx) {
  const json = argv.includes("--json");
  const repair = argv.includes("--repair");
  const payload = repair
    ? await requestJson("/api/system/resources/repair", { ...ctx, method: "POST", body: {} })
    : await requestJson("/api/system/resources", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatRuntimeResources(payload)}\n`);
  return payload?.ok === false || payload?.status === "broken" ? 1 : 0;
}

async function runTimerCommand(argv, ctx) {
  const json = argv.includes("--json");
  const timerId = positional(argv)[0];
  if (!timerId) throw new Error("Usage: orkestr timers run <timer-id> [--json]");
  const payload = await requestJson(`/api/timers/${encodeURIComponent(timerId)}/run`, {
    ...ctx,
    method: "POST",
    body: {},
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Ran timer ${timerId}\n`);
  return 0;
}

async function runJobsCommand(argv, ctx) {
  const json = argv.includes("--json");
  const maxResults = flagValue(argv, "--max-results") || flagValue(argv, "--max") || "";
  const body = {
    ownerUserId: flagValue(argv, "--owner-user-id") || flagValue(argv, "--user-id") || "",
    targetThreadId: flagValue(argv, "--target-thread") || flagValue(argv, "--thread") || "",
    query: flagValue(argv, "--query") || "",
    gmailSource: flagValue(argv, "--gmail-source") || "",
    maxResults: maxResults ? Number(maxResults) : undefined,
    fitThreshold: flagValue(argv, "--fit-threshold") || "",
    present: argv.includes("--no-present") ? false : true,
    gogFallback: argv.includes("--no-gog-fallback") ? false : undefined,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === "" || body[key] === undefined || Number.isNaN(body[key])) delete body[key];
  }
  const payload = await requestJson("/api/jobs/run", {
    ...ctx,
    method: "POST",
    body,
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const lines = [
      "Gmail jobs poll completed",
      `Collected: ${Number(payload.collected || 0)}`,
      `Created: ${Number(payload.upserted?.created?.length || 0)}`,
      `Classified: ${Number(payload.classified?.classified?.length || 0)}`,
      `Presented: ${Number(payload.presentation?.presented?.length || 0)}`,
    ];
    if (payload.presentation?.message?.text) {
      lines.push("", String(payload.presentation.message.text));
    }
    ctx.stdout.write(lines.join("\n") + "\n");
  }
  return payload?.ok === false ? 1 : 0;
}

async function securityCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "challenges" : argv[0] || "challenges";
  const rest = subcommand === "challenges" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "challenges" || subcommand === "list") return listSecurityChallenges(rest, ctx);
  if (subcommand === "sessions") return listSecuritySessionsCommand(rest, ctx);
  if (subcommand === "approve") return approveSecurityChallenge(rest, ctx);
  if (subcommand === "reject") return rejectSecurityChallenge(rest, ctx);
  if (subcommand === "revoke" || subcommand === "logout") return revokeSecuritySessionCommand(rest, ctx);
  throw new Error("Usage: orkestr security [challenges|sessions|approve <challenge-id>|reject <challenge-id>|revoke <session-id|all>] [--json]");
}

async function connectCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  const rest = argv.slice(1);
  if (subcommand === "approve") return approveSecurityChallenge(rest, ctx, "connect");
  if (["google", "google-workspace", "workspace", "gmail"].includes(subcommand)) return connectGoogleWorkspaceCommand(rest, ctx);
  throw new Error("Usage: orkestr connect [google|approve <code>] [--thread thread-id] [--account email] [--json]");
}

async function connectGoogleWorkspaceCommand(argv, ctx) {
  const json = argv.includes("--json");
  try {
    const cwd = flagValue(argv, "--cwd") || ctx.cwd || process.cwd();
    const explicitThreadId = flagValue(argv, "--thread") || flagValue(argv, "--thread-id") || "";
    const where = explicitThreadId ? null : await googleConnectWhereAmI(cwd, ctx);
    const threadId = explicitThreadId || where?.thread?.id || "";
    const thread = await googleConnectThread(threadId, where, ctx);
    const principal = await googleConnectPrincipal(thread, where, ctx);
    const connect = await createGoogleWorkspaceConnectLink({
      principal,
      thread,
      chatId: flagValue(argv, "--chat-id") || flagValue(argv, "--chat") || "",
      accountId: flagValue(argv, "--account-id") || flagValue(argv, "--wa-account") || "",
      account: flagValue(argv, "--account") || flagValue(argv, "--email") || "",
    }, ctx.env);
    if (json) ctx.stdout.write(`${JSON.stringify(connect, null, 2)}\n`);
    else ctx.stdout.write(`${connect.message || connect.link || connect.connectLink || ""}\n`);
    return connect?.ok === false ? 1 : 0;
  } finally {
    await closeThreadRegistryCache(ctx.env).catch(() => {});
  }
}

async function googleConnectWhereAmI(cwd = "", ctx = {}) {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  return await requestJson(`/api/whereiam?${params.toString()}`, ctx).catch(() => null);
}

async function googleConnectThread(threadId = "", where = null, ctx = {}) {
  const id = String(threadId || "").trim();
  if (id) {
    const thread = await getThread(id, ctx.env).catch(() => null);
    if (thread) return thread;
  }
  const publicThread = where?.thread && typeof where.thread === "object" ? where.thread : {};
  return {
    id: String(publicThread.id || id || "").trim(),
    name: String(publicThread.name || publicThread.title || publicThread.displayName || "").trim(),
    title: String(publicThread.title || publicThread.name || publicThread.displayName || "").trim(),
    ownerUserId: String(publicThread.ownerUserId || where?.tenancy?.ownerUserId || where?.user?.userId || "").trim(),
  };
}

async function googleConnectPrincipal(thread = {}, where = null, ctx = {}) {
  const userId = String(thread.ownerUserId || where?.tenancy?.ownerUserId || where?.user?.userId || ctx.env?.ORKESTR_ADMIN_USER_ID || "admin").trim();
  const displayName = String(where?.user?.displayName || userId).trim();
  const role = String(where?.user?.role || "").trim().toLowerCase();
  if (role === "admin" && userId === String(where?.user?.userId || "").trim()) return adminPrincipal({ id: userId, displayName });
  return userPrincipal({ id: userId, role: "user", displayName, source: "connect-cli" });
}

async function codexCommand(argv, ctx) {
  const subcommand = argv[0] || "status";
  const rest = subcommand === "status" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "status") return codexStatusCommand(rest, ctx);
  if (subcommand === "migrate") return codexMigrateCommand(rest, ctx);
  throw new Error("Usage: orkestr codex [status|migrate] [--dry-run] [--json]");
}

async function codexStatusCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/codex/app-server/status", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Codex app-server: ${payload.ok ? "ready" : "unavailable"}${payload.error ? ` - ${payload.error}` : ""}\n`);
  return payload.ok ? 0 : 1;
}

async function codexMigrateCommand(argv, ctx) {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run") || argv.includes("--check");
  const payload = await requestJson("/api/codex/migrate", {
    ...ctx,
    method: "POST",
    body: { dryRun },
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const counts = payload.counts || {};
    ctx.stdout.write([
      `Codex migration: ${dryRun ? "dry run" : "applied"}`,
      `Candidates: ${Number(payload.candidates || 0)}`,
      `Migrated: ${Number(payload.migrated || 0)}`,
      `Already app-server: ${Number(counts.already_app_server || 0)}`,
      `Existing Codex IDs: ${Number(counts.migrated_existing_codex_thread || counts.mark_existing_codex_thread || 0)}`,
      `New app-server threads: ${Number(counts.created_codex_app_server_thread || counts.create_codex_app_server_thread || 0)}`,
    ].join("\n") + "\n");
  }
  return payload.ok === false ? 1 : 0;
}

async function updateCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "install" : argv[0] || "install";
  const rest = subcommand === "install" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "status") return updateStatusCommand(rest, ctx);
  if (subcommand === "rollback") return updateRollbackCommand(rest, ctx);
  if (subcommand !== "install" && subcommand !== "run") {
    throw new Error("Usage: orkestr update [--track-main|--ref ref] [--release|--in-place] [--channel name] [--allow-untagged|--require-tagged] [--no-smoke] [--all-instances] [--wait-active] [--active-timeout seconds|--allow-interrupt]\n       orkestr update status [--json]\n       orkestr update rollback [--to release-id]");
  }
  return updateInstallCommand(rest, ctx);
}

function deployGuardArgs(argv) {
  const activeTimeout = flagValue(argv, "--active-timeout");
  return [
    ...(argv.includes("--no-interrupt") ? ["--no-interrupt"] : []),
    ...(argv.includes("--allow-interrupt") ? ["--allow-interrupt"] : []),
    ...(argv.includes("--wait-active") ? ["--wait-active"] : []),
    ...(argv.includes("--no-wait-active") ? ["--no-wait-active"] : []),
    ...(activeTimeout ? ["--active-timeout", activeTimeout] : []),
  ];
}

async function updateInstallCommand(argv, ctx) {
  const trackMain = argv.includes("--track-main");
  const ref = flagValue(argv, "--ref") || flagValue(argv, "--to") || (trackMain ? "main" : "");
  const channel = flagValue(argv, "--channel") || (trackMain ? "main" : "");
  const release = trackMain || argv.includes("--release") || ctx.env.ORKESTR_RELEASE_DEPLOY === "1";
  const inPlace = argv.includes("--in-place");
  const checkOnly = argv.includes("--check-only");
  const allInstances = argv.includes("--all-instances");
  const noAllInstances = argv.includes("--no-all-instances");
  const deployAllInstances = release && !inPlace && !noAllInstances;
  const allowUntagged = trackMain || argv.includes("--allow-untagged") || argv.includes("--allow-untagged-releases");
  const requireTagged = argv.includes("--require-tagged") || argv.includes("--require-tagged-releases");
  const env = { ...ctx.env };
  if (ref) {
    env.ORKESTR_UPDATE_REF = ref;
    env.ORKESTR_DEPLOY_REF = ref;
  }
  if (channel) env.ORKESTR_DEPLOY_CHANNEL = channel;
  if (release && !inPlace) env.ORKESTR_RELEASE_DEPLOY = "1";
  if (inPlace) env.ORKESTR_RELEASE_DEPLOY = "0";
  if (deployAllInstances || allInstances) env.ORKESTR_RELEASE_TRAIN_FANOUT = "1";
  if (noAllInstances) env.ORKESTR_RELEASE_TRAIN_FANOUT = "0";
  if (allowUntagged) env.ORKESTR_DEPLOY_TAGS_ONLY = "0";
  if (requireTagged) env.ORKESTR_DEPLOY_TAGS_ONLY = "1";

  const script = updateScriptPath(release && !inPlace ? "deploy-git-release.sh" : "update-watch.sh");
  const args = release && !inPlace
    ? [
        "install",
        ...(ref ? ["--ref", ref] : []),
        ...(channel ? ["--channel", channel] : []),
        ...(allowUntagged ? ["--allow-untagged"] : []),
        ...(requireTagged ? ["--require-tagged"] : []),
        ...(argv.includes("--no-smoke") ? ["--no-smoke"] : []),
        ...(deployAllInstances || allInstances ? ["--all-instances"] : []),
        ...(noAllInstances ? ["--no-all-instances"] : []),
        ...deployGuardArgs(argv),
        ...(checkOnly ? ["--check-only"] : []),
      ]
    : [...(checkOnly ? ["--check-only"] : [])];
  const label = release && !inPlace ? "versioned release update" : "in-place update";
  if (!argv.includes("--json")) ctx.stdout.write(`Starting Orkestr ${label}${ref ? ` for ${ref}` : ""}...\n`);
  if (release && !inPlace) {
    const systemdRun = releaseUpdateSystemdRunCommand(script, args, env);
    if (systemdRun) {
      if (!argv.includes("--json")) {
        ctx.stdout.write(`Running release outside ${systemdRun.serviceUnit}; follow logs with: journalctl -u ${systemdRun.unitName} -f\n`);
      }
      return spawnInherited(ctx.spawnImpl, systemdRun.command, systemdRun.args, { env });
    }
  }
  return spawnInherited(ctx.spawnImpl, "bash", [script, ...args], { env });
}

async function updateStatusCommand(argv, ctx) {
  const script = updateScriptPath("deploy-git-release.sh");
  return spawnInherited(ctx.spawnImpl, "bash", [script, "status", ...(argv.includes("--json") ? ["--json"] : [])], { env: ctx.env });
}

async function updateRollbackCommand(argv, ctx) {
  const script = updateScriptPath("deploy-git-release.sh");
  const target = flagValue(argv, "--to");
  return spawnInherited(ctx.spawnImpl, "bash", [script, "rollback", ...(target ? ["--to", target] : []), ...deployGuardArgs(argv)], { env: ctx.env });
}

async function serviceCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "status" : argv[0] || "status";
  const rest = subcommand === "status" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "status") return serviceActionCommand("status", rest, ctx);
  if (subcommand === "start") return serviceActionCommand("start", rest, ctx);
  if (subcommand === "stop") return serviceActionCommand("stop", rest, ctx);
  if (subcommand === "restart") return serviceActionCommand("restart", rest, ctx);
  if (subcommand === "logs" || subcommand === "log") return serviceLogsCommand(rest, ctx);
  throw new Error("Usage: orkestr service [status|start|stop|restart|logs] [--service name] [--lines 100] [--no-follow]");
}

async function serviceActionCommand(action, argv, ctx) {
  const manager = serviceManager(ctx.env);
  const service = flagValue(argv, "--service") || "";
  if (manager === "launchd") {
    const label = service || ctx.env.ORKESTR_LOCAL_SERVICE_LABEL || "com.orkestr.oss";
    const target = `${launchdDomain()}/${label}`;
    const plist = ctx.env.ORKESTR_LOCAL_SERVICE_FILE || path.join(ctx.env.HOME || process.env.HOME || "", "Library", "LaunchAgents", `${label}.plist`);
    if (action === "status") return spawnInherited(ctx.spawnImpl, "launchctl", ["print", target]);
    if (action === "stop") return spawnInherited(ctx.spawnImpl, "launchctl", ["bootout", target]);
    if (action === "start") return spawnInherited(ctx.spawnImpl, "sh", ["-c", `launchctl bootstrap ${shellToken(launchdDomain())} ${shellToken(plist)} 2>/dev/null || true; exec launchctl kickstart -k ${shellToken(target)}`]);
    return spawnInherited(ctx.spawnImpl, "sh", ["-c", `launchctl bootout ${shellToken(target)} >/dev/null 2>&1 || true; launchctl bootstrap ${shellToken(launchdDomain())} ${shellToken(plist)}; exec launchctl kickstart -k ${shellToken(target)}`]);
  }
  if (manager === "systemd-user") {
    const unit = serviceUnitName(service || ctx.env.ORKESTR_LOCAL_SERVICE_NAME || ctx.env.ORKESTR_SERVICE_NAME || "orkestr");
    return spawnInherited(ctx.spawnImpl, "systemctl", ["--user", action, unit]);
  }
  if (manager === "cron" || manager === "background") {
    return cronServiceAction(action, ctx);
  }
  if (manager === "none") throw new Error("No Orkestr service manager is configured for this install.");
  const unit = serviceUnitName(service || ctx.env.ORKESTR_SERVICE_NAME || "orkestr");
  return spawnInherited(ctx.spawnImpl, "systemctl", [action, unit]);
}

async function serviceLogsCommand(argv, ctx) {
  const manager = serviceManager(ctx.env);
  const lines = flagValue(argv, "--lines") || "100";
  if (manager === "launchd" || manager === "cron" || manager === "background") {
    const logDir = ctx.env.ORKESTR_LOCAL_LOG_DIR || path.join(ctx.env.ORKESTR_HOME || ".", "logs");
    const args = ["-n", lines];
    if (!argv.includes("--no-follow")) args.push("-f");
    args.push(path.join(logDir, "orkestr.out.log"), path.join(logDir, "orkestr.err.log"));
    return spawnInherited(ctx.spawnImpl, "tail", args);
  }
  if (manager === "none") throw new Error("No Orkestr service manager is configured for this install.");
  const service = serviceUnitName(flagValue(argv, "--service") || ctx.env.ORKESTR_LOCAL_SERVICE_NAME || ctx.env.ORKESTR_SERVICE_NAME || "orkestr");
  const args = manager === "systemd-user"
    ? ["--user", "-u", service, "-n", lines, "--no-pager"]
    : ["-u", service, "-n", lines, "--no-pager"];
  if (!argv.includes("--no-follow")) args.push("-f");
  return spawnInherited(ctx.spawnImpl, "journalctl", args);
}

async function cronServiceAction(action, ctx) {
  const wrapper = ctx.env.ORKESTR_LOCAL_SERVER_WRAPPER || "";
  const pidFile = ctx.env.ORKESTR_LOCAL_PID_FILE || path.join(ctx.env.ORKESTR_HOME || ".", "orkestr.pid");
  const logDir = ctx.env.ORKESTR_LOCAL_LOG_DIR || path.join(ctx.env.ORKESTR_HOME || ".", "logs");
  const outLog = path.join(logDir, "orkestr.out.log");
  const errLog = path.join(logDir, "orkestr.err.log");
  const stopCommand = localBackgroundStopCommand(ctx.env, pidFile);
  if (!wrapper) throw new Error("ORKESTR_LOCAL_SERVER_WRAPPER is required for cron service control.");
  if (action === "status") {
    return spawnInherited(ctx.spawnImpl, "sh", ["-c", `if [ -f ${shellToken(pidFile)} ] && kill -0 "$(cat ${shellToken(pidFile)})" >/dev/null 2>&1; then echo "Orkestr running: $(cat ${shellToken(pidFile)})"; else echo "Orkestr is not running"; exit 3; fi`]);
  }
  if (action === "stop") {
    return spawnInherited(ctx.spawnImpl, "sh", ["-c", stopCommand]);
  }
  if (action === "start") {
    return spawnInherited(ctx.spawnImpl, "sh", ["-c", `mkdir -p ${shellToken(logDir)}; if [ -f ${shellToken(pidFile)} ] && kill -0 "$(cat ${shellToken(pidFile)})" >/dev/null 2>&1; then exit 0; fi; ${localBackgroundProcessCleanupCommand(ctx.env)}; ${localBackgroundStartProcessCommand(ctx.env, wrapper, outLog, errLog, pidFile)}`]);
  }
  return spawnInherited(ctx.spawnImpl, "sh", ["-c", `${stopCommand}; mkdir -p ${shellToken(logDir)}; ${localBackgroundStartProcessCommand(ctx.env, wrapper, outLog, errLog, pidFile)}`]);
}

async function listSecurityChallenges(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await listPairingChallenges({ env: ctx.env });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatSecurityChallengeTable(payload.challenges || []));
  return 0;
}

async function listSecuritySessionsCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await listSecuritySessions({ env: ctx.env });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatSecuritySessionTable(payload.sessions || []));
  return 0;
}

async function approveSecurityChallenge(argv, ctx, commandName = "security") {
  const json = argv.includes("--json");
  const challengeId = positional(argv)[0];
  if (!challengeId) throw new Error(`Usage: orkestr ${commandName} approve <${commandName === "connect" ? "code" : "challenge-id"}> [--json]`);
  const payload = await approvePairingChallenge(challengeId, { env: ctx.env, approvedBy: "cli" });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Approved pairing challenge ${payload.challenge.approveCode || payload.challenge.id}\n`);
  return 0;
}

async function rejectSecurityChallenge(argv, ctx) {
  const json = argv.includes("--json");
  const challengeId = positional(argv)[0];
  if (!challengeId) throw new Error("Usage: orkestr security reject <challenge-id> [--json]");
  const payload = await rejectPairingChallenge(challengeId, { env: ctx.env, rejectedBy: "cli" });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Rejected pairing challenge ${payload.challenge.id}\n`);
  return 0;
}

async function revokeSecuritySessionCommand(argv, ctx) {
  const json = argv.includes("--json");
  const sessionId = positional(argv)[0];
  if (!sessionId) throw new Error("Usage: orkestr security revoke <session-id|all> [--json]");
  const payload = sessionId === "all"
    ? await revokeAllSecuritySessions({ env: ctx.env, revokedBy: "cli" })
    : await revokeSecuritySession(sessionId, { env: ctx.env, revokedBy: "cli" });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Revoked ${payload.revoked.length} browser session${payload.revoked.length === 1 ? "" : "s"}\n`);
  return 0;
}

async function threadCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  if (subcommand === "create") return createThreadCommand(argv.slice(1), ctx);
  throw new Error("Usage: orkestr thread create <name> [--id id] [--cwd path] [--command command] [--executor id] [--json]");
}

async function createThreadCommand(argv, ctx) {
  const json = argv.includes("--json");
  const name = positional(argv)[0];
  if (!name) throw new Error("Usage: orkestr thread create <name> [--id id] [--cwd path] [--command command] [--executor id] [--json]");
  const body = { name };
  const id = flagValue(argv, "--id");
  const cwd = flagValue(argv, "--cwd");
  const command = flagValue(argv, "--command") || flagValue(argv, "--cmd");
  const executorId = flagValue(argv, "--executor");
  if (id) body.id = id;
  if (cwd) body.cwd = cwd;
  if (command) body.command = command;
  if (executorId) body.executorId = executorId;
  const payload = await requestJson("/api/threads", { ...ctx, method: "POST", body });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Created ${threadName(payload.thread || body)}\n`);
  return 0;
}

async function workerCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  if (subcommand === "create") return createWorkerCommand(argv.slice(1), ctx);
  throw new Error("Usage: orkestr worker create <parent-thread> [task text] [--task text] [--blank] [--label label] [--repo path] [--branch branch] [--no-wake] [--json]");
}

async function createWorkerCommand(argv, ctx) {
  const json = argv.includes("--json");
  const values = positional(argv);
  const parent = values[0];
  if (!parent) throw new Error("Usage: orkestr worker create <parent-thread> [task text] [--task text] [--blank] [--label label] [--repo path] [--branch branch] [--no-wake] [--json]");
  const blank = argv.includes("--blank");
  const task = blank ? "" : (flagValue(argv, "--task") || values.slice(1).join(" ")).trim();
  const body = {};
  const label = flagValue(argv, "--label");
  const repoPath = flagValue(argv, "--repo") || flagValue(argv, "--repo-path") || flagValue(argv, "--cwd");
  const branchName = flagValue(argv, "--branch") || flagValue(argv, "--branch-name");
  if (label) body.label = label;
  if (task) body.task = task;
  if (blank) body.autoRun = false;
  if (repoPath) body.repoPath = repoPath;
  if (branchName) body.branchName = branchName;
  if (argv.includes("--no-wake")) body.wake = false;
  const payload = await requestJson(`/api/threads/${encodeURIComponent(parent)}/workers`, {
    ...ctx,
    method: "POST",
    body,
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Created ${threadName(payload.worker || {}) || payload.worker?.id || "worker"}\n`);
  return 0;
}

async function attach(argv, ctx) {
  const printOnly = argv.includes("--print");
  const json = argv.includes("--json");
  const readOnly = argv.includes("--read-only");
  const takeover = argv.includes("--takeover");
  const interrupt = argv.includes("--interrupt");
  const yes = argv.includes("--yes");
  const intervalMs = parseDurationMs(flagValue(argv, "--interval"), { numericUnit: "seconds" });
  const timeoutMs = parseDurationMs(flagValue(argv, "--timeout"), { numericUnit: "seconds" });
  const targetArg = positional(argv)[0];
  const target = targetArg || threadName(await chooseThread(ctx));
  const body = {};
  if (readOnly) body.readOnly = true;
  if (takeover) body.takeover = true;
  if (interrupt) body.interrupt = true;
  if (yes) body.yes = true;
  if (intervalMs) body.intervalMs = intervalMs;
  if (timeoutMs) body.timeoutMs = timeoutMs;
  body.watchStartedAtMs = Date.now();
  const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/attach`, {
    ...ctx,
    method: "POST",
    ...(Object.keys(body).length ? { body } : {}),
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (payload.watchOnly || payload.attachable === false) {
    ctx.stdout.write(String(payload.watchText || rawAttachWatchText(payload.watch || {})));
    if (readOnly || printOnly) return 0;
    if (!takeover && !ctx.stdin?.isTTY) return 0;
    return watchAttachUntilAttachable(target, body, ctx, { printOnly, interactive: Boolean(ctx.stdin?.isTTY) });
  }
  return runAttachPayload(payload, target, ctx, { printOnly });
}

async function watchAttachUntilAttachable(target, body, ctx, { printOnly = false, interactive = false } = {}) {
  const startedAtMs = Number(body.watchStartedAtMs || Date.now());
  const timeoutMs = Number(body.timeoutMs || 15 * 60_000);
  const intervalMs = Number(body.intervalMs || 5000);
  const keys = interactive ? createAttachWatchKeyReader(ctx.stdin) : null;
  try {
    for (;;) {
      if (Date.now() - startedAtMs >= timeoutMs) throw new Error(`Attach watch timed out for ${target}`);
      await sleep(ctx, Math.max(1000, intervalMs));
      const key = keys?.take();
      if (key === "r") {
        body.readOnly = true;
        body.takeover = false;
        body.interrupt = false;
        ctx.stdout.write("Read-only watch enabled.\n");
      } else if (key === "i") {
        body.takeover = true;
        body.interrupt = true;
        body.yes = true;
        ctx.stdout.write("Interrupt takeover requested.\n");
      } else if (key === "a" || key === "d") {
        await sendAttachWatchApproval(target, key === "a", ctx);
        ctx.stdout.write(key === "a" ? "Approval sent.\n" : "Denial sent.\n");
      } else if (key && key !== "s") {
        ctx.stdout.write("Hotkeys: Ctrl-C cancel; i interrupt/take over; r read-only; s refresh; a approve; d deny\n");
      }
      const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/attach`, {
        ...ctx,
        method: "POST",
        body: { ...body, watchStartedAtMs: startedAtMs },
      });
      if (payload.watchOnly || payload.attachable === false) {
        ctx.stdout.write(String(payload.watchText || rawAttachWatchText(payload.watch || {})));
        if (body.readOnly) return 0;
        continue;
      }
      return runAttachPayload(payload, target, ctx, { printOnly });
    }
  } finally {
    keys?.close();
  }
}

function sleep(ctx, ms) {
  return ctx.sleepImpl ? ctx.sleepImpl(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}

function createAttachWatchKeyReader(stdin) {
  const keys = [];
  const previousRawMode = Boolean(stdin.isRaw);
  const onData = (chunk) => {
    const text = String(chunk || "");
    if (text.includes("\u0003")) {
      process.kill(process.pid, "SIGINT");
      return;
    }
    for (const char of text) {
      const key = char.toLowerCase();
      if (["i", "r", "s", "a", "d"].includes(key)) keys.push(key);
    }
  };
  stdin.setEncoding?.("utf8");
  stdin.setRawMode?.(true);
  stdin.resume?.();
  stdin.on?.("data", onData);
  return {
    take() {
      return keys.shift() || "";
    },
    close() {
      stdin.off?.("data", onData);
      stdin.setRawMode?.(previousRawMode);
      if (!previousRawMode) stdin.pause?.();
    },
  };
}

async function sendAttachWatchApproval(target, approve, ctx) {
  return requestJson(`/api/threads/${encodeURIComponent(target)}/input`, {
    ...ctx,
    method: "POST",
    body: {
      text: approve ? "Approved. Proceed." : "deny",
      source: "raw-attach-watch",
      parseCommands: true,
      controlAllowed: true,
    },
  });
}

function runAttachPayload(payload, target, ctx, { printOnly = false } = {}) {
  if (!payload.ok) throw new Error(payload.message || `Thread is not attachable: ${target}`);
  const sessionName = payload.runtime?.sessionName || parseTmuxSession(payload.attachCommand);
  const attachCommand = String(payload.attachCommand || "").trim();
  if (!sessionName && !attachCommand) throw new Error("Attach response did not include an attach command.");
  if (printOnly) {
    ctx.stdout.write(`${sessionName ? `tmux attach-session -t ${shellToken(sessionName)}` : attachCommand}\n`);
    return 0;
  }
  if (!sessionName) return spawnInherited(ctx.spawnImpl, "sh", ["-lc", `exec ${attachCommand}`]);
  return spawnInherited(ctx.spawnImpl, "tmux", ["attach-session", "-t", sessionName]);
}

function parseDurationMs(value, { numericUnit = "milliseconds" } = {}) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric * (numericUnit === "seconds" ? 1000 : 1)));
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount)) return 0;
  if (unit === "ms") return Math.floor(amount);
  if (unit.startsWith("s")) return Math.floor(amount * 1000);
  if (unit.startsWith("m")) return Math.floor(amount * 60_000);
  return Math.floor(amount * 60 * 60_000);
}

async function chooseThread(ctx) {
  const payload = await requestJson("/api/threads/summary", ctx);
  return ctx.pickThread(payload?.threads || [], ctx);
}

async function send(argv, ctx) {
  const json = argv.includes("--json");
  const values = positional(argv);
  const target = values[0];
  const text = values.slice(1).join(" ").trim();
  if (!target || !text) throw new Error('Usage: orkestr send <thread> "<message>"');
  const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/input`, {
    ...ctx,
    method: "POST",
    body: { text, source: "cli", parseCommands: true, controlAllowed: true },
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const label = payload.deliveryState === "awaiting_ack" ? "Awaiting ack" : payload.queued ? "Queued" : "Sent";
    ctx.stdout.write(`${label} ${payload.orkestrThreadId || target}\n`);
  }
  return 0;
}

async function postThreadAction(action, argv, ctx) {
  const json = argv.includes("--json");
  const target = positional(argv)[0];
  if (!target) throw new Error(`Usage: orkestr ${action} <thread>`);
  const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/${action}`, {
    ...ctx,
    method: "POST",
    body: { source: "cli" },
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const label = action === "wake"
      ? "Woke"
      : action === "sleep"
        ? "Slept legacy tmux runtime"
        : action === "hard-reset"
          ? "Hard reset"
          : action === "safe-reset"
            ? "Safe reset"
            : "Reset";
    ctx.stdout.write(`${label} ${target}\n`);
  }
  return 0;
}

function writeHelp(ctx) {
  writeUsage(ctx.stdout);
  return 0;
}

function writeUsage(stream) {
  stream.write(`Usage:
  orkestr [serve] [--open] [--host 127.0.0.1] [--port 19812]
  orkestr status [--json]
  orkestr version [--json]
  orkestr instances [--probe] [--json]
  orkestr service [status|start|stop|restart|logs] [--service orkestr] [--lines 100] [--no-follow]
  orkestr start|stop|restart
  orkestr update
  orkestr rollback [--to release-id]
  orkestr logs [--service orkestr] [--lines 100] [--no-follow]
  orkestr doctor [system|timers|resources] [--repair] [--json]

Common thread commands:
  orkestr list [--json] [--api http://127.0.0.1:19812]
  orkestr create <name> [--wa-participant jid]... [--no-wa] [--json]
  orkestr whereiam [--cwd path] [--api-session-id id] [--bind] [--json]
  orkestr sanitizer check --action action --text text [--url url] [--cwd path] [--json]
  orkestr api-session bind [--api-session-id id] [--cwd path] [--thread thread-id] [--json]
  orkestr api-session message <text> [--api-session-id id] [--role assistant|user] [--phase final_answer] [--json]
  orkestr api-session status [--api-session-id id] [--json]
  orkestr connect google [--account email] [--json]
  orkestr attach [thread-name-or-id] [--print] [--read-only] [--takeover] [--interrupt] [--yes] [--interval seconds] [--timeout duration] [--json]
  orkestr send <thread-name-or-id> "<message>" [--json]
  orkestr wake <thread-name-or-id> [--json]
  orkestr reset <thread-name-or-id> [--json]
  orkestr hard-reset <thread-name-or-id> [--json]
  orkestr safe-reset <thread-name-or-id> [--json]

Advanced:
  orkestr update [--track-main|--ref ref] [--release|--in-place] [--channel name] [--allow-untagged|--require-tagged] [--no-smoke] [--all-instances] [--wait-active] [--active-timeout seconds|--allow-interrupt]
  orkestr update status [--json]
  orkestr update rollback [--to release-id]
  orkestr settings [--json]
  orkestr secret [list|set|delete] [--global|--user user-id] [--json]
  orkestr codex [status|migrate] [--dry-run] [--json]
  orkestr whatsapp accounts [list|add|status|update|pair|reconnect|disconnect|remove|doctor] [--json]
  orkestr whatsapp migrate [--dry-run] [--json]
  orkestr whatsapp bindings [list|create|status|resolve|update|delete] [--json]
  orkestr whatsapp codex [status|connect] --thread <thread> [--account id] [--json]
  orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--json]
  orkestr timers [list|doctor|run <timer-id>] [--json]
  orkestr jobs run [--owner-user-id user] [--target-thread thread] [--max-results N] [--json]
  orkestr connect approve <code> [--json]
  orkestr security [challenges|sessions|approve <challenge-id>|reject <challenge-id>|revoke <session-id|all>] [--json]
  orkestr desktop [share [slug]|approve <challenge-id>] [--json]
  orkestr jira draft <thread> [--max N] [--json]
  orkestr thread create <name> [--id id] [--cwd path] [--command command] [--executor id] [--json]
  orkestr worker create <parent-thread> [task text] [--task text] [--blank] [--label label] [--repo path] [--branch branch] [--no-wake] [--json]
  orkestr sleep <legacy-tmux-thread-name-or-id> [--json]

Environment:
  ORKESTR_API_BASE   API base URL for commands. Defaults to http://127.0.0.1:19812.
`);
}

async function settleRequest(path, ctx) {
  try {
    return { ok: true, value: await requestJson(path, ctx), error: "" };
  } catch (error) {
    return { ok: false, value: null, error: error?.message || String(error) };
  }
}

function formatStatus(payload = {}) {
  const version = payload.version || {};
  const setup = payload.setup || {};
  const doctor = payload.doctor || {};
  const security = setup.security || {};
  const connectors = Array.isArray(setup.connectors) ? setup.connectors : [];
  const connectorText = connectors.length
    ? connectors.map((connector) => `${connector.id}:${connector.state || "unknown"}`).join(" ")
    : "-";
  const counts = doctor.counts || {};
  const status = payload.ok ? "ok" : "attention";
  const release = releaseDisplayLabel(version);
  const versionText = [version.name || "orkestr", version.version || ""].filter(Boolean).join(" ");
  const lines = [
    `Orkestr: ${status}`,
    `URL: ${payload.baseUrl || "-"}`,
    `Version: ${versionText || "-"} (${release})`,
    `Channel: ${version.channel || "-"}${version.dirty ? " dirty" : ""}`,
    `Setup: ${setup.setupState || (payload.errors?.setup ? "unavailable" : "-")}`,
    `Security: paired=${security.paired ? "yes" : "no"} remote=${security.remoteReady ? "ready" : "not-ready"} pending=${Number(security.pendingChallengeCount || 0)}`,
    `Connectors: ${connectorText}`,
    `Doctor: ${doctor.status || (payload.errors?.doctor ? "unavailable" : "-")}${doctor.summary ? ` - ${doctor.summary}` : ""}`,
  ];
  if (doctor.counts) lines.push(`Checks: ${Number(counts.ok || 0)} ok, ${Number(counts.warnings || 0)} warnings, ${Number(counts.errors || 0)} errors`);
  for (const [label, error] of Object.entries(payload.errors || {})) {
    if (error) lines.push(`${label}: ${error}`);
  }
  return lines.join("\n");
}

function formatVersion(version = {}) {
  const release = releaseDisplayLabel(version);
  return [
    `Orkestr: ${[version.name || "orkestr", version.version || ""].filter(Boolean).join(" ")}`,
    `Release: ${release}`,
    `Distribution: ${version.distributionKind || version.distribution?.kind || "-"}${version.deploymentTrack ? ` (${version.deploymentTrack})` : ""}`,
    `Commit: ${shortCommit(version.commit) || "-"}${version.dirty ? " dirty" : ""}`,
    `Ref: ${version.tag || version.branch || version.describe || "-"}`,
    `Channel: ${version.channel || "-"}`,
    `Deployed: ${version.deployedAt || "-"}`,
  ].join("\n");
}

function formatReleaseInstanceTable(instances = []) {
  if (!instances.length) return "No release instances registered.";
  const rows = instances.map((instance) => {
    const version = instance.currentVersion || {};
    const release = releaseDisplayLabel(version);
    const train = instance.kind === "local-service"
      ? "local"
      : instance.releaseTrainEnabled
      ? (instance.hasDeployCommand ? "ready" : "needs-command")
      : "disabled";
    return [
      instance.id || "-",
      instance.kind || "-",
      instance.status || "-",
      train,
      release,
      instance.baseUrl || instance.versionUrl || "-",
    ];
  });
  const widths = [10, 12, 10, 13, 12, 24].map((minimum, index) => Math.max(minimum, ...rows.map((row) => String(row[index] || "").length)));
  const header = ["ID", "KIND", "STATUS", "TRAIN", "RELEASE", "URL"].map((value, index) => value.padEnd(widths[index])).join("  ");
  const body = rows.map((row) => row.map((value, index) => String(value || "-").padEnd(widths[index])).join("  ")).join("\n");
  return `${header}\n${body}`;
}

function shortCommit(value) {
  const text = String(value || "");
  return text.length > 12 ? text.slice(0, 12) : text;
}

function releaseDisplayLabel(version = {}) {
  const semanticVersion = String(version.releaseVersion || version.version || "").trim();
  return String(version.releaseLabel || version.tag || (semanticVersion ? `v${semanticVersion}` : "") || version.releaseId || version.describe || shortCommit(version.commit) || "-").trim();
}

function formatSettings(settings = {}) {
  const codex = settings.codex || {};
  const desktops = settings.desktops || {};
  const connectors = settings.connectors || {};
  return [
    `Codex: sandbox=${codex.sandbox || "-"} approval=${codex.approvalPolicy || "-"} yolo=${codex.bypassApprovalsAndSandbox ? "yes" : "no"}`,
    `Desktops: mode=${desktops.mode || "-"} default=${desktops.default || "-"} gmail=${desktops.gmailAuth || "-"} manual=${desktops.manualIntervention || "-"}`,
    `WhatsApp: ${connectors.whatsapp?.bridgeMode || "-"} receiveAlias=${connectors.whatsapp?.senderRole || "-"} replyAlias=${connectors.whatsapp?.responderRole || "-"}`,
    `Gmail: ${connectors.gmail?.enabled ? "enabled" : "optional"} authDesktop=${connectors.gmail?.authDesktop || "-"}`,
    `Outlook: ${connectors.outlook?.enabled ? "enabled" : "optional"}`,
  ].join("\n");
}

function formatWhereAmI(payload = {}) {
  if (!payload.ok || !payload.thread) {
    return [
      "No Orkestr thread matched this directory.",
      `CWD: ${payload.cwd || process.cwd()}`,
      "Try: orkestr list",
    ].join("\n");
  }
  const thread = payload.thread || {};
  const workspace = payload.workspace || {};
  const runtime = payload.runtime || {};
  const settings = payload.settings || {};
  const desktops = settings.desktops || {};
  return [
    `Thread: ${thread.displayName || thread.name || thread.id} (${thread.id})`,
    `State: ${thread.state || runtime.state || "unknown"}`,
    `CWD: ${workspace.cwd || payload.cwd || "-"}`,
    `Runtime workspace: ${workspace.runtimeWorkspace || "-"}`,
    `Repo: ${workspace.repoPath || workspace.worktreePath || "-"}`,
    `Desktop: ${desktops.manualIntervention || desktops.default || "-"}`,
    `Runtime: ${runtime.sessionName || "-"}${runtime.paneId ? ` ${runtime.paneId}` : ""}`,
  ].join("\n");
}

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set([
    "--branch",
    "--branch-name",
    "--account",
    "--account-id",
    "--action",
    "--chat",
    "--chat-id",
    "--cmd",
    "--command",
    "--cwd",
    "--executor",
    "--domain",
    "--email",
    "--href",
    "--host",
    "--id",
    "--label",
    "--level",
    "--limit",
    "--name",
    "--port",
    "--phone",
    "--phone-number",
    "--repo",
    "--repo-path",
    "--reason",
    "--reply-prefix",
    "--reply-account",
    "--bridge-account",
    "--receiving-account",
    "--responder-account",
    "--service",
    "--sender-account",
    "--status",
    "--task",
    "--target-account",
    "--target-account-id",
    "--owner-contact",
    "--owner-contact-id",
    "--owner-contact-alias",
    "--owner-alias",
    "--authorized-contact",
    "--authorized-contact-id",
    "--authorized-contact-alias",
    "--authorized-alias",
    "--sender-contact",
    "--sender-contact-id",
    "--additional-participant",
    "--additional-participant-id",
    "--value",
    "--secret-value",
    "--tenant",
    "--tenant-id",
    "--title",
    "--ref",
    "--channel",
    "--lines",
    "--to",
    "--timeout",
    "--active-timeout",
    "--url",
    "--api-session",
    "--api-session-id",
    "--wa-admin",
    "--wa-account",
    "--admin-participant",
    "--wa-participant",
    "--participant",
    "--wa-title",
    "--outbound-account",
    "--inbound-account",
    "--interval",
    "--message",
    "--pane-id",
    "--phase",
    "--role",
    "--session-name",
    "--source",
    "--state",
    "--text",
    "--thread",
    "--thread-id",
    "--delivery-type",
    "--type",
    "--instance",
    "--instance-id",
    "--user",
    "--user-id",
    "--owner",
    "--owner-user",
    "--owner-user-id",
  ]);
  const flagsWithoutValues = new Set([
    "--blank",
    "--force-new",
    "--json",
    "--no-admin",
    "--no-mirror",
    "--no-picture",
    "--no-wa-admin",
    "--no-wake",
    "--print",
    "--open",
    "--repair",
    "--release",
    "--in-place",
    "--track-main",
    "--allow-untagged",
    "--allow-untagged-releases",
    "--require-tagged",
    "--require-tagged-releases",
    "--no-smoke",
    "--no-interrupt",
    "--allow-interrupt",
    "--wait-active",
    "--no-wait-active",
    "--check-only",
    "--global",
    "--no-follow",
    "--probe",
    "--stdin",
    "--no-bind",
    "--all-instances",
    "--no-all-instances",
    "--takeover",
    "--interrupt",
    "--read-only",
    "--yes",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (flagsWithoutValues.has(value)) continue;
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}

function repeatedFlagValues(argv, flags) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (flags.includes(argv[index])) values.push(argv[index + 1] || "");
  }
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function formatSecurityChallengeTable(challenges) {
  if (!challenges.length) return "No pairing challenges.\n";
  const rows = challenges.map((challenge) => {
    const requester = [challenge.requestedIp, challenge.requestedUserAgent].filter(Boolean).join(" ");
    return [
      challenge.id,
      challenge.status,
      challenge.expiresAt || "-",
      requester || "-",
    ];
  });
  const widths = [18, 10, 24, 32].map((minimum, index) => Math.max(minimum, ...rows.map((row) => String(row[index] || "").length)));
  const header = ["ID", "STATUS", "EXPIRES", "REQUESTER"].map((value, index) => value.padEnd(widths[index])).join("  ");
  const body = rows.map((row) => row.map((value, index) => String(value || "").padEnd(widths[index])).join("  ")).join("\n");
  return `${header}\n${body}\n`;
}

function formatSecuritySessionTable(sessions) {
  if (!sessions.length) return "No paired browser sessions.\n";
  const rows = sessions.map((session) => [
    session.id,
    session.expiresAt || "-",
    session.createdAt || "-",
    session.userAgent || "-",
  ]);
  const widths = [14, 24, 24, 32].map((minimum, index) => Math.max(minimum, ...rows.map((row) => String(row[index] || "").length)));
  const header = ["ID", "EXPIRES", "CREATED", "USER AGENT"].map((value, index) => value.padEnd(widths[index])).join("  ");
  const body = rows.map((row) => row.map((value, index) => String(value || "").padEnd(widths[index])).join("  ")).join("\n");
  return `${header}\n${body}\n`;
}

function parseTmuxSession(command = "") {
  const match = String(command).match(/tmux\s+attach-session\s+-t\s+(.+)$/);
  return match?.[1]?.trim() || "";
}

function localBackgroundStopCommand(env, pidFile) {
  const tmuxSession = String(env.ORKESTR_LOCAL_TMUX_SESSION || "orkestr-service").trim();
  const stopTmux = `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${shellToken(tmuxSession)} >/dev/null 2>&1 || true; fi`;
  return `${stopTmux}; if [ -f ${shellToken(pidFile)} ]; then kill "$(cat ${shellToken(pidFile)})" >/dev/null 2>&1 || true; rm -f ${shellToken(pidFile)}; fi; ${localBackgroundProcessCleanupCommand(env)}`;
}

function localBackgroundStartProcessCommand(env, wrapper, outLog, errLog, pidFile) {
  const tmuxSession = String(env.ORKESTR_LOCAL_TMUX_SESSION || "orkestr-service").trim();
  const tmuxCommand = `exec ${shellToken(wrapper)} >> ${shellToken(outLog)} 2>> ${shellToken(errLog)}`;
  return `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${shellToken(tmuxSession)} >/dev/null 2>&1 || true; if tmux new-session -d -s ${shellToken(tmuxSession)} ${shellToken(tmuxCommand)}; then tmux display-message -p -t ${shellToken(tmuxSession)} '#{pane_pid}' > ${shellToken(pidFile)} 2>/dev/null || true; exit 0; fi; fi; nohup ${shellToken(wrapper)} >> ${shellToken(outLog)} 2>> ${shellToken(errLog)} & echo $! > ${shellToken(pidFile)}`;
}

function localBackgroundProcessCleanupCommand(env = {}) {
  const appDir = String(env.ORKESTR_APP_DIR || "").trim();
  const patterns = [
    appDir ? path.join(appDir, "dist/server/apps/server/src/server.js") : "",
  ].map(processSearchPattern).filter(Boolean);
  if (!patterns.length) return ":";
  return patterns.map((pattern) => `if command -v pgrep >/dev/null 2>&1; then pgrep -f ${shellToken(pattern)} | while IFS= read -r pid; do [ -n "$pid" ] || continue; [ "$pid" = "$$" ] && continue; kill "$pid" >/dev/null 2>&1 || true; done; fi`).join("; ");
}

function processSearchPattern(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length === 1) return escapeRegex(text);
  return `[${escapeRegexCharClass(text[0])}]${escapeRegex(text.slice(1))}`;
}

function escapeRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeRegexCharClass(value) {
  return String(value).replace(/[\\\]^"-]/g, "\\$&");
}

function shellToken(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function serviceUnitName(value) {
  const name = String(value || "orkestr").trim() || "orkestr";
  return name.endsWith(".service") ? name : `${name}.service`;
}

function serviceManager(env = process.env) {
  const explicit = String(env.ORKESTR_LOCAL_SERVICE_MANAGER || env.ORKESTR_SERVICE_MANAGER || "").trim();
  if (explicit) return explicit;
  return "systemd";
}

function launchdDomain() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function updateScriptPath(scriptName) {
  return path.join(repoRoot(), "scripts", scriptName);
}

function releaseUpdateSystemdRunCommand(script, args, env) {
  if (env.ORKESTR_UPDATE_SYSTEMD_RUN === "0") return null;
  if (serviceManager(env) !== "systemd") return null;
  const cgroup = currentProcessCgroup(env);
  const inferredUnit = currentSystemdServiceUnit(cgroup);
  const serviceUnit = serviceUnitName(env.ORKESTR_SERVICE_NAME || (inferredUnit.startsWith("orkestr") ? inferredUnit : "") || "orkestr");
  if (!cgroupIncludesUnit(cgroup, serviceUnit)) return null;
  const unitName = transientReleaseUnitName();
  return {
    command: "systemd-run",
    unitName,
    serviceUnit,
    args: [
      "--collect",
      "--same-dir",
      `--unit=${unitName}`,
      `--description=Orkestr release update for ${env.ORKESTR_DEPLOY_REF || args.join(" ") || "current ref"}`,
      ...systemdRunEnvArgs(env),
      "bash",
      script,
      ...args,
    ],
  };
}

function currentProcessCgroup(env) {
  if (env.ORKESTR_TEST_PROC_CGROUP) return String(env.ORKESTR_TEST_PROC_CGROUP);
  try {
    return fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

function currentSystemdServiceUnit(cgroup) {
  return String(cgroup || "").match(/(?:^|\/)([^/\n]+\.service)(?:\/|$)/)?.[1] || "";
}

function cgroupIncludesUnit(cgroup, unit) {
  const serviceUnit = serviceUnitName(unit);
  return String(cgroup || "").split("\n").some((line) => line.includes(`/${serviceUnit}`) || line.endsWith(serviceUnit));
}

function transientReleaseUnitName() {
  return `orkestr-release-${Date.now()}-${process.pid}`;
}

function systemdRunEnvArgs(env) {
  return systemdRunEnvironment(env).map(([key, value]) => `--setenv=${key}=${value}`);
}

function systemdRunEnvironment(env) {
  const entries = new Map();
  for (const key of Object.keys(env || {}).sort()) {
    const value = env[key];
    if (!isSystemdRunEnvKey(key, value)) continue;
    entries.set(key, String(value));
  }
  entries.set("ORKESTR_UPDATE_SYSTEMD_RUN", "0");
  return [...entries.entries()];
}

function isSystemdRunEnvKey(key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (value == null || String(value).includes("\0")) return false;
  if (/^(ORKESTR_DEPLOY_|ORKESTR_RELEASE_|ORKESTR_UPDATE_|ORKESTR_CODEX_APP_SERVER_)/.test(key)) return true;
  return [
    "CI",
    "GIT_SSH_COMMAND",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "NODE_COMPILE_CACHE",
    "NODE_OPTIONS",
    "NO_COLOR",
    "ORKESTR_APP_DIR",
    "ORKESTR_CURRENT_LINK",
    "ORKESTR_ENV_FILE",
    "ORKESTR_HOME",
    "ORKESTR_HOST",
    "ORKESTR_PORT",
    "ORKESTR_SERVICE_NAME",
    "ORKESTR_SERVICE_TIMEOUT_STOP_SEC",
    "PATH",
    "SHELL",
    "SSH_AUTH_SOCK",
    "USER",
  ].includes(key);
}

async function spawnInherited(spawnImpl, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
