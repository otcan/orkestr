import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { admitRun } from "./agent-job-admission.js";
import { getRunAudit } from "./agent-job-audit.js";
import { listApprovals, listRunEffects } from "./agent-job-ledger.js";
import { driveRun } from "./agent-job-runner.js";
import { loadAgentJobYaml } from "./agent-job-spec-yaml.js";
import { getRun, listAttemptsSync, listCheckpoints, listRuns, openAgentJobDb } from "./agent-job-store.js";
import { listSimulatedPullRequests } from "./simulated-pr-sink.js";

// The `orkestr demo` job: examples/jobs/simulated-demo.yaml run by the real
// Agent Job runner on the simulated provider. Each runDemoJobAttempt() call is
// one process lifetime; the injected fault SIGKILLs the process right after
// the pull request was opened but before the effect was committed, and the
// next call recovers, reconciles and resumes the same run.

export const demoJobPath = fileURLToPath(new URL("../../../examples/jobs/simulated-demo.yaml", import.meta.url));
export const demoEventId = "evt-demo-0001";
const crashFault = { at: "effect_performed", tool: "demo.pull_request.create", attempts: [1], mode: "exit" };

export async function loadDemoJob() {
  return loadAgentJobYaml(await fs.readFile(demoJobPath, "utf8"));
}

export async function runDemoJobAttempt({ crash = true } = {}, env = process.env) {
  const spec = await loadDemoJob();
  const { run } = await admitRun({ spec, type: "api", dedupeKey: demoEventId, source: demoJobPath }, env);
  const result = await driveRun(run.id, { faults: crash ? [crashFault] : [] }, env);
  return { ...result, job: spec.metadata.name };
}

export async function demoRun(env = process.env) {
  const spec = await loadDemoJob();
  return (await listRuns({ job: spec.metadata.name, limit: 1 }, env))[0] || null;
}

export async function demoJobReport(env = process.env) {
  const run = await demoRun(env);
  if (!run) return { ok: false, checks: [{ name: "run_admitted", ok: false }], effects: [], pullRequests: [], attempts: [], audit: [] };
  const db = await openAgentJobDb(env);
  const [effects, approvals, journal, pullRequests, current, sealed] = await Promise.all([
    listRunEffects(run.id, env),
    listApprovals({ runId: run.id }, env),
    listCheckpoints(run.id, env),
    listSimulatedPullRequests(env),
    getRun(run.id, env),
    getRunAudit(run.id, env),
  ]);
  const attempts = listAttemptsSync(db, run.id);
  const openEffect = effects.find((effect) => effect.tool === "demo.pull_request.create");
  const mergeApproval = approvals.find((approval) => approval.tool === "demo.pull_request.merge");
  const jobPullRequests = pullRequests.filter((pr) => pr.idempotencyKey === openEffect?.effectKey);
  const checks = [
    ["crash_injected", attempts.some((attempt) => attempt.endReason === "interrupted")],
    ["single_pull_request", jobPullRequests.length === 1],
    ["open_effect_reconciled_after_crash", openEffect?.state === "committed" && openEffect?.reconciled === true],
    ["merge_approved_before_effect", mergeApproval?.state === "approved" && Boolean(mergeApproval?.consumedAt)],
    ["merged_exactly_once", jobPullRequests[0]?.state === "merged" && jobPullRequests[0]?.merges === 1],
    ["run_succeeded", current?.state === "succeeded"],
    ["audit_sealed", Boolean(current?.sealed && sealed?.sealed_at)],
  ].map(([name, ok]) => ({ name, ok: Boolean(ok) }));
  return {
    ok: checks.every((check) => check.ok),
    runId: run.id,
    state: current?.state || null,
    checks,
    effects,
    approvals,
    pullRequests: jobPullRequests,
    runAttempts: attempts,
    audit: journal.map((entry) => ({ ts: entry.at, type: entry.kind, attempt: entry.attempt, ...pick(entry.data) })),
  };
}

function pick(data = {}) {
  const { tool, state, outcome, decision, reason, at } = data;
  return Object.fromEntries(Object.entries({ tool, state, outcome, decision, reason, crashPoint: at }).filter(([, value]) => value !== undefined && value !== null));
}
