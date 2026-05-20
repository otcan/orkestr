import { spawn } from "node:child_process";
import { startServer } from "../../server/src/server.js";
import { approvePairingChallenge, listPairingChallenges, rejectPairingChallenge } from "../../../packages/core/src/security.js";
import { defaultApiBase, requestJson } from "./api-client.js";
import { formatSystemDoctor, formatThreadTable, formatTimerDoctor, formatTimerTable, threadName } from "./format.js";
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
    if (command === "whereiam" || command === "whereami") return whereiamCommand(args, ctx);
    if (command === "doctor") return doctorCommand(args, ctx);
    if (command === "timers" || command === "timer") return timersCommand(args, ctx);
    if (command === "security") return securityCommand(args, ctx);
    if (command === "thread") return threadCommand(args, ctx);
    if (command === "worker") return workerCommand(args, ctx);
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

async function whereiamCommand(argv, ctx) {
  const json = argv.includes("--json");
  const cwd = flagValue(argv, "--cwd") || ctx.cwd || process.cwd();
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  const payload = await requestJson(`/api/whereiam?${params.toString()}`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${formatWhereAmI(payload)}\n`);
  return payload?.ok === false ? 1 : 0;
}

async function doctorCommand(argv, ctx) {
  const subject = positional(argv)[0] || "system";
  if (subject === "system" || subject === "host") return doctorSystemCommand(argv, ctx);
  if (subject === "timers" || subject === "timer") return doctorTimersCommand(argv, ctx);
  throw new Error("Usage: orkestr doctor [system|timers] [--json]");
}

async function timersCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "list") return listTimersCommand(rest, ctx);
  if (subcommand === "doctor") return doctorTimersCommand(rest, ctx);
  if (subcommand === "run") return runTimerCommand(rest, ctx);
  throw new Error("Usage: orkestr timers [list|doctor|run <timer-id>] [--json]");
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

async function securityCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "challenges" : argv[0] || "challenges";
  const rest = subcommand === "challenges" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "challenges" || subcommand === "list") return listSecurityChallenges(rest, ctx);
  if (subcommand === "approve") return approveSecurityChallenge(rest, ctx);
  if (subcommand === "reject") return rejectSecurityChallenge(rest, ctx);
  throw new Error("Usage: orkestr security [challenges|approve <challenge-id>|reject <challenge-id>] [--json]");
}

async function listSecurityChallenges(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await listPairingChallenges({ env: ctx.env });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatSecurityChallengeTable(payload.challenges || []));
  return 0;
}

async function approveSecurityChallenge(argv, ctx) {
  const json = argv.includes("--json");
  const challengeId = positional(argv)[0];
  if (!challengeId) throw new Error("Usage: orkestr security approve <challenge-id> [--json]");
  const payload = await approvePairingChallenge(challengeId, { env: ctx.env, approvedBy: "cli" });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Approved pairing challenge ${payload.challenge.id}\n`);
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
  orkestr whereiam [--cwd path] [--json]
  orkestr doctor [system|timers] [--json]
  orkestr timers [list|doctor|run <timer-id>] [--json]
  orkestr security [challenges|approve <challenge-id>|reject <challenge-id>] [--json]
  orkestr thread create <name> [--id id] [--cwd path] [--command command] [--executor id] [--json]
  orkestr worker create <parent-thread> [task text] [--task text] [--blank] [--label label] [--repo path] [--branch branch] [--no-wake] [--json]
  orkestr attach [thread-name-or-id] [--print] [--json]
  orkestr send <thread-name-or-id> "<message>" [--json]
  orkestr wake <thread-name-or-id> [--json]
  orkestr sleep <thread-name-or-id> [--json]

Environment:
  ORKESTR_API_BASE   API base URL for commands. Defaults to http://127.0.0.1:19812.
`);
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
  return [
    `Thread: ${thread.displayName || thread.name || thread.id} (${thread.id})`,
    `State: ${thread.state || runtime.state || "unknown"}`,
    `CWD: ${workspace.cwd || payload.cwd || "-"}`,
    `Runtime workspace: ${workspace.runtimeWorkspace || "-"}`,
    `Repo: ${workspace.repoPath || workspace.worktreePath || "-"}`,
    `Runtime: ${runtime.sessionName || "-"}${runtime.paneId ? ` ${runtime.paneId}` : ""}`,
  ].join("\n");
}

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set([
    "--branch",
    "--branch-name",
    "--cmd",
    "--command",
    "--cwd",
    "--executor",
    "--host",
    "--id",
    "--label",
    "--port",
    "--repo",
    "--repo-path",
    "--task",
  ]);
  const flagsWithoutValues = new Set(["--blank", "--json", "--no-wake", "--print", "--open"]);
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
