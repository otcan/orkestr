import assert from "node:assert/strict";
import test from "node:test";
import { validateSetupManifest } from "../packages/core/src/setups/setup-manifest.js";
import { fitnessTrackerManifest } from "../packages/core/src/setups/manifests/fitness-tracker.js";
import { getSetupManifest, listSetupManifests, setupManifestSummary } from "../packages/core/src/setups/setup-registry.js";

const clone = () => structuredClone(fitnessTrackerManifest);

test("the built-in fitness manifest is valid and listed", () => {
  assert.deepEqual(validateSetupManifest(fitnessTrackerManifest), { ok: true, problems: [] });
  assert.deepEqual(listSetupManifests().map((manifest) => manifest.id), ["fitness-tracker"]);
  const summary = setupManifestSummary(getSetupManifest("fitness-tracker"));
  assert.deepEqual(summary.providers, ["codex", "claude-code"]);
  assert.equal(summary.alwaysOn, true);
  assert.throws(() => getSetupManifest("nope"), /setup_not_found/);
});

test("least privilege: unused or missing permissions are rejected", () => {
  const extra = clone();
  extra.timers = [];
  assert.match(validateSetupManifest(extra).problems.join(), /timer\.create is requested but not used/);
  const missing = clone();
  missing.permissions = missing.permissions.filter((permission) => permission.id !== "state.write");
  assert.match(validateSetupManifest(missing).problems.join(), /missing state\.write/);
  const unknown = clone();
  unknown.permissions.push({ id: "gmail.read" });
  assert.match(validateSetupManifest(unknown).problems.join(), /unknown permission gmail\.read/);
});

test("WhatsApp can never be granted by install", () => {
  const manifest = clone();
  manifest.permissions.find((permission) => permission.id === "whatsapp.reply-owner").grantedByInstall = true;
  assert.match(validateSetupManifest(manifest).problems.join(), /grantedByInstall: false/);
});

test("requirements, timers, state migrations and uninstall policy are checked", () => {
  const manifest = clone();
  manifest.schema = "orkestr.setup/v0";
  manifest.requires.providers.anyOf = ["gemini"];
  manifest.requires.platform = {};
  manifest.timers[0].time = "25:00";
  manifest.timers[1].cadence = "hourly";
  manifest.state.migrations = [{ from: 1, to: 3 }];
  manifest.uninstall.thread = "delete";
  const problems = validateSetupManifest(manifest).problems.join("\n");
  for (const expected of [/schema/, /unknown provider gemini/, /alwaysOn/, /HH:MM/, /daily or weekly/, /N to N\+1/, /only retire/]) {
    assert.match(problems, expected);
  }
});
