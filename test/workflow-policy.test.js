import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

test("all repository workflows satisfy policy and retain readable version annotations", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  assert.equal((await checkWorkflows(fileURLToPath(directory))).ok, true);
  const ci = await fs.readFile(new URL("ci.yml", directory), "utf8");
  for (const line of ci.split("\n").filter(line => /uses:/.test(line))) assert.match(line, /@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
  assert.match(ci, /run: npm run security:workflows/);
});
