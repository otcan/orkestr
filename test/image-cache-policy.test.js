import assert from "node:assert/strict";
import test from "node:test";
import { actionPins, validateWorkflow } from "../scripts/security/workflow-policy.mjs";

for (const name of ["docker/setup-buildx-action", "docker/build-push-action"]) {
  test(`${name} accepts only the reviewed immutable official commit`, () => {
    const fixture = `on: [pull_request]\npermissions: {contents: read}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${name}@${actionPins[name]}\n`;
    validateWorkflow(fixture);
    for (const invalid of ["v4", "a".repeat(40)]) {
      assert.throws(() => validateWorkflow(fixture.replace(actionPins[name], invalid)), /workflow_action_pin/);
    }
  });
}
