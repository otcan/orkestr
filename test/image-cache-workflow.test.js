import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { parse } from "yaml";
import { validateWorkflow } from "../scripts/security/workflow-policy.mjs";

const source = await fs.readFile(new URL("../.github/workflows/v2-image.yml", import.meta.url), "utf8");
const workflow = parse(source);

test("native image cache jobs keep PR imports read only and exact-source checks", () => {
  validateWorkflow(source, "v2-image.yml");
  const scopes = new Set();
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
    // GitHub rejected the original run before allocating any runner because
    // runner.temp is unavailable in job-level env expressions.
    for (const value of Object.values(job.env || {})) assert.doesNotMatch(String(value), /\$\{\{[^}]*runner\./);
    assert.ok(job.steps.some(step => step.run?.includes('DOCKER_CONFIG=$RUNNER_TEMP/empty-docker-config') &&
      step.run.includes('"$GITHUB_ENV"')));
    const builder = job.steps.find(step => step.uses?.startsWith("docker/setup-buildx-action@"));
    assert.equal(builder.with["buildkitd-flags"], "--debug=false");
    const builds = job.steps.filter(step => step.uses?.startsWith("docker/build-push-action@"));
    for (const step of builds) {
      assert.equal(step.with.context, ".");
      assert.equal(step.with.push, false);
      // Remote ancestor metadata is scoped to a BuildKit solve/session; a
      // cached runtime COPY must not cause the later bundle to compile again.
      assert.ok(step.with["cache-from"], "every independent solve imports its compatible metadata");
      assert.match(step.with["build-args"], /SOURCE_COMMIT=\$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
      assert.match(step.with["build-args"], /BUILD_JOBS=4/);
      if (step.with["cache-from"]) {
        assert.match(step.with["cache-from"], /type=gha,version=2,scope=v2-image-v1-/);
        assert.match(step.with["cache-from"], new RegExp(name.endsWith("amd64") ? "-amd64-" : "-arm64-"));
        scopes.add(step.with["cache-from"]);
      }
      if (step.with["cache-to"]) {
        assert.match(step.if, /github.event_name == 'push' \|\| github.event_name == 'workflow_dispatch'/);
        if (step.with["cache-to"].startsWith("type=gha")) {
          assert.match(step.if, /steps.cache-budget.outputs.allowed == 'true'/);
          assert.match(step.with["cache-to"], /version=2/);
        }
      }
    }
    assert.ok(job.steps.some(step => step.run?.includes("cache_boundaries.py")));
    assert.equal(job.steps.filter(step => step.run?.includes("fresh_install.py")).length, 2);
    assert.ok(builds.some(step => step.with.target === "tooling"));
    assert.ok(job.steps.some(step => step.run?.includes("docker save")));
  }
  assert.equal(scopes.size, 2);
});

test("cache usage read permission cannot escape the image workflow or become write", () => {
  assert.throws(() => validateWorkflow(source, "ci.yml"), /workflow_permissions/);
  assert.throws(() => validateWorkflow(source.replaceAll("actions: read", "actions: write"), "v2-image.yml"), /workflow_permissions/);
});

test("paired candidates keep diagnostic and empty files outside the import contract", () => {
  const candidatePaths = [
    "${{ runner.temp }}/fresh-install.json",
    "${{ runner.temp }}/local-fresh-install.json",
    "${{ runner.temp }}/bundle/*.tar.gz",
    "${{ runner.temp }}/bundle/SHA256SUMS",
    "${{ runner.temp }}/bundle/paired-artifacts.json",
  ];
  const paths = step => step.with.path.trim().split(/\r?\n/);
  const selected = (step, files) => {
    const patterns = paths(step).map(path => new RegExp("^" + path
      .replace("${{ runner.temp }}/", "")
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*") + "$"));
    return [...files].filter(([name]) => patterns.some(pattern => pattern.test(name)));
  };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const arch = name.endsWith("amd64") ? "amd64" : "arm64";
    const candidate = job.steps.find(step => step.with?.name === `v2-linux-${arch}-candidate-\${{ github.run_id }}`);
    assert.ok(candidate);
    // These five paths are the paired-artifact consumer's closed inventory.
    assert.deepEqual(paths(candidate), candidatePaths);
    const diagnostics = job.steps.find(step => step.with?.name === `v2-linux-${arch}-diagnostics-\${{ github.run_id }}`);
    assert.ok(diagnostics, "cache and resource evidence remains downloadable separately");
    assert.equal(diagnostics.if, "always()");
    assert.equal(diagnostics.with["if-no-files-found"], "ignore");
    assert.equal(diagnostics.with["retention-days"], 7);
    const target = arch === "amd64" ? "x86_64" : "aarch64";
    const required = new Map([
      ["fresh-install.json", "{}"],
      ["local-fresh-install.json", "{}"],
      [`bundle/orkestr-v2-2.0.0-beta.1-${target}-unknown-linux-gnu.tar.gz`, "synthetic bundle"],
      ["bundle/SHA256SUMS", "synthetic checksum"],
      ["bundle/paired-artifacts.json", "{}"],
    ]);
    const files = new Map([...required,
      ["cache-allowance.json", "{}"], ["cache-budget.json", "{}"],
      ["cache-boundaries.json", "{}"], ["cache-boundaries.invalid-0.log", ""],
      ["image-metrics.jsonl", "{}"], ["image-metrics.log", ""], ["image-metrics.stop", ""],
    ]);
    assert.deepEqual(new Map(selected(candidate, files)), required);
    const diagnosticFiles = new Map(selected(diagnostics, files));
    assert.equal(diagnosticFiles.size, files.size - required.size);
    assert.equal(diagnosticFiles.get("image-metrics.stop"), "");
    assert.ok([...required.keys()].every(path => !diagnosticFiles.has(path)));
  }
});
