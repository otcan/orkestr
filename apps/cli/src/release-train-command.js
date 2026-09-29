// `orkestr release-train`: the common single-ref release, automated.
//   check          build + test:ci + dependency advisories in a fresh worktree
//   ci             required GitHub checks for the exact commit (ORK-519 verifier)
//   deploy         detached versioned deploy, only after check + ci passed
//   sync-branches  fast-forward and push clean worktree branches after release
//   run            check -> ci --wait -> deploy for a ref already on origin
// All process, network and systemd access is injectable through `deps`.
import { summarizeActiveThreadsWithOptions } from "../../../scripts/deploy-active-work-check.mjs";
import { githubTokenFromEnv } from "../../../scripts/release-provenance/github-api.mjs";
import { loadReleasePolicy, verifyRequiredChecks } from "../../../scripts/release-provenance/verify.mjs";
import { formatSyncBranches, syncBranches } from "./release-train-branches.js";
import { runReleaseCheck } from "./release-train-check.js";
import {
  createExec, createGit, isFullSha, onOrigin, originRepository, readShaRecord, releaseTrainStateDir, repoRootFrom, resolveRef, writeShaRecord,
} from "./release-train-support.js";
import { activeDeployUnits as defaultActiveDeployUnits, DEPLOY_BLOCKED_EXIT_CODE, launchDetachedDeploy as defaultLaunchDetachedDeploy } from "./update-detach.js";

export const RELEASE_TRAIN_USAGE = `Usage:
  orkestr release-train check [--ref main] [--repo path] [--json]
  orkestr release-train ci --sha <sha> [--wait] [--timeout-min 30] [--json]
  orkestr release-train deploy --sha <sha> [--channel main] [--thread id|--no-thread] [--json]
  orkestr release-train sync-branches --sha <sha> [--path-prefix p] [--dry-run] [--json]
  orkestr release-train run [--ref main] [--thread id|--no-thread] [--json]`;

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function setup(argv, ctx, deps) {
  const env = ctx.env || process.env;
  const exec = deps.exec || createExec({ spawnImpl: ctx.spawnImpl });
  return {
    env,
    exec,
    json: argv.includes("--json"),
    stateDir: releaseTrainStateDir(env),
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    out: (text) => ctx.stdout.write(`${text}\n`),
    err: (text) => ctx.stderr.write(`${text}\n`),
  };
}

async function repoGit(argv, ctx, env) {
  const root = await repoRootFrom(env.exec, flag(argv, "--repo") || ctx.cwd || process.cwd());
  return { root, git: createGit(env.exec, root) };
}

function requireSha(argv) {
  const sha = flag(argv, "--sha");
  if (!isFullSha(sha)) throw new Error("--sha must be a full 40-character commit sha.");
  return sha;
}

function emit(env, payload, text) {
  if (env.json) env.out(JSON.stringify(payload, null, 2));
  else env.out(text);
}

export async function checkStep(argv, ctx, deps, env, { git, sha }) {
  if (!env.json) env.err(`Release check for ${sha.slice(0, 12)} in a fresh worktree...`);
  const result = await (deps.runReleaseCheck || runReleaseCheck)({ git, exec: env.exec, sha, env: env.env, stateDir: env.stateDir, now: env.now, onStep: (name) => { if (!env.json) env.err(`  - ${name}`); } });
  const record = writeShaRecord(env.stateDir, sha, { check: { ok: result.ok, at: result.finishedAt, steps: result.steps, failedStep: result.failedStep || null, dependencyAdvisories: result.dependencyAdvisories || null, logFile: result.logFile } });
  return { result, record };
}

async function checkCommand(argv, ctx, deps, env) {
  const { git } = await repoGit(argv, ctx, env);
  await git(["fetch", "--quiet", "origin"], { allowFailure: true });
  const ref = flag(argv, "--ref") || "main";
  const sha = await resolveRef(git, ref);
  const { result } = await checkStep(argv, ctx, deps, env, { git, sha });
  emit(env, { ok: result.ok, sha, ref, ...result }, result.ok
    ? `Release check passed for ${sha} (${ref}).`
    : `Release check FAILED for ${sha} at step "${result.failedStep}".\n${result.output || ""}\nLog: ${result.logFile}`);
  return result.ok ? 0 : 1;
}

