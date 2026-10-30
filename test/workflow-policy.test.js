import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateWorkflow, actionPins, checkWorkflows, publishRunAllowed } from "../scripts/security/workflow-policy.mjs";

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
test("existing Rust cache workflows require the reviewed immutable upstream pin", () => {
  const cache = fixture.replace(`actions/checkout@${actionPins["actions/checkout"]}`, `Swatinem/rust-cache@${actionPins["Swatinem/rust-cache"]}`);
  assert.deepEqual(validateWorkflow(cache), { jobs: 1, actions: 1 });
  for (const pin of ["v2.9.3", "a".repeat(40)]) {
    assert.throws(() => validateWorkflow(cache.replace(actionPins["Swatinem/rust-cache"], pin)), /workflow_action_pin/);
  }
});
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
test("Rust cache remains forbidden in privileged attestation jobs", () => {
  const cache = attestFixture.replace("    steps:\n", `    steps:\n      - uses: Swatinem/rust-cache@${actionPins["Swatinem/rust-cache"]}\n`);
  assert.throws(() => validateWorkflow(cache), /workflow_attestation_actions/);
});
for (const [name, before, after] of [
  ["attestation on pull requests", "github.event_name == 'push' || ", "github.event_name == 'pull_request' || "],
  ["attestation without event gate", "    if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}\n", ""],
  ["attestation job running npm", "run: sha256sum file", "run: npm ci && sha256sum file"],
  ["attestation job with extra write scope", "      attestations: write", "      attestations: write\n      contents: write"],
  ["attestation job with packages scope", "      attestations: write", "      attestations: write\n      packages: write"],
  ["OIDC without attestation action", `      - uses: actions/attest-build-provenance@${actionPins["actions/attest-build-provenance"]}\n        with: {subject-checksums: subjects.sha256}\n`, ""],
  ["unpinned attestation action", actionPins["actions/attest-build-provenance"], "v4"],
]) test(`rejects ${name}`, () => assert.throws(() => validateWorkflow(attestFixture.replace(before, after)), /workflow_/));

