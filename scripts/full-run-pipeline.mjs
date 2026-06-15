#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return clean(argv[index + 1]);
}

function allFlagValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(clean(argv[index + 1]));
  }
  return values.filter(Boolean);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function splitList(value = "") {
  return clean(value).split(/[\s,]+/g).map(clean).filter(Boolean);
}

function usage() {
  return `Usage: npm run pipeline:full -- [options]

Runs the full local OSS/demo release gate and writes a JSON summary artifact.

Default stages:
  npm run build
  npm run test:ci
  npm run oss:boundary-check
  npm run smoke:k3s:oss-demo
  npm run smoke:demo-vm
  npm run smoke
  npm run demo:coding-agent

Options:
  --plan                         Print the stage plan without running it.
  --artifact-dir DIR             Summary output directory. Defaults to ORKESTR_HOME/full-run-pipeline/<timestamp> or .orkestr/full-run-pipeline/<timestamp>.
  --include-launch-check         Also run npm run launch:check. This duplicates some gates but catches docs/privacy drift.
  --skip-build                   Skip npm run build.
  --skip-test-ci                 Skip npm run test:ci.
  --skip-smoke                   Skip smoke stages.
  --skip-demo                    Skip demo:coding-agent.
  --release-regression-target NAME=URL
                                 Run release regression for a target. Repeatable.
  --release-regression           Run release regression using ORKESTR_RELEASE_CHECK_URLS.
  --allow-auth-blocked           Pass through to release regression for protected public targets.
  --execute-regression           Allow release regression chat injection checks.
  --regression-thread ID         Thread for --execute-regression.
  --regression-expect TEXT       Expected assistant reply for --execute-regression.
  --live-k3s                     Run real k3s demo smoke. Requires Docker, Helm, kubectl.
  --vps-aws                      Run AWS VPS smoke.
  --demo-release                 Add isolated demo VM gates: isolation audit plus fresh-instance WhatsApp onboarding E2E.
  --wa-service-url URL           Standalone orkestr-wa service URL for demo release readiness. Defaults to ORKESTR_WA_SERVICE_URL or WHATSAPP_BRIDGE_URL.
  --wa-service-account ACCOUNT   Required orkestr-wa account. Repeatable; defaults to sender,responder for demo releases.
  --skip-wa-service-readiness    Skip standalone WA service readiness. Demo deploys require --allow-release-without-wa-service-readiness too.
  --allow-release-without-wa-service-readiness
                                 Explicit emergency bypass for demo deploys when the WA service gate cannot run.
  --demo-whatsapp-phone PHONE    Direct WhatsApp phone number for OSS demo onboarding E2E.
  --whatsapp-real                Run real WhatsApp e2e. Requires explicit real-WA env/config.
  --skip-whatsapp-real           Skip real WhatsApp e2e. Not allowed with --deploy-ref unless --allow-release-without-e2e is also set.
  --allow-release-without-e2e    Explicit emergency bypass for release deploys when real WhatsApp e2e cannot run.
  --skip-isolation-audit         Skip demo isolation audit. Demo deploys require --allow-release-without-isolation-audit too.
  --allow-release-without-isolation-audit
                                 Explicit emergency bypass for demo deploys when the isolation audit cannot run.
  --deploy-ref REF               Deploy with scripts/deploy-git-release.sh after gates pass.
  --deploy-channel CHANNEL       Deploy channel. Default: full-run.
  --deploy-env-file FILE         ORKESTR_ENV_FILE for deploy.
  --deploy-allow-interrupt       Allow deploy restart while work may be active.
  --deploy-all-instances         Fan out deploy to broker-listed instances. This is the default for release deploys.
  --deploy-no-all-instances      Disable broker fan-out for an intentional local-only deploy.

Environment:
  ORKESTR_FULL_RUN_LAUNCH_CHECK=1
  ORKESTR_FULL_RUN_LIVE_K3S=1
  ORKESTR_FULL_RUN_VPS_AWS=1
  ORKESTR_FULL_RUN_DEMO_RELEASE=1
  ORKESTR_FULL_RUN_WA_SERVICE_URL=http://127.0.0.1:18914
  ORKESTR_FULL_RUN_WA_SERVICE_ACCOUNTS="sender,responder"
  ORKESTR_REAL_WA_DEMO_PHONE_NUMBER="+4917600000000"
  ORKESTR_FULL_RUN_WHATSAPP_REAL=1
  ORKESTR_FULL_RUN_RELEASE_TARGETS="local=http://127.0.0.1:18912,oss=http://127.0.0.1:19822"
`;
}

