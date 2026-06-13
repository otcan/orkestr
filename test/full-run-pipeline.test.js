import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  fullRunPipelineStages,
  parseFullRunPipelineArgs,
  runFullRunPipeline,
} from "../scripts/full-run-pipeline.mjs";

const execFile = promisify(execFileCallback);

function stageIds(options = {}) {
  return fullRunPipelineStages(options)
    .filter((stage) => stage.enabled !== false)
    .map((stage) => stage.id);
}

test("full run pipeline defaults to local release gates without live side effects", () => {
  const options = parseFullRunPipelineArgs([], {});
  const ids = stageIds(options);

  assert.deepEqual(ids, [
    "build",
    "test-ci",
    "oss-boundary",
    "k3s-oss-demo-contract",
    "demo-vm",
    "smoke",
    "coding-agent-demo",
  ]);
  assert.equal(ids.includes("live-k3s-oss-demo"), false);
  assert.equal(ids.includes("vps-aws"), false);
  assert.equal(ids.includes("whatsapp-real"), false);
  assert.equal(ids.includes("deploy"), false);
});

test("full run pipeline can include launch, regression, live smoke, and deploy gates explicitly", () => {
  const options = parseFullRunPipelineArgs([
    "--include-launch-check",
    "--release-regression-target",
    "local=http://127.0.0.1:18912",
    "--allow-auth-blocked",
    "--live-k3s",
    "--vps-aws",
    "--whatsapp-real",
    "--deploy-ref",
    "v0.1.0-alpha.33",
    "--deploy-channel",
    "production",
    "--deploy-env-file",
    "/etc/orkestr/orkestr.env",
    "--deploy-allow-interrupt",
    "--deploy-all-instances",
  ], {});
  const stages = fullRunPipelineStages(options).filter((stage) => stage.enabled !== false);
  const ids = stages.map((stage) => stage.id);

  assert.ok(ids.includes("launch-check"));
  assert.ok(ids.includes("release-regression"));
  assert.ok(ids.includes("live-k3s-oss-demo"));
  assert.ok(ids.includes("vps-aws"));
  assert.ok(ids.includes("whatsapp-real"));
  assert.ok(ids.includes("deploy"));
  assert.match(stages.find((stage) => stage.id === "release-regression").args.join(" "), /--allow-auth-blocked/);
  assert.match(stages.find((stage) => stage.id === "deploy").args.join(" "), /--all-instances/);
  assert.equal(stages.find((stage) => stage.id === "deploy").env.ORKESTR_ENV_FILE, "/etc/orkestr/orkestr.env");
});

test("full run pipeline requires real WhatsApp e2e before release deploys", () => {
  const options = parseFullRunPipelineArgs([
    "--deploy-ref",
    "v0.1.0-alpha.34",
  ], {});
  const ids = stageIds(options);

  assert.equal(options.whatsappReal, true);
  assert.equal(options.invalid, undefined);
  assert.ok(ids.indexOf("whatsapp-real") < ids.indexOf("deploy"));
});

test("full run pipeline adds isolated demo gates for demo release deploys", () => {
  const artifactDir = "/tmp/orkestr-full-run-artifacts";
  const options = parseFullRunPipelineArgs([
    "--demo-release",
    "--artifact-dir",
    artifactDir,
    "--deploy-ref",
    "v0.1.0-alpha.35",
  ], {});
  const stages = fullRunPipelineStages(options).filter((stage) => stage.enabled !== false);
  const ids = stages.map((stage) => stage.id);

  assert.ok(ids.indexOf("isolation-audit") < ids.indexOf("whatsapp-real"));
  assert.ok(ids.indexOf("whatsapp-real") < ids.indexOf("whatsapp-demo-onboarding"));
  assert.ok(ids.indexOf("whatsapp-demo-onboarding") < ids.indexOf("deploy"));
  assert.equal(
    stages.find((stage) => stage.id === "whatsapp-real").env.ORKESTR_REAL_WA_E2E_ARTIFACT,
    path.join(artifactDir, "real-wa-e2e.json"),
  );
  assert.equal(
    stages.find((stage) => stage.id === "whatsapp-demo-onboarding").env.ORKESTR_REAL_WA_DEMO_ARTIFACT,
    path.join(artifactDir, "real-wa-demo-onboarding.json"),
  );
});

test("full run pipeline blocks release deploys when real WhatsApp e2e is skipped without bypass", () => {
  const options = parseFullRunPipelineArgs([
    "--deploy-ref",
    "v0.1.0-alpha.34",
    "--skip-whatsapp-real",
  ], {});

  assert.equal(options.invalid, true);
  assert.equal(options.error, "release_deploy_requires_real_whatsapp_e2e");
});

test("full run pipeline blocks demo release deploys when isolation audit is skipped without bypass", () => {
  const options = parseFullRunPipelineArgs([
    "--demo-release",
    "--deploy-ref",
    "v0.1.0-alpha.35",
    "--skip-isolation-audit",
  ], {});

  assert.equal(options.invalid, true);
  assert.equal(options.error, "demo_release_deploy_requires_isolation_audit");
});

test("full run pipeline allows an explicit emergency release e2e bypass", () => {
  const options = parseFullRunPipelineArgs([
    "--deploy-ref",
    "v0.1.0-alpha.34",
    "--skip-whatsapp-real",
    "--allow-release-without-e2e",
  ], {});
  const ids = stageIds(options);

  assert.equal(options.invalid, undefined);
  assert.equal(options.releaseE2eBypass, true);
  assert.equal(ids.includes("whatsapp-real"), false);
  assert.equal(ids.includes("deploy"), true);
});

test("full run pipeline records deliberate demo release gate skips", async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-full-run-skips-"));
  const options = parseFullRunPipelineArgs([
    "--plan",
    "--demo-release",
    "--artifact-dir",
    artifactDir,
    "--deploy-ref",
    "v0.1.0-alpha.35",
    "--skip-whatsapp-real",
    "--allow-release-without-e2e",
    "--skip-isolation-audit",
    "--allow-release-without-isolation-audit",
  ], {});

  const summary = await runFullRunPipeline(options, {});
  const skipped = Object.fromEntries(summary.skipped.map((stage) => [stage.id, stage]));

  assert.equal(summary.ok, true);
  assert.equal(skipped["isolation-audit"].reason, "skip_isolation_audit");
  assert.equal(skipped["whatsapp-real"].reason, "skip_whatsapp_real");
  assert.equal(skipped["whatsapp-demo-onboarding"].reason, "skip_whatsapp_real");
});

test("full run pipeline CLI prints an inspectable plan", async () => {
  const { stdout } = await execFile(process.execPath, ["scripts/full-run-pipeline.mjs", "--plan", "--artifact-dir", ".orkestr/test-full-run-plan"], {
    env: { ...process.env, ORKESTR_FULL_RUN_RELEASE_TARGETS: "" },
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.planned[0].id, "build");
  assert.equal(payload.planned.some((stage) => stage.id === "test-ci"), true);
  assert.equal(payload.planned.some((stage) => stage.id === "deploy"), false);
});
