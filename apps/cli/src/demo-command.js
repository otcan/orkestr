import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { decideApproval, listApprovals } from "../../../packages/core/src/agent-job-ledger.js";
import { closeAgentJobDbs } from "../../../packages/core/src/agent-job-store.js";
import { demoJobReport, demoRun, loadDemoJob } from "../../../packages/core/src/simulated-demo-job.js";

const workerPath = fileURLToPath(new URL("./demo-job-worker.js", import.meta.url));

export const demoUsage = "  orkestr demo [--yes] [--no-crash] [--keep] [--json]";

function parseDemoArgs(args = []) {
  const options = { yes: false, crash: true, keep: false, json: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--no-crash") options.crash = false;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown demo option: ${arg}\nUsage:\n${demoUsage}`);
  }
  return options;
}

// Only pass what node needs. The demo must never see real provider keys,
// connector tokens or the operator's ORKESTR_HOME.
function isolatedEnv(home, parentEnv) {
  const env = { ORKESTR_HOME: home, PATH: parentEnv.PATH || "", TMPDIR: parentEnv.TMPDIR || os.tmpdir(), NODE_ENV: "production" };
  for (const key of ["NODE_TEST_CONTEXT", "NODE_OPTIONS"]) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  return env;
}

function runAttempt(env, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", workerPath, JSON.stringify(options)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      let result = null;
      try { result = JSON.parse(stdout.trim().split("\n").pop() || "null"); } catch { result = null; }
      resolve({ code, signal, result, stderr: stderr.trim() });
    });
  });
}

async function askApproval(approval, ctx) {
  const input = ctx.stdin;
  if (!input?.isTTY) return false;
  const rl = readline.createInterface({ input, output: ctx.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`  Approve ${approval.tool} ${JSON.stringify(approval.args)}? [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

// Answer the run's pending approvals (the run is parked, not running).
async function answerApprovals(env, options, ctx, say) {
  const run = await demoRun(env);
  const pending = run ? await listApprovals({ runId: run.id, state: "pending" }, env) : [];
  for (const approval of pending) {
    say(`approval requested: ${approval.tool} (${approval.approvalId})`);
    const approved = options.yes || await askApproval(approval, ctx);
    await decideApproval(approval.approvalId, { decision: approved ? "approved" : "denied", by: options.yes ? "demo:--yes" : "demo:operator" }, env);
    say(approved ? "approved" : "denied (run with --yes to auto-approve in non-interactive shells)");
  }
  return pending.length;
}

function formatAuditEvent(event) {
  const detail = [event.tool, event.decision, event.state, event.outcome, event.reason, event.crashPoint]
    .filter(Boolean).join(" ");
  const attempt = event.attempt ? ` attempt=${event.attempt}` : "";
  return `  ${String(event.ts || "").slice(11, 23)}  ${event.type}${attempt}${detail ? `  ${detail}` : ""}`;
}

export async function demoCommand(args, ctx) {
  const options = parseDemoArgs(args);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-"));
  const env = isolatedEnv(home, ctx.env || process.env);
  const lines = [];
  const say = (text) => {
    lines.push(text);
    if (!options.json) ctx.stdout.write(`- ${text}\n`);
  };
  const attempts = [];
  let report = null;
  try {
    const job = await loadDemoJob();
    say(`isolated ORKESTR_HOME ${home} (no credentials, no network)`);
    say(`job ${job.metadata.name}: trigger=api provider=${job.agent.provider} maxAttempts=${job.runtime.maxAttempts}`);
    // Each worker is one process lifetime. Process deaths and approval waits
    // are bounded so a broken run cannot loop forever.
    for (let index = 0; index < job.runtime.maxAttempts + 4; index += 1) {
      say(`process ${index + 1}: running`);
      const attempt = await runAttempt(env, { crash: options.crash });
      attempts.push(attempt);
      if (attempt.signal || attempt.code !== 0) {
        say(`process ${index + 1}: died (${attempt.signal || `exit ${attempt.code}`})${attempt.stderr ? `: ${attempt.stderr}` : ""}`);
        if (!attempt.signal) break;
        say("recovering from durable state");
        continue;
      }
      const state = attempt.result?.state || "unknown";
      say(`process ${index + 1}: run ${state}${attempt.result?.reason ? ` (${attempt.result.reason})` : ""}`);
      if (state !== "awaiting_approval") break;
      if (!(await answerApprovals(env, options, ctx, say))) break;
    }
    report = await demoJobReport(env);
    if (!options.crash) {
      report.checks = report.checks.filter((check) => !["crash_injected", "open_effect_reconciled_after_crash"].includes(check.name));
      report.ok = report.checks.every((check) => check.ok);
    }
  } finally {
    await closeAgentJobDbs().catch(() => {});
    if (!options.keep) await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  if (options.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: report.ok, home: options.keep ? home : null, log: lines, attempts, ...report }, null, 2)}\n`);
  } else {
    ctx.stdout.write("\nAudit trail:\n");
    for (const event of report.audit) ctx.stdout.write(`${formatAuditEvent(event)}\n`);
    ctx.stdout.write("\nGuarantees:\n");
    for (const check of report.checks) ctx.stdout.write(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}\n`);
    const denied = report.approvals?.some((approval) => approval.state === "denied");
    ctx.stdout.write(report.ok
      ? `\nDemo passed: ${options.crash ? "the job survived a crash without duplicating its pull request" : "the job completed"}.\n`
      : `\nDemo FAILED: ${denied ? "the approval was denied, so the job did not complete" : "a durability guarantee was violated"}.\n`);
    if (options.keep) ctx.stdout.write(`State kept in ${home}\n`);
  }
  return report.ok ? 0 : 1;
}