const publishGate = "${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && (github.ref == 'refs/heads/main' || (startsWith(github.ref, 'refs/tags/v') && !startsWith(github.ref, 'refs/tags/v2.'))) }}";
const publishFixture = `on: [pull_request, push]
permissions: {contents: read}
jobs:
  image-publish:
    if: ${publishGate}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/download-artifact@${actionPins["actions/download-artifact"]}
        with: {name: runtime-image, path: image}
      - run: docker load --input image/orkestr-image.tar.gz
      - env:
          GHCR_TOKEN: \${{ github.token }}
        run: echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
      - run: |
          set -euo pipefail
          IMAGE="ghcr.io/\${GITHUB_REPOSITORY,,}"
          docker tag orkestr-ci:candidate "$IMAGE:main"
          docker push "$IMAGE:main"
`;
test("trusted-ref publish job may hold packages write permission", () => assert.deepEqual(validateWorkflow(publishFixture), { jobs: 1, actions: 1 }));
for (const [name, before, after] of [
  ["publish job running npm", "docker load --input", "npm ci && docker load --input"],
  ["publish job running npx", "docker load --input", "npx something; docker load --input"],
  ["publish job running node", "docker load --input", "node build.js && docker load --input"],
  ["publish job running a non-docker command", "docker push \"$IMAGE:main\"", "curl -X POST https://example.invalid"],
  ["publish job running a candidate container", "docker push \"$IMAGE:main\"", "docker run orkestr-ci:candidate"],
  ["publish job running a candidate build", "docker push \"$IMAGE:main\"", "docker build ."],
  ["publish job command substitution", "docker push \"$IMAGE:main\"", "docker push \"$(cat tag)\""],
  ["publish job redirection", "docker push \"$IMAGE:main\"", "echo x > run.sh"],
  ["publish job custom shell", "      - run: docker load", "      - shell: python {0}\n        run: docker load"],
  ["publish on pull requests", "github.event_name == 'push' || ", "github.event_name == 'pull_request' || "],
  ["publish without event gate", `    if: ${publishGate}\n`, ""],
  ["publish from any branch", "github.ref == 'refs/heads/main'", "startsWith(github.ref, 'refs/heads/')"],
  ["publish on V2 tags", " && !startsWith(github.ref, 'refs/tags/v2.')", ""],
  ["publish with extra permissions", "      packages: write", "      packages: write\n      id-token: write"],
  ["publish with contents write", "      contents: read\n      packages", "      contents: write\n      packages"],
  ["publish job checking out candidate code", "    steps:\n", `    steps:\n      - uses: actions/checkout@${actionPins["actions/checkout"]}\n        with: {persist-credentials: false}\n`],
  ["publish artifact from another run", "path: image}", "path: image, run-id: '1', github-token: x}"],
  ["unpinned publish action", actionPins["actions/download-artifact"], "v4"],
  ["publish secret expression", "${{ github.token }}", "${{ secrets.GHCR }}"],
  ["packages write on an ordinary job", "      packages: write\n    steps:", "      packages: write\n    steps:\n      - run: npm test"],
]) test(`rejects ${name}`, () => {
  const source = publishFixture.replace(before, after);
  assert.notEqual(source, publishFixture, `fixture replacement for ${name} did not apply`);
  assert.throws(() => validateWorkflow(source), /^Error: workflow_(?!yaml)/);
});
const v2PublishGate = "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v2.0.0-beta.') }}";
const v2PublishFixture = `on:
  push:
    tags: ['v2.0.0-beta.*']
permissions: {contents: read}
jobs:
  image-publish:
    if: ${v2PublishGate}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/download-artifact@${actionPins["actions/download-artifact"]}
        with: {name: v2-image-amd64, path: amd64}
      - run: docker load --input amd64/orkestr-v2-amd64.tar.gz
      - run: |
          set -euo pipefail
          [[ "$GITHUB_REF_NAME" =~ ^v2\\.0\\.0-beta\\.[0-9]+(-rc\\.[0-9]+)?$ ]]
          IMAGE="ghcr.io/\${GITHUB_REPOSITORY,,}"
          docker tag orkestr-v2:amd64 "$IMAGE:$GITHUB_REF_NAME-amd64"
          docker push "$IMAGE:$GITHUB_REF_NAME-amd64"
          docker buildx imagetools create --tag "$IMAGE:$GITHUB_REF_NAME" "$IMAGE:$GITHUB_REF_NAME-amd64"
`;
test("V2 beta publish is accepted only from v2-publish.yml", () => {
  assert.deepEqual(validateWorkflow(v2PublishFixture, "v2-publish.yml"), { jobs: 1, actions: 1 });
  assert.throws(() => validateWorkflow(v2PublishFixture, "ci.yml"), /workflow_publish_event/);
  assert.throws(() => validateWorkflow(publishFixture, "v2-publish.yml"), /workflow_publish_event/);
});
for (const [name, before, after] of [
  ["V2 publish moving latest", '--tag "$IMAGE:$GITHUB_REF_NAME"', '--tag "$IMAGE:latest" --tag "$IMAGE:$GITHUB_REF_NAME"'],
  ["V2 publish pushing main", 'docker push "$IMAGE:$GITHUB_REF_NAME-amd64"', 'docker push "$IMAGE:main"'],
  ["V2 publish pushing a V1 tag", 'docker push "$IMAGE:$GITHUB_REF_NAME-amd64"', 'docker push "$IMAGE:v0.1.0-alpha.99"'],
  ["V2 publish with a derived tag", 'docker push "$IMAGE:$GITHUB_REF_NAME-amd64"', 'docker push "$IMAGE:$TAG"'],
  ["V2 publish without the ref guard", '          [[ "$GITHUB_REF_NAME" =~ ^v2\\.0\\.0-beta\\.[0-9]+(-rc\\.[0-9]+)?$ ]]\n', ""],
  ["V2 publish from any tag", "startsWith(github.ref, 'refs/tags/v2.0.0-beta.')", "startsWith(github.ref, 'refs/tags/v')"],
  ["V2 publish on dispatch", "github.event_name == 'push' && ", "github.event_name == 'workflow_dispatch' && "],
]) test(`rejects ${name}`, () => {
  const source = v2PublishFixture.replace(before, after);
  assert.notEqual(source, v2PublishFixture, `fixture replacement for ${name} did not apply`);
  assert.throws(() => validateWorkflow(source, "v2-publish.yml"), /^Error: workflow_(?!yaml)/);
});
test("packages write is rejected on a job that is not a publish job", () => assert.throws(() => validateWorkflow(fixture.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n    permissions: {contents: read, packages: write}")), /workflow_/));
test("publish run allowlist accepts docker/builtins only", () => {
  assert.equal(publishRunAllowed("set -euo pipefail\n[[ \"$GITHUB_REF_NAME\" =~ ^v[0-9A-Za-z._-]+$ ]]\ndocker tag a b"), true);
  for (const run of ["docker exec c sh", "sh -c 'docker push x'", "bash script.sh", "./publish.sh", "eval \"$X\"", undefined])
    assert.equal(publishRunAllowed(run), false, String(run));
});

test("CI builds, smoke-tests and publishes the runtime image to GHCR only after all checks pass", async () => {
  const source = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  const image = workflow.jobs.image;
  assert.equal(image.permissions, undefined);
  const imageRuns = image.steps.map(step => step.run || "").join("\n");
  assert.match(imageRuns, /docker build/);
  assert.match(imageRuns, /\/api\/health/);
  assert.match(imageRuns, /docker exec orkestr-smoke orkestr --help/);
  assert.match(imageRuns, /docker save orkestr-ci:candidate \| gzip/);
  const upload = image.steps.find(step => step.with?.name === "runtime-image");
  assert.ok(upload.with["retention-days"] <= 7);
  const publish = workflow.jobs["image-publish"];
  assert.deepEqual(publish.permissions, { contents: "read", packages: "write" });
  assert.equal(publish.if, publishGate);
  // V2 tags ship the V2 tarball; they never publish the root V1 image or move :latest.
  assert.equal(workflow.jobs["image-arm64"].if, publishGate);
  assert.match(publish.if, /!startsWith\(github\.ref, 'refs\/tags\/v2\.'\)/);
  for (const job of ["image", "test", "smoke", "provenance", "secret-policy", "syntax"]) assert.ok(publish.needs.includes(job), job);
  assert.ok(publish.steps.every(step => !step.uses || step.uses.startsWith("actions/download-artifact@")));
  const runs = publish.steps.map(step => step.run || "").join("\n");
  assert.match(runs, /docker login ghcr\.io --username "\$GITHUB_ACTOR" --password-stdin/);
  assert.match(runs, /:main"/);
  assert.match(runs, /:sha-\$\{GITHUB_SHA::12\}"/);
  assert.match(runs, /:\$GITHUB_REF_NAME"/);
  assert.match(runs, /:latest"/);
  assert.equal(publish.steps.find(step => step.name === "Push main image").if, "${{ github.ref == 'refs/heads/main' }}");
  assert.equal(publish.steps.find(step => step.name === "Push release image").if, "${{ startsWith(github.ref, 'refs/tags/v') }}");
});

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
    assert.equal(job.if, "${{ always() && !cancelled() }}");
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

const iosFixture = fixture
  .replace("on: [pull_request, push]", "on:\n  pull_request: {branches: ['v2/**']}\n  push: {branches: ['v2/**']}")
  .replace("ubuntu-latest", "macos-15");
test("pinned macOS runner is allowed only in the dedicated v2 iOS workflow", () => {
  assert.deepEqual(validateWorkflow(iosFixture, "v2-ios.yml"), { jobs: 1, actions: 1 });
  for (const filename of ["", "ci.yml", "v2-rust.yml", "other-ios.yml", "v2-ios.yaml"])
    assert.throws(() => validateWorkflow(iosFixture, filename), /workflow_runner/, filename);
});
for (const runner of ["macos-latest", "macos-14", "macos-15-large", "self-hosted", "[self-hosted, macOS]", "${{ matrix.runner }}"])
  test(`dedicated iOS workflow rejects runner ${runner}`, () => {
    assert.throws(() => validateWorkflow(iosFixture.replace("macos-15", runner), "v2-ios.yml"), /workflow_runner/);
  });
for (const [name, before, after] of [
  ["main branch", "v2/**", "main"],
  ["unbounded branch", "v2/**", "**"],
  ["negated branch", "v2/**", "!v2/private"],
  ["tag trigger", "push: {branches: ['v2/**']}", "push: {branches: ['v2/**'], tags: ['v*']}"],
  ["missing branch filter", "{branches: ['v2/**']}", "{}"],
  ["manual trigger", "pull_request:", "workflow_dispatch:"],
  ["job write token", "runs-on: macos-15", "runs-on: macos-15\n    permissions: {contents: write}"],
  ["secret", "echo fixture", "echo '${{ secrets.TOKEN }}'"],
]) test(`dedicated iOS workflow rejects ${name}`, () => {
  assert.throws(() => validateWorkflow(iosFixture.replace(before, after), "v2-ios.yml"), /workflow_/);
});
