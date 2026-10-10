import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { decideEffectApproval, listEffects } from "../../../packages/core/src/effect-ledger.js";
import { demoJob, demoJobReport } from "../../../packages/core/src/simulated-demo-job.js";
import { closeThreadRegistryCache } from "../../../packages/storage/src/thread-registry.js";

const workerPath = fileURLToPath(new URL("./demo-job-worker.js", import.meta.url));

export const demoUsage = "  orkestr demo [--yes] [--no-crash] [--keep] [--json]   (simulation with a simulated AI; no account needed)";

// Owner decision (2026-10-10): `orkestr demo` is an explicitly labelled
// simulation for newcomers. It runs in a throwaway ORKESTR_HOME on the
// thread-level simulated executor and never creates or runs user Agent Jobs;
// the simulated provider stays unselectable in user job specs.
export const demoBanner = [
  "SIMULATION - this demo uses a simulated AI, not a real model.",
  "No account, credentials or network are used, and no real job is created.",
  "Real Agent Jobs need a connected provider: `orkestr init` after `codex login` or `claude auth login`.",
];

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

async function askApproval(effect, ctx) {
  const input = ctx.stdin;
  if (!input?.isTTY) return false;
  const rl = readline.createInterface({ input, output: ctx.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`  Approve ${effect.kind} ${JSON.stringify(effect.payload)}? [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

// Watch the ledger while the job runs and answer approval requests.
function startApprovalWatcher(env, options, ctx, say) {
  let stopped = false;
  const handled = new Set();
  const done = (async () => {
    while (!stopped) {
      const pending = await listEffects({ jobId: demoJob.id, approvalState: "pending" }, env).catch(() => []);
      for (const effect of pending) {
        if (handled.has(effect.key)) continue;
        handled.add(effect.key);
        say(`approval requested: ${effect.kind} (${effect.key})`);
        const approved = options.yes || await askApproval(effect, ctx);
        await decideEffectApproval(effect.key, {
          decision: approved ? "approved" : "denied",
          decidedBy: options.yes ? "demo:--yes" : "demo:operator",
        }, env);
        say(approved ? "approved" : "denied (run with --yes to auto-approve in non-interactive shells)");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return async () => { stopped = true; await done; };
}

function formatAuditEvent(event) {
  const detail = [event.step, event.tool, event.effectStatus, event.effectKind, event.state, event.crashPoint, event.error]
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
    if (!options.json) ctx.stdout.write(`${demoBanner.join("\n")}\n\n`);
    say(`isolated ORKESTR_HOME ${home} (no credentials, no network)`);
    say(`job ${demoJob.id}: trigger=${demoJob.trigger.type} provider=${demoJob.agent.provider} maxAttempts=${demoJob.runtime.maxAttempts}`);
    const stopWatcher = startApprovalWatcher(env, options, ctx, say);
    try {
      for (let index = 0; index < demoJob.runtime.maxAttempts; index += 1) {
        say(`attempt ${index + 1}: running`);
        const attempt = await runAttempt(env, { crash: options.crash });
        attempts.push(attempt);
        if (attempt.signal || attempt.code !== 0) {
          say(`attempt ${index + 1}: process died (${attempt.signal || `exit ${attempt.code}`})${attempt.stderr ? `: ${attempt.stderr}` : ""}`);
          if (attempt.code !== 0 && !attempt.signal) break;
          say("recovering from durable state");
          continue;
        }
        say(`attempt ${index + 1}: ${attempt.result?.state || "unknown"} - ${attempt.result?.result?.output || ""}`.trim());
        break;
      }
    } finally {
      await stopWatcher();
    }
    report = await demoJobReport(env);
    if (!options.crash) {
      report.checks = report.checks.filter((check) => !["crash_injected", "open_effect_reconciled_after_crash"].includes(check.name));
      report.ok = report.checks.every((check) => check.ok);
    }
  } finally {
    await closeThreadRegistryCache(env).catch(() => {});
    if (!options.keep) await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  if (options.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: report.ok, simulation: true, provider: "simulated", notice: demoBanner.join(" "), home: options.keep ? home : null, log: lines, attempts, ...report }, null, 2)}\n`);
  } else {
    ctx.stdout.write("\nAudit trail:\n");
    for (const event of report.audit) ctx.stdout.write(`${formatAuditEvent(event)}\n`);
    ctx.stdout.write("\nGuarantees:\n");
    for (const check of report.checks) ctx.stdout.write(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}\n`);
    const denied = report.effects.some((effect) => effect.outcome === "denied");
    ctx.stdout.write(report.ok
      ? `\nSimulation passed: ${options.crash ? "the simulated job survived a crash without duplicating its pull request" : "the simulated job completed"}. No real AI or account was used.\n`
      : `\nSimulation FAILED: ${denied ? "the approval was denied, so the job did not complete" : "a durability guarantee was violated"}.\n`);
    if (options.keep) ctx.stdout.write(`State kept in ${home}\n`);
  }
  return report.ok ? 0 : 1;
}
