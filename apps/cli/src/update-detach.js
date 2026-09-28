// `orkestr update --detach`: run a release deploy in its own transient systemd
// unit so it outlives the Orkestr service restart and the agent turn that asked
// for it, and read the recorded result back with
// `orkestr update status --deploy-id <id>`.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEPLOY_BLOCKED_EXIT_CODE = 75;
const DEPLOY_UNIT_PATTERNS = ["orkestr-deploy-*", "orkestr-release-*"];

export function detachedDeployRoot(env = process.env) {
  return String(env.ORKESTR_DETACHED_DEPLOY_DIR || "").trim() || "/var/tmp/orkestr-deploys";
}

export function newDeployId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function validDeployId(value = "") {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(value));
}

// Active (or starting) deploy units, from systemd. Two deploys must never
// overlap: the deployer's flock covers the install itself, and this check
// refuses to even queue a second detached deploy.
export function activeDeployUnits({ execFile = execFileSync, env = process.env } = {}) {
  if (env.ORKESTR_TEST_ACTIVE_DEPLOY_UNITS !== undefined) {
    return String(env.ORKESTR_TEST_ACTIVE_DEPLOY_UNITS).split(",").map((unit) => unit.trim()).filter(Boolean);
  }
  try {
    const output = execFile("systemctl", ["list-units", "--plain", "--no-legend", "--state=active,activating,reloading", ...DEPLOY_UNIT_PATTERNS], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return String(output).split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

export function detachedDeployCommand({ deployId, dir, script, runner, deployArgs, threadId = "", owner = "", nodePath = process.execPath, envArgs = [], isRoot = false }) {
  const unit = `orkestr-deploy-${deployId}`;
  const systemdArgs = [
    "--collect",
    `--unit=${unit}`,
    `--description=Orkestr detached deploy ${deployId}`,
    ...envArgs,
    `--setenv=ORKESTR_DETACHED_DEPLOY_UNIT=${unit}`,
    nodePath,
    runner,
    "--deploy-id", deployId,
    "--dir", dir,
    "--script", script,
    ...(threadId ? ["--thread", threadId] : []),
    ...(owner ? ["--owner", owner] : []),
    "--",
    ...deployArgs,
  ];
  // The deployer needs root (lock under /var/lock, systemd units, /opt).
  return isRoot
    ? { command: "systemd-run", args: systemdArgs, unit }
    : { command: "sudo", args: ["-n", "systemd-run", ...systemdArgs], unit };
}

export async function resolveCallingThreadId({ argv = [], env = process.env, cwd = process.cwd(), requestJson = null, flagValue }) {
  const explicit = flagValue(argv, "--thread") || flagValue(argv, "--thread-id") || String(env.ORKESTR_THREAD_ID || "").trim();
  if (explicit || argv.includes("--no-thread") || !requestJson) return explicit;
  try {
    const payload = await requestJson(`/api/whereiam?cwd=${encodeURIComponent(cwd)}`, { env, cwd });
    return String(payload?.thread?.id || "").trim();
  } catch {
    return "";
  }
}

export async function launchDetachedDeploy({ argv, deployArgs, script, env, ctx, flagValue, envArgs, requestJson }) {
  const json = argv.includes("--json");
  const running = activeDeployUnits({ env });
  if (running.length) {
    const message = `Refusing detached deploy: another deploy is running (${running.join(", ")}).`;
    if (json) ctx.stdout.write(`${JSON.stringify({ ok: false, error: "deploy_already_running", units: running }, null, 2)}\n`);
    else ctx.stderr.write(`${message}\n`);
    return DEPLOY_BLOCKED_EXIT_CODE;
  }
  const deployId = newDeployId();
  const dir = path.join(detachedDeployRoot(env), deployId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const threadId = await resolveCallingThreadId({ argv, env, cwd: ctx.cwd || process.cwd(), requestJson, flagValue });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const launch = detachedDeployCommand({
    deployId,
    dir,
    script,
    runner: path.join(path.dirname(script), "deploy-detached-runner.mjs"),
    deployArgs,
    threadId,
    owner: `${uid}:${gid}`,
    envArgs,
    isRoot: uid === 0,
  });
  const code = await new Promise((resolve, reject) => {
    const child = ctx.spawnImpl(launch.command, launch.args, { stdio: json ? "ignore" : "inherit", env });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });
  const payload = { ok: code === 0, deployId, unit: launch.unit, dir, logPath: path.join(dir, "deploy.log"), threadId: threadId || null };
  if (code !== 0) {
    if (json) ctx.stdout.write(`${JSON.stringify({ ...payload, error: "systemd_run_failed", exitCode: code }, null, 2)}\n`);
    else ctx.stderr.write(`Could not start the detached deploy unit (exit ${code}).\n`);
    return code;
  }
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    ctx.stdout.write(`Detached deploy ${deployId} started in ${launch.unit}.\n`);
    ctx.stdout.write(`Log: ${payload.logPath}\n`);
    ctx.stdout.write(`Result: orkestr update status --deploy-id ${deployId}\n`);
    if (threadId) ctx.stdout.write(`The result will also be posted to thread ${threadId}.\n`);
  }
  return 0;
}

export function readDetachedDeploy(deployId, env = process.env) {
  if (!validDeployId(deployId)) return { found: false, error: "invalid_deploy_id" };
  const dir = path.join(detachedDeployRoot(env), deployId);
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return null; }
  };
  const result = read("result.json");
  if (result) return { found: true, ...result };
  const status = read("status.json");
  if (status) return { found: true, ...status };
  return fs.existsSync(dir) ? { found: true, deployId, state: "starting" } : { found: false, deployId, error: "deploy_not_found" };
}

export function detachedDeployStatusCommand(deployId, argv, ctx, formatReport) {
  const record = readDetachedDeploy(deployId, ctx.env);
  if (argv.includes("--json")) {
    ctx.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else if (!record.found) {
    ctx.stderr.write(`Deploy ${deployId} not found.\n`);
  } else if (record.state === "finished") {
    ctx.stdout.write(`${formatReport(record)}\n`);
  } else {
    ctx.stdout.write(`Deploy ${deployId}: ${record.state}${record.unit ? ` (${record.unit})` : ""}${record.logPath ? `\nLog: ${record.logPath}` : ""}\n`);
  }
  if (!record.found) return 1;
  if (record.state !== "finished") return 0;
  return record.outcome === "success" ? 0 : (record.exitCode || 1);
}
