import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverTestFiles } from "../scripts/ci-test-runner.mjs";
import { adr3Cases, adr3Source, adr3ProvisioningExpectations, adr3PluginLayers } from "./fixtures/personal-agent-acceptance/adr3-cases.mjs";

const expectedIds = ["AT-01", "AT-02", "AT-03", "AT-04", "AT-05", "AT-06", "AT-07", "AT-07a", "AT-07b", "AT-07c", "AT-08", "AT-09", "AT-10", "AT-11", "AT-12"];
const pending = fileURLToPath(new URL("./personal-agent-adr3-acceptance.test.js", import.meta.url));
const currentOwners = {
  "AT-01": ["OP-25"], "AT-02": ["OP-26"], "AT-03": ["OP-26"],
  "AT-04": ["OP-27", "OP-31"], "AT-05": ["OP-25"], "AT-06": ["OP-32"],
  "AT-07": ["OP-27"], "AT-07a": ["OP-27", "OP-30"], "AT-07b": ["OP-30"],
  "AT-07c": ["OP-30"], "AT-09": ["OP-25", "OP-26"], "AT-11": ["OP-28"],
};

function runInventory(strict) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", pending], {
    encoding: "utf8", timeout: 10_000,
    // No inherited credentials, overlays, provider endpoints or live home.
    env: { PATH: process.env.PATH || "", ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT: strict ? "1" : "0" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}

test("ADR3 inventory covers every AT including provisioning, inheritance and progressive onboarding", () => {
  const ledger = readFileSync(new URL("../docs/product/personal-agent-adr3-acceptance.md", import.meta.url), "utf8");
  const ledgerOps = new Map(ledger.split("\n").filter(line => line.startsWith("| AT-")).map(line => {
    const [, id, ops] = line.split("|").map(cell => cell.trim());
    return [id, ops.match(/OP-\d{2}/g) || []];
  }));
  assert.deepEqual(adr3Cases.map(item => item.id), expectedIds);
  assert.equal(new Set(adr3Cases.map(item => item.id)).size, expectedIds.length);
  assert.deepEqual(adr3Source.sections, [2, 3, 4, 5, 9, 10]);
  assert.equal(adr3Source.commit, "3a5c8c37");
  assert.deepEqual(adr3ProvisioningExpectations, {
    projectKinds: ["shopping-list", "software"],
    defaultResources: ["github_repo", "jira_project", "oxrm_workspace", "whatsapp_conversation"],
    trigger: "project_creation", desktopInstancesCreated: 0, provisioners: "fake_only",
  });
  assert.equal(adr3Cases.find(item => item.id === "AT-07a").expectations, adr3ProvisioningExpectations);
  assert.deepEqual(adr3PluginLayers, [
    "package", "connections", "capabilities", "global_or_selected_project_bindings", "resource_instances",
  ]);
  assert.equal(adr3Cases.find(item => item.id === "AT-07b").pluginLayers, adr3PluginLayers);
  for (const item of adr3Cases) {
    assert.ok(item.title.length > 8 && item.scenario.length > 90 && item.gap.length > 60, item.id);
    assert.ok(item.lanes.length && item.lanes.every(lane => ["ingress", "runtime", "ui"].includes(lane)), item.id);
    assert.ok(item.ops.includes("OP-22") && item.ops.every(op => /^OP-\d{2}$/.test(op)), item.id);
    assert.equal(new Set(item.ops).size, item.ops.length, `${item.id} duplicate OP reference`);
    for (const op of currentOwners[item.id] || []) assert.ok(item.ops.includes(op), `${item.id} missing ${op}`);
    assert.deepEqual(ledgerOps.get(item.id), item.ops, `${item.id} ledger/inventory OP drift`);
    assert.equal(item.assertions.length, 3, `${item.id} needs concrete success and adverse oracles`);
    assert.ok(item.assertions.every(text => text.length > 80), item.id);
    assert.ok(item.foundations.every(id => /^PA-[RG]\d{2}$/.test(id)), item.id);
  }
});

test("ADR3 normal mode reports 15 explicit pending integrations, not successful features or known reproduced gaps", () => {
  const result = runInventory(false);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /# tests 15\b/);
  assert.match(result.output, /# todo 15\b/);
  assert.match(result.output, /# pass 0\b/);
  assert.match(result.output, /# fail 0\b/);
  assert.doesNotMatch(result.output, /KNOWN_GAP|UNEXPECTED_PASS/);
  for (const id of expectedIds) assert.ok(result.output.includes(`PENDING_ACCEPTANCE ${id}:`), id);
});

test("ADR3 strict mode fails every pending integration with no TODO allowance", () => {
  const result = runInventory(true);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /# fail 15\b/);
  assert.match(result.output, /# todo 0\b/);
  for (const id of expectedIds) assert.ok(result.output.includes(`PENDING_ACCEPTANCE ${id}:`), id);
});

test("ADR3 files participate in the existing four-shard CI discovery", () => {
  const discovered = discoverTestFiles();
  for (const file of ["personal-agent-adr3-acceptance", "personal-agent-adr3-acceptance-harness"]) {
    assert.ok(discovered.includes(`test/${file}.test.js`));
  }
});