export async function ciStep(argv, ctx, deps, env, { git, sha, wait, timeoutMin }) {
  const repository = await originRepository(git, env.env);
  if (!repository) throw new Error("origin is not a GitHub repository; set ORKESTR_DEPLOY_PROVENANCE_REPO=owner/repo.");
  const policy = await loadReleasePolicy();
  const verify = deps.verifyRequiredChecks || verifyRequiredChecks;
  const deadline = env.now() + timeoutMin * 60_000;
  const pollMs = Number(env.env.ORKESTR_RELEASE_TRAIN_POLL_MS) || 30_000;
  let result;
  for (;;) {
    result = await verify({ owner: repository.owner, repo: repository.repo, sha, policy, fetchImpl: ctx.fetchImpl, token: githubTokenFromEnv(env.env), apiBase: env.env.ORKESTR_GITHUB_API_URL });
    const waiting = result.status === "pending" || (result.status === "failed" && result.reasons.every((reason) => ["required_checks_missing", "required_check_shards_missing", "required_checks_pending"].includes(reason)) && !result.failed.length);
    if (!wait || !waiting || env.now() >= deadline) break;
    if (!env.json) env.err(`CI pending for ${sha.slice(0, 12)}: ${[...result.pending, ...result.missing].join(", ") || "waiting for checks"}`);
    await env.sleep(pollMs);
  }
  const record = writeShaRecord(env.stateDir, sha, { ci: { ok: result.ok, at: new Date(env.now()).toISOString(), status: result.status, reasons: result.reasons, runId: result.runId || null, runUrl: result.runUrl || null, checks: (result.checks || []).map(({ name, conclusion, status }) => ({ name, status, conclusion })) } });
  return { result, record };
}

function describeCi(result, sha) {
  if (result.ok) return `CI passed for ${sha}: ${result.checks.length} required checks succeeded${result.runUrl ? ` (${result.runUrl})` : ""}.`;
  const parts = [
    result.missing?.length ? `missing ${result.missing.join(", ")}` : "",
    result.failed?.length ? `failed ${result.failed.map((row) => `${row.name}=${row.conclusion}`).join(", ")}` : "",
    result.pending?.length ? `pending ${result.pending.join(", ")}` : "",
    result.error ? `error ${result.error}` : "",
  ].filter(Boolean);
  return `CI not green for ${sha} (${result.status}; ${result.reasons.join(", ")})${parts.length ? `: ${parts.join("; ")}` : ""}${result.runUrl ? `\n${result.runUrl}` : ""}`;
}

async function ciCommand(argv, ctx, deps, env) {
  const sha = requireSha(argv);
  const { git } = await repoGit(argv, ctx, env);
  const { result } = await ciStep(argv, ctx, deps, env, { git, sha, wait: argv.includes("--wait"), timeoutMin: Number(flag(argv, "--timeout-min")) || 30 });
  emit(env, { ok: result.ok, sha, ...result }, describeCi(result, sha));
  return result.ok ? 0 : 1;
}

// Pre-deploy guard: recorded check + ci success, no deploy unit running, and
// no active thread that would be interrupted by the service restart.
export async function deployPreflight({ sha, env, deps, ctx, threadId }) {
  const record = readShaRecord(env.stateDir, sha);
  const problems = [];
  if (!record?.check?.ok) problems.push(`no recorded passing release check for ${sha} (run: orkestr release-train check)`);
  if (!record?.ci?.ok) problems.push(`no recorded green CI for ${sha} (run: orkestr release-train ci --sha ${sha} --wait)`);
  const units = (deps.activeDeployUnits || defaultActiveDeployUnits)({ env: env.env });
  if (units.length) problems.push(`another deploy is running (${units.join(", ")})`);
  let unsafe = [];
  try {
    const payload = await deps.requestJson("/api/threads?scope=all", { ...ctx, env: env.env, timeoutMs: 10_000 });
    const ignoreEnv = { ...env.env, ORKESTR_DEPLOY_IGNORE_THREAD_IDS: `${env.env.ORKESTR_DEPLOY_IGNORE_THREAD_IDS || ""} ${threadId || ""}` };
    unsafe = summarizeActiveThreadsWithOptions(payload, { env: ignoreEnv }).filter((thread) => !thread.restartSafe);
  } catch (error) {
    problems.push(`active-work report unavailable (${error?.message || error})`);
  }
  if (unsafe.length) problems.push(`active threads are not restart-safe: ${unsafe.map((thread) => thread.name || thread.id).join(", ")}`);
  return { ok: problems.length === 0, problems, unsafe, units, record };
}

