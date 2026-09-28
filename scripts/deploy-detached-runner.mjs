#!/usr/bin/env node
// Runs one release deploy inside a transient systemd unit started by
// `orkestr update --detach`, so the deploy outlives the Orkestr service (and
// any agent turn) that requested it. It writes status.json/result.json and a
// log into the deploy directory, and reports the outcome to the requesting
// thread once the restarted service answers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { deployOutcome, formatDeployReport, summarizeDeployLog } from "./deploy-detached-summary.mjs";

function argValue(argv, flag, fallback = "") {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

async function writeJson(filePath, value, owner = null) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  if (owner) await fsp.chown(tmp, owner.uid, owner.gid).catch(() => {});
  await fsp.rename(tmp, filePath);
}

function parseOwner(value = "") {
  const [uid, gid] = String(value).split(":").map(Number);
  return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The API stores the message before it waits for WhatsApp delivery, so a
// delivery timeout or unconfirmed delivery still means the notice was posted.
// Retrying those would post the same report again; only retry when the message
// was not recorded (for example while the service is still restarting).
export function noticeRecorded(exitCode, output = "") {
  if (exitCode === 0) return true;
  return /whatsapp_delivery_timeout|whatsapp_send_not_confirmed|delivery=|pending=true/.test(String(output || ""));
}

// Posts a thread notice through the Orkestr CLI (api-session message). Retries
// while the service restarts; failures only affect the report, not the deploy.
export async function postThreadNotice({ orkestrBin, threadId, deployId, text, phase = "commentary", attempts = 1, delayMs = 5_000, env = process.env, spawnImpl = spawn }) {
  if (!threadId || !text) return { posted: false, reason: "no_thread" };
  const args = [
    "api-session", "message", "--text", text,
    "--api-session-id", `orkestr-deploy-${deployId}`,
    "--thread", threadId,
    "--role", "assistant",
    "--phase", phase,
    "--source", "orkestr-deploy",
    "--json",
  ];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { code, output } = await new Promise((resolve) => {
      let captured = "";
      const child = spawnImpl(orkestrBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const collect = (chunk) => { if (captured.length < 16_384) captured += String(chunk); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", () => resolve({ code: 1, output: captured }));
      child.on("close", (exitCode) => resolve({ code: exitCode ?? 1, output: captured }));
    });
    if (noticeRecorded(code, output)) return { posted: true, attempt, deliveryPending: code !== 0 };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { posted: false, reason: "post_failed" };
}

export async function runDetachedDeploy(argv = process.argv.slice(2), env = process.env) {
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const deployArgs = split >= 0 ? argv.slice(split + 1) : [];
  const deployId = argValue(own, "--deploy-id");
  const dir = argValue(own, "--dir");
  const script = argValue(own, "--script");
  const threadId = argValue(own, "--thread");
  const orkestrBin = argValue(own, "--orkestr-bin", "orkestr");
  const owner = parseOwner(argValue(own, "--owner"));
  if (!deployId || !dir || !script) throw new Error("Usage: deploy-detached-runner.mjs --deploy-id id --dir dir --script deploy-git-release.sh [--thread id] -- install ...");
  const logPath = path.join(dir, "deploy.log");
  const startedAt = new Date().toISOString();
  const base = { deployId, threadId: threadId || null, unit: env.ORKESTR_DETACHED_DEPLOY_UNIT || "", args: deployArgs, logPath, startedAt };
  await writeJson(path.join(dir, "status.json"), { ...base, state: "running" }, owner);

  await postThreadNotice({
    orkestrBin, threadId, deployId, env,
    text: `Deploy ${deployId} started. Orkestr will restart; this thread gets the result when it is back.`,
  });

  const log = fs.openSync(logPath, "a", 0o640);
  if (owner) fs.fchownSync(log, owner.uid, owner.gid);
  const deployEnv = {
    ...env,
    ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE: env.ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE || "75",
    ORKESTR_DEPLOY_IGNORE_THREAD_IDS: [env.ORKESTR_DEPLOY_IGNORE_THREAD_IDS, threadId].filter(Boolean).join(","),
  };
  const exitCode = await new Promise((resolve) => {
    const child = spawn("bash", [script, ...deployArgs], { env: deployEnv, stdio: ["ignore", log, log] });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  fs.closeSync(log);

  const summary = summarizeDeployLog(await fsp.readFile(logPath, "utf8").catch(() => ""));
  const result = { ...base, state: "finished", finishedAt: new Date().toISOString(), exitCode, outcome: deployOutcome(exitCode, summary), summary };
  await writeJson(path.join(dir, "result.json"), result, owner);
  await writeJson(path.join(dir, "status.json"), { ...base, state: "finished", exitCode, outcome: result.outcome, finishedAt: result.finishedAt }, owner);
  // The service may still be settling right after the restart; retry for a
  // few minutes before giving up on the report (the result file stays).
  const report = await postThreadNotice({
    orkestrBin, threadId, deployId, env,
    text: formatDeployReport(result),
    phase: "final_answer",
    attempts: Number(env.ORKESTR_DETACHED_DEPLOY_REPORT_ATTEMPTS || 36),
    delayMs: Number(env.ORKESTR_DETACHED_DEPLOY_REPORT_DELAY_MS || 5_000),
  });
  await writeJson(path.join(dir, "result.json"), { ...result, reportPosted: report.posted }, owner);
  return exitCode;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runDetachedDeploy().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