export function parseFullRunPipelineArgs(argv = process.argv.slice(2), env = process.env) {
  const releaseTargets = [
    ...allFlagValues(argv, "--release-regression-target"),
    ...splitList(env.ORKESTR_FULL_RUN_RELEASE_TARGETS),
  ];
  const runReleaseRegression = hasFlag(argv, "--release-regression") ||
    releaseTargets.length > 0 ||
    Boolean(clean(env.ORKESTR_RELEASE_CHECK_URLS));
  const options = {
    help: hasFlag(argv, "--help") || hasFlag(argv, "-h"),
    plan: hasFlag(argv, "--plan"),
    artifactDir: flagValue(argv, "--artifact-dir", clean(env.ORKESTR_FULL_RUN_ARTIFACT_DIR)),
    includeLaunchCheck: hasFlag(argv, "--include-launch-check") || truthy(env.ORKESTR_FULL_RUN_LAUNCH_CHECK),
    skipBuild: hasFlag(argv, "--skip-build"),
    skipTestCi: hasFlag(argv, "--skip-test-ci"),
    skipSmoke: hasFlag(argv, "--skip-smoke"),
    skipDemo: hasFlag(argv, "--skip-demo"),
    runReleaseRegression,
    releaseTargets,
    allowAuthBlocked: hasFlag(argv, "--allow-auth-blocked"),
    executeRegression: hasFlag(argv, "--execute-regression"),
    regressionThread: flagValue(argv, "--regression-thread"),
    regressionExpect: flagValue(argv, "--regression-expect"),
    liveK3s: hasFlag(argv, "--live-k3s") || truthy(env.ORKESTR_FULL_RUN_LIVE_K3S),
    vpsAws: hasFlag(argv, "--vps-aws") || truthy(env.ORKESTR_FULL_RUN_VPS_AWS),
    demoRelease: hasFlag(argv, "--demo-release") || truthy(env.ORKESTR_FULL_RUN_DEMO_RELEASE),
    waServiceUrl: flagValue(argv, "--wa-service-url", clean(env.ORKESTR_FULL_RUN_WA_SERVICE_URL || env.ORKESTR_WA_SERVICE_URL || env.WHATSAPP_BRIDGE_URL)),
    waServiceAccounts: [
      ...allFlagValues(argv, "--wa-service-account"),
      ...splitList(env.ORKESTR_FULL_RUN_WA_SERVICE_ACCOUNTS || ""),
    ],
    skipWaServiceReadiness: hasFlag(argv, "--skip-wa-service-readiness") || truthy(env.ORKESTR_FULL_RUN_SKIP_WA_SERVICE_READINESS),
    allowReleaseWithoutWaServiceReadiness: hasFlag(argv, "--allow-release-without-wa-service-readiness") || truthy(env.ORKESTR_FULL_RUN_ALLOW_RELEASE_WITHOUT_WA_SERVICE_READINESS),
    demoWhatsappPhoneNumber: flagValue(argv, "--demo-whatsapp-phone", clean(
      env.ORKESTR_REAL_WA_DEMO_PHONE_NUMBER ||
      env.ORKESTR_REAL_WA_DEMO_PHONE ||
      env.ORKESTR_DEMO_WHATSAPP_NUMBER ||
      env.ORKESTR_DEMO_WA_NUMBER ||
      env.ORKESTR_DEMO_WHATSAPP_TARGET_PHONE,
    )),
    skipIsolationAudit: hasFlag(argv, "--skip-isolation-audit") || truthy(env.ORKESTR_FULL_RUN_SKIP_ISOLATION_AUDIT),
    allowReleaseWithoutIsolationAudit: hasFlag(argv, "--allow-release-without-isolation-audit") || truthy(env.ORKESTR_FULL_RUN_ALLOW_RELEASE_WITHOUT_ISOLATION_AUDIT),
    skipWhatsappReal: hasFlag(argv, "--skip-whatsapp-real") || truthy(env.ORKESTR_FULL_RUN_SKIP_WHATSAPP_REAL),
    allowReleaseWithoutE2e: hasFlag(argv, "--allow-release-without-e2e") || truthy(env.ORKESTR_FULL_RUN_ALLOW_RELEASE_WITHOUT_E2E),
    deployRef: flagValue(argv, "--deploy-ref"),
    deployChannel: flagValue(argv, "--deploy-channel", "full-run"),
    deployEnvFile: flagValue(argv, "--deploy-env-file"),
    deployAllowInterrupt: hasFlag(argv, "--deploy-allow-interrupt"),
    deployAllInstances: !hasFlag(argv, "--deploy-no-all-instances"),
  };
  options.whatsappReal = !options.skipWhatsappReal && (
    hasFlag(argv, "--whatsapp-real") ||
    truthy(env.ORKESTR_FULL_RUN_WHATSAPP_REAL) ||
    Boolean(options.deployRef)
  );
  options.releaseE2eBypass = Boolean(options.deployRef && options.skipWhatsappReal && options.allowReleaseWithoutE2e);
  if (options.demoRelease && options.whatsappReal && !options.demoWhatsappPhoneNumber) {
    options.invalid = true;
    options.error = "demo_release_requires_direct_whatsapp_phone";
  }
  if (options.deployRef && options.skipWhatsappReal && !options.allowReleaseWithoutE2e) {
    options.invalid = true;
    options.error = "release_deploy_requires_real_whatsapp_e2e";
  }
  if (options.deployRef && options.demoRelease && options.skipIsolationAudit && !options.allowReleaseWithoutIsolationAudit) {
    options.invalid = true;
    options.error = "demo_release_deploy_requires_isolation_audit";
  }
  if (options.deployRef && options.demoRelease && options.skipWaServiceReadiness && !options.allowReleaseWithoutWaServiceReadiness) {
    options.invalid = true;
    options.error = "demo_release_deploy_requires_wa_service_readiness";
  }
  if (options.demoRelease && (!options.waServiceAccounts || options.waServiceAccounts.length === 0)) {
    options.waServiceAccounts = ["sender", "responder"];
  }
  return options;
}

