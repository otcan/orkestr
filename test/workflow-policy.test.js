import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateWorkflow, actionPins, checkWorkflows } from "../scripts/security/workflow-policy.mjs";

const fixture = `on: [pull_request, push]
permissions: {contents: read}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${actionPins["actions/checkout"]}
        with: {persist-credentials: false}
      - run: echo fixture
`;
test("ordinary read-only immutable workflow passes", () => assert.deepEqual(validateWorkflow(fixture), { jobs: 1, actions: 1 }));
for (const [name, before, after] of [
  ["mutable action", actionPins["actions/checkout"], "v6"],
  ["unreviewed immutable action", actionPins["actions/checkout"], "a".repeat(40)],
  ["credential persistence", "persist-credentials: false", "persist-credentials: true"],
  ["implicit credentials", "with: {persist-credentials: false}", "with: {}"],
  ["write token", "contents: read", "contents: write"],
  ["OIDC token", "contents: read", "contents: read, id-token: write"],
  ["privileged event", "pull_request, push", "pull_request_target"],
  ["workflow run event", "pull_request, push", "workflow_run"],
  ["self hosted runner", "ubuntu-latest", "self-hosted"],
  ["dynamic runner", "ubuntu-latest", "${{ matrix.runner }}"],
  ["duplicate key", "permissions: {contents: read}", "permissions: {contents: read}\npermissions: {contents: write}"],
  ["anchor", "{contents: read}", "&policy {contents: read}"],
  ["local action bypass", `actions/checkout@${actionPins["actions/checkout"]}`, "./unreviewed"],
  ["secret expression", "echo fixture", "echo '${{ secrets.TOKEN }}'"],
  ["job permission escalation", "runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n    permissions: write-all"],
  ["ignored gate", "runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n    continue-on-error: true"],
]) test(`rejects ${name}`, () => assert.throws(() => validateWorkflow(fixture.replace(before, after)), /workflow_/));

const attestFixture = `on: [pull_request, push]
permissions: {contents: read}
jobs:
  provenance:
    if: \${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
      attestations: write
    steps:
      - uses: actions/download-artifact@${actionPins["actions/download-artifact"]}
        with: {name: runtime-dist}
      - run: sha256sum file > subjects.sha256
      - uses: actions/attest-build-provenance@${actionPins["actions/attest-build-provenance"]}
        with: {subject-checksums: subjects.sha256}
`;
test("trusted-event attestation job may hold OIDC and attestation write permissions", () => assert.deepEqual(validateWorkflow(attestFixture), { jobs: 1, actions: 2 }));
for (const [name, before, after] of [
  ["attestation on pull requests", "github.event_name == 'push' || ", "github.event_name == 'pull_request' || "],
  ["attestation without event gate", "    if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}\n", ""],
  ["attestation job running npm", "run: sha256sum file", "run: npm ci && sha256sum file"],
  ["attestation job with extra write scope", "      attestations: write", "      attestations: write\n      contents: write"],
  ["attestation job with packages scope", "      attestations: write", "      attestations: write\n      packages: write"],
  ["OIDC without attestation action", `      - uses: actions/attest-build-provenance@${actionPins["actions/attest-build-provenance"]}\n        with: {subject-checksums: subjects.sha256}\n`, ""],
  ["unpinned attestation action", actionPins["actions/attest-build-provenance"], "v4"],
]) test(`rejects ${name}`, () => assert.throws(() => validateWorkflow(attestFixture.replace(before, after)), /workflow_/));

test("CI publishes a runtime content manifest and attests it from a trusted-event job", async () => {
  const workflow = parse(await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const build = workflow.jobs.build;
  assert.match(build.steps.find((step) => step.name === "Runtime content manifest").run, /content-manifest\.mjs --root dist/);
  assert.ok(build.steps.some((step) => step.with?.name === "runtime-dist-manifest"));
  assert.equal(build.outputs["runtime-digest"], "${{ steps.runtime-artifact.outputs.artifact-digest }}");
  const job = workflow.jobs.provenance;
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write", attestations: "write" });
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(Object.keys(workflow.permissions).length, 1);
  const attest = job.steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  assert.equal(attest.uses, `actions/attest-build-provenance@${actionPins["actions/attest-build-provenance"]}`);
  assert.match(attest.with["subject-checksums"], /provenance-subjects\.sha256/);
  assert.match(job.steps.find((step) => step.name?.startsWith("Verify content manifest")).run, /--expect/);
});

test("all repository workflows satisfy policy and retain readable version annotations", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  assert.equal((await checkWorkflows(fileURLToPath(directory))).ok, true);
  const ci = await fs.readFile(new URL("ci.yml", directory), "utf8");
  for (const line of ci.split("\n").filter(line => /uses:/.test(line))) assert.match(line, /@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
  assert.match(ci, /run: npm run security:workflows/);
});

test("proposed landing contract preserves scans and requires durable evidence gates", async () => {
  const contract = JSON.parse(await fs.readFile(new URL("../.github/dependency-required-checks.json", import.meta.url), "utf8"));
  const workflow = parse(await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(contract.state, "proposed-not-applied", "a repository file cannot attest live enforcement");
  for (const check of ["secret-scan", "secret-policy", "dependency-policy"]) {
    assert.ok(contract.requiredChecks.includes(check));
    assert.ok(workflow.jobs[check]);
  }
  for (const gate of ["secret-policy", "dependency-policy"]) {
    const job = workflow.jobs[gate];
    assert.equal(job.if, "${{ always() }}");
    assert.ok(workflow.jobs[job.needs]);
    const step = job.steps[0];
    assert.match(step.env.RESULT, /\.result/);
    assert.match(step.env.EVIDENCE_ID, /outputs\.evidence-id/);
    assert.match(step.env.EVIDENCE_DIGEST, /outputs\.evidence-digest/);
    assert.match(step.run, /test "\$RESULT" = success/);
    assert.match(step.run, /test -n "\$EVIDENCE_ID"/);
    assert.match(step.run, /test -n "\$EVIDENCE_DIGEST"/);
    const publisher = workflow.jobs[job.needs].steps.find(value => value.id === "evidence");
    assert.equal(publisher.if, "${{ always() }}");
    assert.equal(publisher.with["if-no-files-found"], "error");
  }
  for (const file of ["package.json", "package-lock.json", ".npmrc", ".github/workflows/**", "scripts/security/**"])
    assert.ok(contract.protectedPolicyPaths.includes(file));
});

test("secret scanning executes immutable base policy, not candidate scanner or suppressions", async () => {
  const source = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = parse(source).jobs["secret-scan"];
  assert.equal(job.env.POLICY_REF, "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.sha }}");
  assert.equal(job.env.SCAN_COMMIT, "${{ github.sha }}");
  const checkout = job.steps.find(step => step.with?.path === ".secret-policy");
  assert.equal(checkout.uses, `actions/checkout@${actionPins["actions/checkout"]}`);
  assert.equal(checkout.with.ref, "${{ env.POLICY_REF }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const run = job.steps.find(step => step.name === "Pinned redacted secret scan").run;
  assert.ok(job.steps.indexOf(checkout) < job.steps.findIndex(step => step.run === run));
  assert.match(run, /node \.secret-policy\/scripts\/security\/secret-scan\.mjs/);
  assert.match(run, /--repository "\$GITHUB_WORKSPACE"/);
  assert.match(run, /--target-ref HEAD --expected-commit "\$SCAN_COMMIT"/);
  assert.doesNotMatch(run, /node scripts\/security\/secret-scan|\|\||continue-on-error/);
  assert.match(run, /sha256sum --check --status/);
});
