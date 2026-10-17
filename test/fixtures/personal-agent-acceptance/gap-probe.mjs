import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceCheck, expectKnownGap } from "./harness.mjs";

if (process.env.OP22_REPORTER_PROBE) test("reporting fixture", async (t) => {
  if (process.env.OP22_REPORTER_PROBE === "cleanup") t.after(() => { throw new Error("fixture_cleanup_failed"); });
  await expectKnownGap(t, { id: "fixture", ops: ["OP-22"], reason: "reporter self-test" }, async () => {
    switch (process.env.OP22_REPORTER_PROBE) {
      case "known":
      case "cleanup": acceptanceCheck(false, "fixture", "expected fixture assertion"); break;
      case "wrong-case": acceptanceCheck(false, "another-case", "unexpected fixture assertion"); break;
      case "unrelated": assert.equal(1, 2, "ordinary regression"); break;
      case "error": throw new Error("fixture_setup_failed");
      case "pass": break;
      default: throw new Error("fixture_mode_required");
    }
  });
});