function npmStage(id, script, { enabled = true, env = {}, args = [], skipReason = "" } = {}) {
  return { id, label: `npm run ${script}`, command: "npm", args: ["run", script, ...(args.length ? ["--", ...args] : [])], env, enabled, skipReason };
}

function commandStage(id, label, command, args, { enabled = true, env = {}, skipReason = "" } = {}) {
  return { id, label, command, args, env, enabled, skipReason };
}

function artifactEnv(options = {}, name = "", envName = "") {
  if (!options.artifactDir || !name || !envName) return {};
  return { [envName]: path.join(options.artifactDir, name) };
}

function demoOnboardingEnv(options = {}) {
  return {
    ...artifactEnv(options, "real-wa-demo-onboarding.json", "ORKESTR_REAL_WA_DEMO_ARTIFACT"),
    ...(options.demoWhatsappPhoneNumber ? { ORKESTR_REAL_WA_DEMO_PHONE_NUMBER: options.demoWhatsappPhoneNumber } : {}),
    ORKESTR_REAL_WA_DEMO_CHAT_ID: "",
    ORKESTR_REAL_WA_E2E_CHAT_ID: "",
  };
}

function waServiceReadinessArgs(options = {}) {
  const args = ["scripts/orkestr-wa-readiness.mjs", "--require-routing-policy", "--require-access-policy"];
  if (options.waServiceUrl) args.push("--bridge-url", options.waServiceUrl);
  for (const account of options.waServiceAccounts || []) args.push("--account", account);
  return args;
}

export function fullRunPipelineStages(options = {}) {
  const stages = [
    npmStage("build", "build", { enabled: !options.skipBuild }),
    npmStage("test-ci", "test:ci", { enabled: !options.skipTestCi }),
    npmStage("oss-boundary", "oss:boundary-check"),
    npmStage("k3s-oss-demo-contract", "smoke:k3s:oss-demo", { enabled: !options.skipSmoke }),
    npmStage("demo-vm", "smoke:demo-vm", { enabled: !options.skipSmoke }),
    npmStage("smoke", "smoke", { enabled: !options.skipSmoke }),
    npmStage("coding-agent-demo", "demo:coding-agent", { enabled: !options.skipDemo }),
    npmStage("launch-check", "launch:check", { enabled: options.includeLaunchCheck }),
  ];

  if (options.runReleaseRegression) {
    const args = [];
    for (const target of options.releaseTargets || []) args.push("--target", target);
    if (options.allowAuthBlocked) args.push("--allow-auth-blocked");
    if (options.executeRegression) args.push("--execute");
    if (options.regressionThread) args.push("--thread", options.regressionThread);
    if (options.regressionExpect) args.push("--expect", options.regressionExpect);
    stages.push(npmStage("release-regression", "release:regression", { args }));
  }
  stages.push(commandStage("wa-service-readiness", "orkestr-wa readiness", "node", waServiceReadinessArgs(options), {
    enabled: options.demoRelease && !options.skipWaServiceReadiness,
    skipReason: options.demoRelease && options.skipWaServiceReadiness ? "skip_wa_service_readiness" : "",
  }));
  stages.push(npmStage("isolation-audit", "audit:isolation", {
    enabled: options.demoRelease && !options.skipIsolationAudit,
    skipReason: options.demoRelease && options.skipIsolationAudit ? "skip_isolation_audit" : "",
  }));
  stages.push(npmStage("live-k3s-oss-demo", "smoke:k3s:oss-demo", {
    enabled: options.liveK3s,
    env: { ORKESTR_K3S_OSS_DEMO_EXECUTE: "1" },
  }));
  stages.push(npmStage("vps-aws", "smoke:vps:aws", { enabled: options.vpsAws }));
  stages.push(npmStage("whatsapp-real", "e2e:whatsapp-real", {
    enabled: options.whatsappReal,
    env: artifactEnv(options, "real-wa-e2e.json", "ORKESTR_REAL_WA_E2E_ARTIFACT"),
    skipReason: options.skipWhatsappReal ? "skip_whatsapp_real" : "",
  }));
  stages.push(npmStage("whatsapp-demo-onboarding", "e2e:whatsapp-demo-onboarding", {
    enabled: options.demoRelease && options.whatsappReal,
    env: demoOnboardingEnv(options),
    skipReason: options.demoRelease && options.skipWhatsappReal ? "skip_whatsapp_real" : "",
  }));

  if (options.deployRef) {
    const args = ["scripts/deploy-git-release.sh", "install", "--ref", options.deployRef, "--channel", options.deployChannel || "full-run"];
    args.push(options.deployAllowInterrupt ? "--allow-interrupt" : "--no-interrupt");
    args.push(options.deployAllInstances ? "--all-instances" : "--no-all-instances");
    stages.push(commandStage("deploy", `deploy ${options.deployRef}`, "bash", args, {
      env: {
        ...(options.deployEnvFile ? { ORKESTR_ENV_FILE: options.deployEnvFile } : {}),
      },
    }));
  }

  return stages;
}