export async function deployStep(argv, ctx, deps, env, { sha }) {
  const threadId = flag(argv, "--thread") || flag(argv, "--thread-id") || String(env.env.ORKESTR_THREAD_ID || "").trim();
  const preflight = await deployPreflight({ sha, env, deps, ctx, threadId });
  if (!preflight.ok) return { ok: false, code: preflight.units.length ? DEPLOY_BLOCKED_EXIT_CODE : 1, preflight };
  const channel = flag(argv, "--channel") || "main";
  const deployEnv = { ...env.env, ORKESTR_DEPLOY_REF: sha, ORKESTR_UPDATE_REF: sha, ORKESTR_DEPLOY_CHANNEL: channel, ORKESTR_RELEASE_DEPLOY: "1", ORKESTR_DEPLOY_TAGS_ONLY: "0", ORKESTR_RELEASE_TRAIN_FANOUT: "1" };
  const deployArgs = ["install", "--ref", sha, "--channel", channel, "--allow-untagged", "--all-instances", "--wait-active"];
  const launchArgv = [...(threadId ? ["--thread", threadId] : []), ...(argv.includes("--no-thread") ? ["--no-thread"] : []), ...(env.json ? ["--json"] : [])];
  const code = await (deps.launchDetachedDeploy || defaultLaunchDetachedDeploy)({
    argv: launchArgv,
    deployArgs,
    script: deps.updateScriptPath("deploy-git-release.sh"),
    env: deployEnv,
    ctx: { ...ctx, env: deployEnv },
    flagValue: flag,
    envArgs: deps.systemdRunEnvArgs(deployEnv),
    requestJson: (apiPath, options = {}) => deps.requestJson(apiPath, { ...ctx, ...options }),
  });
  writeShaRecord(env.stateDir, sha, { deploy: { launched: code === 0, exitCode: code, at: new Date(env.now()).toISOString(), channel } });
  return { ok: code === 0, code, preflight };
}

async function deployCommand(argv, ctx, deps, env) {
  const sha = requireSha(argv);
  const result = await deployStep(argv, ctx, deps, env, { sha });
  if (!result.ok && result.preflight && !result.preflight.ok) {
    emit(env, { ok: false, sha, problems: result.preflight.problems }, `Refusing release-train deploy of ${sha}:\n- ${result.preflight.problems.join("\n- ")}`);
  }
  return result.ok ? 0 : result.code || 1;
}

async function syncBranchesCommand(argv, ctx, deps, env) {
  const sha = requireSha(argv);
  const { git } = await repoGit(argv, ctx, env);
  await git(["fetch", "--quiet", "origin"], { allowFailure: true });
  const result = await syncBranches({ git, sha, pathPrefix: flag(argv, "--path-prefix"), dryRun: argv.includes("--dry-run") });
  emit(env, result, formatSyncBranches(result));
  return result.ok ? 0 : 1;
}

async function runCommand(argv, ctx, deps, env) {
  const { git } = await repoGit(argv, ctx, env);
  await git(["fetch", "--quiet", "origin"], { allowFailure: true });
  const ref = flag(argv, "--ref") || "main";
  const sha = await resolveRef(git, ref);
  const summary = { ok: false, ref, sha, stages: [] };
  const stop = (stage, message, code = 1) => {
    summary.stages.push({ stage, ok: false });
    summary.failedStage = stage;
    emit(env, summary, `Release train stopped at ${stage} for ${sha} (${ref}):\n${message}`);
    return code;
  };
  if (!(await onOrigin(git, sha))) return stop("origin", `${sha} is not on origin. Push ${ref} first; release-train run never pushes.`);
  const check = await checkStep(argv, ctx, deps, env, { git, sha });
  if (!check.result.ok) return stop("check", `step "${check.result.failedStep}" failed.\n${check.result.output || ""}\nLog: ${check.result.logFile}`);
  summary.stages.push({ stage: "check", ok: true });
  const ci = await ciStep(argv, ctx, deps, env, { git, sha, wait: true, timeoutMin: Number(flag(argv, "--timeout-min")) || 30 });
  if (!ci.result.ok) return stop("ci", describeCi(ci.result, sha));
  summary.stages.push({ stage: "ci", ok: true, runUrl: ci.result.runUrl || null });
  const deploy = await deployStep(argv, ctx, deps, env, { sha });
  if (!deploy.ok) return stop("deploy", deploy.preflight && !deploy.preflight.ok ? `- ${deploy.preflight.problems.join("\n- ")}` : `detached deploy launch exited ${deploy.code}`, deploy.code || 1);
  summary.stages.push({ stage: "deploy", ok: true });
  summary.ok = true;
  if (env.json) env.out(JSON.stringify(summary, null, 2));
  else env.out(`Release train for ${sha} (${ref}): check passed, CI green, detached deploy launched. After it finishes: orkestr release-train sync-branches --sha ${sha}`);
  return 0;
}

export async function releaseTrainCommand(argv, ctx, deps = {}) {
  const subcommand = argv[0] || "";
  const rest = argv.slice(1);
  if (!subcommand || subcommand === "help" || rest.includes("--help")) {
    ctx.stdout.write(`${RELEASE_TRAIN_USAGE}\n`);
    return subcommand ? 0 : 2;
  }
  const env = setup(rest, ctx, deps);
  if (subcommand === "check") return checkCommand(rest, ctx, deps, env);
  if (subcommand === "ci") return ciCommand(rest, ctx, deps, env);
  if (subcommand === "deploy") return deployCommand(rest, ctx, deps, env);
  if (subcommand === "sync-branches") return syncBranchesCommand(rest, ctx, deps, env);
  if (subcommand === "run") return runCommand(rest, ctx, deps, env);
  ctx.stderr.write(`Unknown release-train command: ${subcommand}\n${RELEASE_TRAIN_USAGE}\n`);
  return 2;
}
