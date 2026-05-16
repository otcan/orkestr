import { spawn } from "node:child_process";
import { startServer } from "../../server/src/server.js";
import { defaultApiBase, requestJson } from "./api-client.js";
import { formatThreadTable, threadName } from "./format.js";
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
    if (global.help || command === "help") return writeHelp(ctx);
    if (command === "serve" || command.startsWith("--")) return serve(command.startsWith("--") ? global.argv : args, ctx);
    if (command === "list") return list(args, ctx);
    if (command === "attach") return attach(args, ctx);
    if (command === "send") return send(args, ctx);
    if (command === "wake") return postThreadAction("wake", args, ctx);
    if (command === "sleep") return postThreadAction("sleep", args, ctx);
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
  await startServer({ port, host, openBrowser: argv.includes("--open") });
  return 0;
}

async function list(argv, ctx) {
  const payload = await requestJson("/api/threads/summary", ctx);
  const threads = payload?.threads || [];
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatThreadTable(threads)}\n`);
  return 0;
}

async function attach(argv, ctx) {
  const printOnly = argv.includes("--print");
  const json = argv.includes("--json");
  const targetArg = positional(argv)[0];
  const target = targetArg || threadName(await chooseThread(ctx));
  const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/attach`, {
    ...ctx,
    method: "POST",
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (!payload.ok) throw new Error(payload.message || `Thread is not attachable: ${target}`);
  const sessionName = payload.runtime?.sessionName || parseTmuxSession(payload.attachCommand);
  if (!sessionName) throw new Error("Attach response did not include a tmux session.");
  if (printOnly) {
    ctx.stdout.write(`tmux attach-session -t ${shellToken(sessionName)}\n`);
    return 0;
  }
  return spawnInherited(ctx.spawnImpl, "tmux", ["attach-session", "-t", sessionName]);
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
  else ctx.stdout.write(`${payload.queued ? "Queued" : "Sent"} ${payload.orkestrThreadId || target}\n`);
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
  else ctx.stdout.write(`${action === "wake" ? "Woke" : "Slept"} ${target}\n`);
  return 0;
}

function writeHelp(ctx) {
  writeUsage(ctx.stdout);
  return 0;
}

function writeUsage(stream) {
  stream.write(`Usage:
  orkestr [serve] [--open] [--host 127.0.0.1] [--port 19812]
  orkestr list [--json] [--api http://127.0.0.1:19812]
  orkestr attach [thread-name-or-id] [--print] [--json]
  orkestr send <thread-name-or-id> "<message>" [--json]
  orkestr wake <thread-name-or-id> [--json]
  orkestr sleep <thread-name-or-id> [--json]

Environment:
  ORKESTR_API_BASE   API base URL for commands. Defaults to http://127.0.0.1:19812.
`);
}

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set(["--host", "--port"]);
  const flagsWithoutValues = new Set(["--json", "--print", "--open"]);
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

function parseTmuxSession(command = "") {
  const match = String(command).match(/tmux\s+attach-session\s+-t\s+(.+)$/);
  return match?.[1]?.trim() || "";
}

function shellToken(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function spawnInherited(spawnImpl, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