function defaultArtifactDir(env = process.env) {
  const root = clean(env.ORKESTR_HOME) || path.join(repoRoot, ".orkestr");
  return path.join(root, "full-run-pipeline", timestampId());
}

async function writeSummary(artifactDir, summary) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, "summary.json");
  await fs.writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return file;
}

function runStage(stage) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    console.log(`\n== ${stage.label} ==`);
    const child = spawn(stage.command, stage.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ORKESTR_BROWSER_LAUNCH_DISABLED: process.env.ORKESTR_BROWSER_LAUNCH_DISABLED || "1",
        ...(stage.env || {}),
      },
    });
    child.once("exit", (code, signal) => {
      const endedAt = new Date();
      resolve({
        id: stage.id,
        label: stage.label,
        command: [stage.command, ...stage.args].join(" "),
        status: code === 0 ? "passed" : "failed",
        code,
        signal,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    });
  });
}

export async function runFullRunPipeline(options = {}, env = process.env) {
  const artifactDir = path.resolve(options.artifactDir || defaultArtifactDir(env));
  const allStages = fullRunPipelineStages({ ...options, artifactDir });
  const stages = allStages.filter((stage) => stage.enabled !== false);
  const skipped = allStages.filter((stage) => stage.enabled === false).map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: "skipped",
    ...(stage.skipReason ? { reason: stage.skipReason } : {}),
  }));
  const summary = {
    ok: false,
    generatedAt: new Date().toISOString(),
    artifactDir,
    repoRoot,
    stages: [],
    skipped,
  };

  if (options.plan) {
    summary.ok = true;
    summary.planned = stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      command: [stage.command, ...stage.args].join(" "),
      env: Object.keys(stage.env || {}).sort(),
    }));
    await writeSummary(artifactDir, summary);
    return summary;
  }
  if (options.invalid) {
    summary.error = options.error || "invalid_full_run_pipeline_options";
    await writeSummary(artifactDir, summary);
    return summary;
  }

  for (const stage of stages) {
    const result = await runStage(stage);
    summary.stages.push(result);
    await writeSummary(artifactDir, summary);
    if (result.status !== "passed") {
      summary.failedStage = result.id;
      await writeSummary(artifactDir, summary);
      return summary;
    }
  }
  summary.ok = true;
  summary.completedAt = new Date().toISOString();
  await writeSummary(artifactDir, summary);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseFullRunPipelineArgs(process.argv.slice(2), process.env);
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  runFullRunPipeline(options)
    .then((summary) => {
      if (options.plan) {
        console.log(JSON.stringify({
          ok: true,
          artifactDir: summary.artifactDir,
          planned: summary.planned,
          skipped: summary.skipped,
        }, null, 2));
      } else {
        console.log(`\nFull run pipeline ${summary.ok ? "passed" : "failed"}.`);
        console.log(`Summary: ${path.join(summary.artifactDir, "summary.json")}`);
      }
      if (!summary.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
