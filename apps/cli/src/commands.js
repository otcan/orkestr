import { spawn } from "node:child_process";
import path from "node:path";
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
import { defaultApiBase, requestJson } from "./api-client.js";
import { createCommand } from "./create-command.js";
import { desktopCommand } from "./desktop-command.js";
import { formatRuntimeResources, formatSystemDoctor, formatThreadTable, formatTimerDoctor, formatTimerTable, threadName } from "./format.js";
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
    if (command === "whereiam" || command === "whereami") return await whereiamCommand(args, ctx);
    if (command === "settings") return await settingsCommand(args, ctx);
    if (command === "doctor") return await doctorCommand(args, ctx);
    if (command === "whatsapp" || command === "wa") return await whatsappCommand(args, ctx);
    if (command === "timers" || command === "timer") return await timersCommand(args, ctx);
    if (command === "security") return await securityCommand(args, ctx);
    if (command === "desktop" || command === "desktops") return await desktopCommand(args, ctx);
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
      const forceExit = setTimeout(() => resolve(0), 10_000);
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
  throw new Error("Usage: orkestr doctor [system|timers|resources] [--repair] [--json]");
}

async function timersCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "list") return listTimersCommand(rest, ctx);
  if (subcommand === "doctor") return doctorTimersCommand(rest, ctx);
  if (subcommand === "run") return runTimerCommand(rest, ctx);
  throw new Error("Usage: orkestr timers [list|doctor|run <timer-id>] [--json]");
}

async function whatsappCommand(argv, ctx) {
  const subcommand = argv[0] || "";
  const rest = argv.slice(1);
  if (subcommand === "bind-thread" || subcommand === "thread-group") return whatsappBindThreadCommand(rest, ctx);
  throw new Error("Usage: orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--sender-account id] [--outbound-account id] [--force-new] [--json]");
}

async function whatsappBindThreadCommand(argv, ctx) {
  const json = argv.includes("--json");
  const threadId = positional(argv)[0];
  const name = flagValue(argv, "--name") || flagValue(argv, "--wa-title") || flagValue(argv, "--title");
  if (!threadId || !name) {
    throw new Error("Usage: orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--sender-account id] [--outbound-account id] [--force-new] [--json]");
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
  const senderAccountId = flagValue(argv, "--sender-account") || flagValue(argv, "--inbound-account");
  const responderAccountId = flagValue(argv, "--outbound-account") || flagValue(argv, "--responder-account");
  const replyPrefix = flagValue(argv, "--reply-prefix");
  if (senderAccountId) body.senderAccountId = senderAccountId;
  if (responderAccountId) {
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
    throw new Error("Usage: orkestr update [--track-main|--ref ref] [--release|--in-place] [--channel name] [--allow-untagged|--require-tagged] [--no-smoke] [--wait-active] [--active-timeout seconds|--allow-interrupt]\n       orkestr update status [--json]\n       orkestr update rollback [--to release-id]");
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
        ...deployGuardArgs(argv),
        ...(checkOnly ? ["--check-only"] : []),
      ]
    : [...(checkOnly ? ["--check-only"] : [])];
  const label = release && !inPlace ? "versioned release update" : "in-place update";
  if (!argv.includes("--json")) ctx.stdout.write(`Starting Orkestr ${label}${ref ? ` for ${ref}` : ""}...\n`);
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
  else {
    const label = action === "wake"
      ? "Woke"
      : action === "sleep"
        ? "Slept legacy tmux runtime"
        : action === "hard-reset"
          ? "Hard reset"
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
  orkestr service [status|start|stop|restart|logs] [--service orkestr] [--lines 100] [--no-follow]
  orkestr start|stop|restart
  orkestr update
  orkestr rollback [--to release-id]
  orkestr logs [--service orkestr] [--lines 100] [--no-follow]
  orkestr doctor [system|timers|resources] [--repair] [--json]

Common thread commands:
  orkestr list [--json] [--api http://127.0.0.1:19812]
  orkestr create <name> [--wa-participant jid]... [--no-wa] [--json]
  orkestr whereiam [--cwd path] [--json]
  orkestr attach [thread-name-or-id] [--print] [--json]
  orkestr send <thread-name-or-id> "<message>" [--json]
  orkestr wake <thread-name-or-id> [--json]
  orkestr reset <thread-name-or-id> [--json]
  orkestr hard-reset <thread-name-or-id> [--json]

Advanced:
  orkestr update [--track-main|--ref ref] [--release|--in-place] [--channel name] [--allow-untagged|--require-tagged] [--no-smoke] [--wait-active] [--active-timeout seconds|--allow-interrupt]
  orkestr update status [--json]
  orkestr update rollback [--to release-id]
  orkestr settings [--json]
  orkestr codex [status|migrate] [--dry-run] [--json]
  orkestr whatsapp bind-thread <thread> --name <group name> [--wa-participant jid]... [--json]
  orkestr timers [list|doctor|run <timer-id>] [--json]
  orkestr security [challenges|sessions|approve <challenge-id>|reject <challenge-id>|revoke <session-id|all>] [--json]
  orkestr desktop [share [slug]|approve <challenge-id>] [--json]
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
  const release = version.releaseId || version.describe || shortCommit(version.commit) || "-";
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
  const release = version.releaseId || version.describe || shortCommit(version.commit) || "-";
  return [
    `Orkestr: ${[version.name || "orkestr", version.version || ""].filter(Boolean).join(" ")}`,
    `Release: ${release}`,
    `Commit: ${shortCommit(version.commit) || "-"}${version.dirty ? " dirty" : ""}`,
    `Ref: ${version.tag || version.branch || version.describe || "-"}`,
    `Channel: ${version.channel || "-"}`,
    `Deployed: ${version.deployedAt || "-"}`,
  ].join("\n");
}

function shortCommit(value) {
  const text = String(value || "");
  return text.length > 12 ? text.slice(0, 12) : text;
}

function formatSettings(settings = {}) {
  const codex = settings.codex || {};
  const desktops = settings.desktops || {};
  const connectors = settings.connectors || {};
  return [
    `Codex: sandbox=${codex.sandbox || "-"} approval=${codex.approvalPolicy || "-"} yolo=${codex.bypassApprovalsAndSandbox ? "yes" : "no"}`,
    `Desktops: mode=${desktops.mode || "-"} default=${desktops.default || "-"} gmail=${desktops.gmailAuth || "-"} manual=${desktops.manualIntervention || "-"}`,
    `WhatsApp: ${connectors.whatsapp?.bridgeMode || "-"} sender=${connectors.whatsapp?.senderRole || "sender"} responder=${connectors.whatsapp?.responderRole || "responder"}`,
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
    "--cmd",
    "--command",
    "--cwd",
    "--executor",
    "--host",
    "--id",
    "--label",
    "--name",
    "--port",
    "--repo",
    "--repo-path",
    "--reply-prefix",
    "--responder-account",
    "--service",
    "--sender-account",
    "--task",
    "--title",
    "--ref",
    "--channel",
    "--lines",
    "--to",
    "--active-timeout",
    "--wa-admin",
    "--admin-participant",
    "--wa-participant",
    "--participant",
    "--wa-title",
    "--outbound-account",
    "--inbound-account",
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
    "--no-follow",
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

async function spawnInherited(spawnImpl, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
